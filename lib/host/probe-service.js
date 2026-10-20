/**
 * Remote provider probes: the poll loop, its cache, and its persistence.
 *
 * Balance and plan facts are slow, rate-limited and mostly static compared to
 * token usage, so they live on their own cadence and in their own file. This
 * service owns that cadence:
 *
 * - `refresh()` probes every route worth probing and folds the results into an
 *   in-memory snapshot.
 * - The snapshot is what the wire serves; it is never recomputed per request.
 * - Failures are per fact, and a failed probe **keeps the previous fact**
 *   rather than blanking the card. A stale balance is still useful; an empty
 *   one is not. The exception is a credential that went away: then the fact is
 *   cleared, because showing money for an account that is no longer configured
 *   would be a lie.
 *
 * Which routes are worth probing is the interesting decision. Probing all
 * seventeen known vendors would fill both tabs with "no credential
 * configured", so the rule is:
 *
 * - every route the ledger has actually seen (the user's own providers), plus
 * - every route whose credential resolves right now (someone configured it).
 *
 * Everything else stays in the catalog, which the UI mentions in one line
 * instead of rendering as rows.
 *
 * @module dsh-abacus/host/probe-service
 */

import { join } from 'node:path'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'

import {
  balanceAdapterFor,
  balanceAppliesToRoute,
  planAdapterFor,
  probeableRoutes,
  providerErrorMessage,
  PROBE_TIMEOUT_MS,
} from '../core/adapters.js'
import { providerDisplayName } from '../core/providers.js'
import { alertsOf, thresholdsOf } from '../core/alerts.js'
import { deepseekBaseUrl, piAiProfile, resolveCredential } from './credentials.js'

/** The document version written to disk. */
const DOCUMENT_VERSION = 1

/** How many routes are probed at once. */
const PROBE_CONCURRENCY = 4

/** Default time between refresh cycles. */
export const DEFAULT_PROBE_INTERVAL_SEC = 300

/**
 * Run tasks with a concurrency cap.
 * @param {Array<() => Promise<unknown>>} tasks - the tasks.
 * @param {number} limit - how many may run at once.
 * @returns {Promise<void>} resolves when all have settled.
 */
async function withConcurrency(tasks, limit) {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor
      cursor += 1
      await tasks[index]()
    }
  })
  await Promise.all(workers)
}

/**
 * Probe vendor balances and subscription windows.
 */
export class ProbeService {
  /**
   * @param {object} options - construction options.
   * @param {object} options.ctx - the plugin context (for credentials and config namespaces).
   * @param {string} options.stateDir - the plugin's state directory.
   * @param {() => string[]} [options.ledgerRoutes] - the routes the ledger has seen, read fresh each cycle.
   * @param {(message: string) => void} [options.log] - a logger.
   * @param {typeof fetch} [options.fetchImpl] - the fetch implementation, for tests.
   * @param {() => number} [options.now] - the clock, for tests.
   */
  constructor({ ctx, stateDir, ledgerRoutes, log, fetchImpl, now }) {
    this.ctx = ctx
    this.stateDir = stateDir
    this.ledgerRoutes = ledgerRoutes ?? (() => [])
    this.log = log ?? (() => {})
    this.fetch = fetchImpl ?? globalThis.fetch
    this.now = now ?? (() => Date.now())
    /** @type {Map<string, object>} route key → snapshot. */
    this.providers = new Map()
    this.updatedAt = 0
    this.probing = false
    this.intervalSec = DEFAULT_PROBE_INTERVAL_SEC
    this.pluginEnabled = true
    this.probeEnabled = true
    /**
     * The reminder thresholds, kept as the derived form rather than the config
     * itself: {@link ProbeService#alerts} is asked for reminders on every
     * overview poll, and re-deriving four numbers each time would be work done
     * per request to answer a question whose answer only changes on a save.
     */
    this.thresholds = thresholdsOf(undefined)
    this.timer = undefined
    this.disposed = false
    this.loadPromise = undefined
    this.loaded = false
    this.flushTimer = undefined
  }

  /** The state file. */
  get file() {
    return join(this.stateDir, 'providers.json')
  }

  /**
   * Apply configuration.
   *
   * Two independent switches: the plugin-wide `enabled`, and `probeEnabled`,
   * which lets someone keep local usage accounting while refusing to let the
   * plugin call vendor endpoints. Both must be on for a cycle to run.
   *
   * @param {{enabled?: boolean, probeEnabled?: boolean, probeIntervalSec?: number}} config - the plugin config.
   */
  configure(config) {
    if (typeof config?.enabled === 'boolean') this.pluginEnabled = config.enabled
    if (typeof config?.probeEnabled === 'boolean') this.probeEnabled = config.probeEnabled
    const interval = Number(config?.probeIntervalSec)
    if (Number.isFinite(interval) && interval > 0) this.intervalSec = interval
    this.thresholds = thresholdsOf(config)
  }

  /**
   * The reminders the user asked for: vendor facts currently below a threshold.
   *
   * Read from the same cached snapshots the two vendor tabs show, so a dot can
   * never contradict the number it sits next to. It is computed per call rather
   * than cached because the thresholds can change between two polls, and the
   * pass is a handful of comparisons over a handful of providers.
   *
   * @returns {object[]} the reminders, each naming its provider and fact.
   */
  alerts() {
    return alertsOf(this.providers.values(), this.thresholds)
  }

  /** Whether a cycle is currently permitted. */
  get enabled() {
    return this.pluginEnabled && this.probeEnabled
  }

  /**
   * Load the persisted snapshot and start the cycle.
   * @returns {Promise<void>} resolves once the snapshot is loaded.
   */
  start() {
    return this.loadPersisted().then(() => {
      if (this.disposed) return
      void this.refresh().finally(() => this.schedule())
    })
  }

  /** Stop the cycle and flush. */
  async stop() {
    this.disposed = true
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    await this.loadPromise?.catch(() => {})
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    await this.flush()
  }

  /** Arm the next refresh, replacing any pending one. */
  schedule() {
    if (this.disposed) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.refresh().finally(() => this.schedule())
    }, this.intervalSec * 1000)
    this.timer.unref?.()
  }

  /**
   * Probe everything worth probing.
   * @param {{force?: boolean}} [options] - `force` ignores the enable switch.
   * @returns {Promise<void>} resolves when the cycle is done.
   */
  async refresh(options = {}) {
    if (this.disposed && options.force !== true) return
    if (!this.enabled && options.force !== true) return
    if (this.probing) return
    this.probing = true
    try {
      await this.loadPersisted()
      const routes = await this.routesToProbe()
      const tasks = routes.map((route) => async () => {
        try {
          await this.probeRoute(route)
        } catch (error) {
          this.log(`probe ${route} failed: ${error?.message ?? error}`)
        }
      })
      await withConcurrency(tasks, PROBE_CONCURRENCY)
      this.updatedAt = this.now()
      this.scheduleFlush()
    } finally {
      this.probing = false
    }
  }

  /**
   * The routes this cycle should probe.
   * @returns {Promise<string[]>} route keys.
   */
  async routesToProbe() {
    const routes = new Set(this.ledgerRoutes())
    for (const route of probeableRoutes()) {
      if (routes.has(route)) continue
      const credential = await resolveCredential(this.ctx, route)
      if (credential.kind !== 'none') routes.add(route)
    }
    // Drop routes that are neither probeable nor interesting.
    return [...routes].filter(
      (route) => balanceAdapterFor(route) !== undefined || planAdapterFor(route) !== undefined,
    )
  }

  /**
   * Probe one route, folding the outcome into its snapshot.
   * @param {string} route - the route key.
   * @returns {Promise<void>} resolves when done.
   */
  async probeRoute(route) {
    const previous = this.providers.get(route)
    const credential = await resolveCredential(this.ctx, route)
    const balanceAdapter = balanceAdapterFor(route)
    const planAdapter = planAdapterFor(route)
    const baseUrl = balanceAdapter === undefined ? undefined : this.routeBaseUrl(route)

    const snapshot = {
      provider: route,
      displayName: providerDisplayName(route),
      credential: credential.kind,
      credentialSource: credential.source,
      balanceSupported: balanceAdapter !== undefined && balanceAppliesToRoute(balanceAdapter, baseUrl),
      planSupported: planAdapter !== undefined,
    }

    if (credential.kind === 'none') {
      // No credential: the fact cannot be re-verified, so it must not be shown.
      snapshot.balanceError = 'no-credential'
      snapshot.planError = planAdapter === undefined ? 'unsupported' : 'no-credential'
      snapshot.updatedAt = this.now()
      this.providers.set(route, snapshot)
      return
    }

    if (snapshot.balanceSupported) {
      await this.probeFact(snapshot, 'balance', balanceAdapter, credential, previous, () => {
        // A balance endpoint does not accept an OAuth session token.
        if (credential.kind === 'oauth') return 'oauth-credential'
        return undefined
      })
    } else if (balanceAdapter !== undefined) {
      snapshot.balanceError = 'origin-mismatch'
    } else {
      snapshot.balanceError = 'unsupported'
    }

    if (planAdapter !== undefined) {
      await this.probeFact(snapshot, 'plan', planAdapter, credential, previous)
    } else {
      snapshot.planError = 'unsupported'
    }

    snapshot.updatedAt = this.now()
    this.providers.set(route, snapshot)
  }

  /**
   * Run one fact probe and record its outcome.
   * @param {object} snapshot - the snapshot being built.
   * @param {'balance'|'plan'} fact - which fact.
   * @param {object} adapter - the adapter.
   * @param {object} credential - the resolved credential.
   * @param {object|undefined} previous - the previous snapshot.
   * @param {() => string|undefined} [precheck] - a local reason to skip the call.
   * @returns {Promise<void>} resolves when done.
   */
  async probeFact(snapshot, fact, adapter, credential, previous, precheck) {
    const errorField = `${fact}Error`
    const local = precheck?.()
    if (local !== undefined) {
      snapshot[errorField] = local
      return
    }
    try {
      const body = await this.call(adapter, credential)
      const parsed = adapter.parse(body)
      if (parsed === null) throw new Error('unrecognized response shape')
      snapshot[fact] = { ...parsed, updatedAt: this.now() }
    } catch (error) {
      snapshot[errorField] = error?.message ?? String(error)
      const retained = previous?.[fact]
      if (retained !== undefined) snapshot[fact] = retained
    }
  }

  /**
   * Call one provider endpoint.
   * @param {object} adapter - the adapter.
   * @param {object} credential - the resolved credential.
   * @returns {Promise<unknown>} the decoded body.
   */
  async call(adapter, credential) {
    const response = await this.fetch(adapter.url, {
      method: 'GET',
      headers: adapter.headers(credential),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    const body = await response.json().catch(() => undefined)
    if (!response.ok) throw new Error(providerErrorMessage(response.status, body))
    return body
  }

  /**
   * The configured base URL for a route, when it has one.
   * @param {string} route - the route key.
   * @returns {string|undefined} the base URL.
   */
  routeBaseUrl(route) {
    const fromProfile = piAiProfile(this.ctx, route).baseURL
    if (typeof fromProfile === 'string' && fromProfile !== '') return fromProfile
    return deepseekBaseUrl(this.ctx)
  }

  /** The wire shape. */
  view() {
    const providers = [...this.providers.values()].sort((a, b) =>
      a.displayName.localeCompare(b.displayName, 'zh-Hans-CN'),
    )
    return {
      updatedAt: this.updatedAt,
      probing: this.probing,
      intervalSec: this.intervalSec,
      providers,
      // The reminder list rides with the facts it judges, so the two vendor tabs
      // can mark a row without a second request or a second source of truth.
      alerts: this.alerts(),
      catalog: {
        probeable: probeableRoutes(),
      },
    }
  }

  /** Load the persisted snapshot once. */
  loadPersisted() {
    if (this.loadPromise === undefined) this.loadPromise = this.readPersisted()
    return this.loadPromise
  }

  /** Read the state file into memory. */
  async readPersisted() {
    let parsed
    try {
      parsed = JSON.parse(await readFile(this.file, 'utf8'))
    } catch {
      this.loaded = true
      return
    }
    const providers = parsed?.providers
    if (providers === null || typeof providers !== 'object') {
      this.loaded = true
      return
    }
    for (const [route, snapshot] of Object.entries(providers)) {
      if (snapshot === null || typeof snapshot !== 'object') continue
      this.providers.set(route, snapshot)
    }
    if (Number.isFinite(parsed?.updatedAt)) this.updatedAt = parsed.updatedAt
    this.loaded = true
  }

  /** Queue a debounced write. */
  scheduleFlush() {
    if (this.flushTimer !== undefined) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flush()
    }, 3000)
    this.flushTimer.unref?.()
  }

  /** Write the snapshot to disk. */
  async flush() {
    const document = JSON.stringify({
      version: DOCUMENT_VERSION,
      updatedAt: this.updatedAt,
      providers: Object.fromEntries(this.providers),
    })
    const temporary = `${this.file}.tmp`
    try {
      await writeFile(temporary, document, 'utf8')
      await rename(temporary, this.file)
    } catch (error) {
      this.log(`could not persist provider snapshots: ${error?.message ?? error}`)
      await unlink(temporary).catch(() => {})
    }
  }
}
