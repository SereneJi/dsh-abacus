/**
 * The host service: it folds live session usage into the persisted document,
 * keeps the per-session replacement slots the fold needs, answers the JSON
 * documents the browser polls, and owns the plugin's configuration.
 *
 * Design notes worth keeping in mind when editing this file:
 *
 * - **One subscription.** Everything this plugin knows comes from
 *   `ctx.on('session/event')`. There is no polling of the runtime and no
 *   filesystem scraping, so a call is recorded exactly once, as it settles.
 * - **The replacement slot is per session and persisted.** See
 *   `core/document.js` for why a repeated `(turn, step)` replaces rather than
 *   adds. The slot has to survive a Host restart, because a retry can settle
 *   after one.
 * - **Writes are atomic and debounced.** The document is small but rewritten
 *   whole; a temp file plus `rename` means a crash mid-write can never leave a
 *   truncated ledger, and a 3 s debounce means a long turn writes once.
 * - **Every route reads the live document.** Nothing is cached across
 *   requests, so a fold that lands between two polls is visible in the next
 *   one.
 *
 * @module dsh-abacus/host/usage-service
 */

import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHome } from '../dsh-home.js'
import { addTotals, emptyTotals, totalTokens } from '../core/totals.js'
import {
  applySample,
  createDocument,
  deserializeDocument,
  hasHourBuckets,
  hoursOfDay,
  ledgerDayKeys,
  localDateKey,
  mergeBucketMap,
  pruneDocument,
  summarizeBuckets,
} from '../core/document.js'
import { isEmptySample, retryBoundaryOf, sampleFromEvent } from '../core/samples.js'
import { providerDisplayName, resolveDisplayName } from '../core/providers.js'
import { BUILTIN_PRICES, costOfHourBuckets, normalizePrices, priceTable } from '../core/pricing.js'
import { Upstream } from './upstream.js'
import { DEFAULT_CONFIG, normalizeConfig, patchConfig } from './config.js'
import { readSessionLog, sessionLogPaths, settlementKeyOf, withoutReplays } from './history.js'
import { pluginVersion } from './version.js'

/** Ledger flush debounce: a long turn writes once, not once per step. */
const FLUSH_DEBOUNCE_MS = 3_000

/**
 * Cap on the in-memory session→route fallback cache. Matches the document's
 * own session cap so the two bounded structures stay in step.
 */
const SESSION_ROUTE_CAP = 400

/**
 * The ledger key for one hour of one local date.
 * @param {string} dateKey - a local-date key, `YYYY-MM-DD`.
 * @param {number} hour - the hour of the day, 0-23.
 * @returns {string} the hour key, `YYYY-MM-DDTHH`.
 */
function hourKeyOf(dateKey, hour) {
  return `${dateKey}T${String(hour).padStart(2, '0')}`
}

/**
 * Read a service off the host context without depending on its package.
 * Optional collaborators (the LLM runtime) are looked up structurally so this
 * plugin stays installable on its own.
 * @param {object} ctx - the host context.
 * @param {string} name - the service name.
 * @returns {any} the service, or undefined when it is not mounted.
 */
function optionalService(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name, false) : undefined
  } catch {
    return undefined
  }
}

/**
 * The state directory this plugin used before it was renamed (`dsh-abacus`,
 * 2.0.0). Kept as a literal rather than a variable: it names a directory the
 * current build must never write to again.
 */
const LEGACY_DIR_NAME = 'usage-stat'

/**
 * Adopt the state the pre-rename release left behind.
 *
 * Up to 1.1.0 this plugin was named `dsh-usage-stat` and kept its ledger in
 * `$DSH_HOME/usage-stat`. A rename must not read like a fresh install, so the
 * first boot under the new name copies that directory across and leaves the
 * original in place as a backup. An existing directory under the new name wins
 * outright: merging two ledgers by guesswork is worse than ignoring a stale
 * one, and the ledger can always be rebuilt from the session logs.
 *
 * Synchronous on purpose — the caller needs the files in place before
 * `Upstream` loads its cache in the very next constructor statement.
 * @param {string} dir - the state directory this release will use.
 * @returns {boolean} true when a legacy directory was adopted on this boot.
 */
function adoptLegacyState(dir) {
  const legacy = join(dirname(dir), LEGACY_DIR_NAME)
  if (existsSync(dir)) return false
  /** @type {string[]} */
  let entries
  try {
    entries = readdirSync(legacy)
  } catch {
    return false
  }
  if (entries.length === 0) return false
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    try {
      cpSync(join(legacy, entry), join(dir, entry), { recursive: true, force: false })
    } catch {
      // One unreadable file must not stop the plugin from starting. Whatever
      // lands is still better than nothing, and the rest rebuilds from logs.
    }
  }
  return true
}

export class UsageService {
  /**
   * @param {object} ctx - the host context.
   * @param {import('../core/types.js').UsageConfig} [config] - the starting config.
   * @param {{alerts?: () => object[]}} [options] - the reminder source.
   */
  constructor(ctx, config, options = {}) {
    this.ctx = ctx
    /** Persisted state lives beside the other DSH plugin state. */
    this.dir = join(dshHome(), 'abacus')
    /**
     * True on the single boot that copied `$DSH_HOME/usage-stat` across. Kept
     * for tests and for the debug log; nothing downstream branches on it.
     */
    this.adoptedLegacyState = adoptLegacyState(this.dir)
    this.documentPath = join(this.dir, 'usage.json')
    this.configPath = join(this.dir, 'config.json')
    /**
     * The published price list and holiday calendar, fetched on a schedule and
     * cached here. Optional by design: with nothing cached the built-in tables
     * stand, so an offline machine bills exactly as before.
     */
    this.upstream = new Upstream({
      file: join(this.dir, 'upstream.json'),
      // A fetch that failed or a page that no longer parses is worth saying out
      // loud while developing, and worth saying nothing about in normal use.
      log: (message) => {
        if (process.env.DSH_ABACUS_DEBUG === '1') console.warn(`[abacus] ${message}`)
      },
    }).load()
    /** DSH's own session logs, replayed once so the ledger has a past. */
    this.sessionsDir = options.sessionsDir ?? join(dshHome(), 'sessions')
    /** Guards against two replays running at once (startup plus a manual one). */
    this.backfilling = undefined
    /** @type {Array<[object, object]>} settlements that arrived while a scan ran. */
    this.deferred = []

    /** @type {object} the usage document (days + sessions + samples). */
    this.doc = createDocument()
    /**
     * True when the caller passed a config in (a patch layer or a test). Such
     * a value outranks the persisted file; the shipped defaults do not, or a
     * saved setting could never take effect after a restart.
     */
    this.configExplicit = config !== undefined
    /**
     * The caller's raw patch, kept verbatim so the persisted file can be
     * overlaid field by field later. Reusing `this.config` instead would apply
     * the *normalized* object, whose defaults for unnamed fields would wipe
     * every other saved setting.
     */
    this.configPatch = config
    /** @type {import('../core/types.js').UsageConfig} */
    this.config = normalizeConfig(config)

    /** Session id → the route its most recent request ran on (fallback attribution). */
    this.sessionRoutes = new Map()
    /** The newest route seen this boot; the settings header follows it. */
    this.current = { source: 'default' }
    /**
     * Where the low-quota reminders come from.
     *
     * The ledger does not know what a vendor account holds — that is the probe
     * service's business — so the reminders arrive as a callback instead of a
     * dependency. They belong in the overview anyway: the sidebar dot and the
     * number it warns about must come from the same poll, or the card can show a
     * dot next to a total from a different tick.
     */
    this.alertsProvider = options.alerts ?? (() => [])

    this.sessionListenerDisposer = undefined
    this.flushTimer = undefined
    /** Serialized flushes: overlapping debounce/stop flushes queue, never interleave. */
    this.flushChain = Promise.resolve()
    /**
     * The in-flight initial load, or undefined before one starts. Every write
     * waits on it, so a shutdown that arrives immediately after start can
     * never skip the flush (which would silently drop the turn that was
     * running), and every reader shares one load instead of merging the same
     * file twice.
     */
    this.loadPromise = undefined
    /** True once loadPersisted finished; nothing may overwrite the file before that. */
    this.loaded = false
    this.disposed = false
    /** Last prune guard: once per local day, and whenever retention shrinks. */
    this.lastPrune = undefined
  }

  // ------------------------------------------------------------------
  // Lifecycle
  // ------------------------------------------------------------------

  /**
   * Load persisted state and start folding live session events.
   *
   * Events that arrive before the load lands are deferred and replayed rather
   * than folded blind (see `onSessionEvent`), so callers that want the baseline
   * in place before emitting can await this.
   * @returns {Promise<void>} resolves once the persisted ledger is merged.
   */
  start() {
    this.sessionListenerDisposer = this.ctx.on('session/event', (session, event) => {
      this.onSessionEvent(session, event)
    })
    return this.loadPersisted().then(() => {
      // The past is filled in behind the live fold, never in front of it: the
      // replay only touches events the ledger has not seen, so the two cannot
      // fight, and nothing the user is looking at waits on a disk scan.
      void this.backfill()
      // The published tables are refreshed behind everything else too: the
      // cached ones answer immediately, and a stale price only matters the next
      // time a cost is read.
      void this.upstream.refresh()
    })
  }

  /**
   * Replay DSH's own session logs into the ledger, once.
   *
   * The plugin can only record what it was running to see, so a fresh install
   * shows nothing before today even though DSH has the whole history on disk.
   * Those logs hold the same `assistant/message` events, so they go through the
   * same fold — and its `seq` replay guard — rather than through a second,
   * weaker interpretation of the data. Replaying twice is therefore harmless,
   * which is what makes the bookmark an optimization rather than a correctness
   * requirement.
   *
   * `force` re-runs it, for the case the bookmark cannot cover: the plugin was
   * switched off for a while, so calls happened that no replay has seen.
   *
   * A scan already under way is shared rather than refused: a second caller
   * asking for the same work should get its answer, not a shrug.
   * @param {{ force?: boolean }} [options] - `force` ignores the bookmark.
   * @returns {Promise<{ files: number, events: number, skipped: boolean, error?: string }>} the tally.
   */
  async backfill(options = {}) {
    const force = options.force === true
    if (!this.config.enabled) return { files: 0, events: 0, skipped: true }
    if (this.backfilling !== undefined) return this.backfilling
    // A ledger that already carries all three bookmarks has been scanned, hour-
    // rebuilt and checked for whole-session copies, so there is nothing left to
    // walk the logs for. A ledger missing the third one predates that check and
    // gets one more scan to find out whether it needs rebuilding.
    if (
      !force &&
      this.doc.history !== undefined &&
      this.doc.hoursBuiltAt !== undefined &&
      this.doc.replayGuardAt !== undefined
    ) {
      return { files: 0, events: 0, skipped: true }
    }
    this.backfilling = this.scanLogs()
    try {
      return await this.backfilling
    } finally {
      this.backfilling = undefined
      this.drainDeferred()
    }
  }

  /**
   * Fold whatever arrived while a scan held the ledger.
   *
   * `backfilling` is cleared first: folding re-enters `onSessionEvent`, and an
   * event that arrives during the drain must fold rather than queue behind a
   * scan that has already finished.
   */
  drainDeferred() {
    const queued = this.deferred
    this.deferred = []
    for (const [session, event] of queued) this.onSessionEvent(session, event)
  }

  /**
   * Walk the session logs and fold them. The body of `backfill`, split out so
   * that the in-flight promise is what callers share.
   * @returns {Promise<{ files: number, events: number, skipped: boolean, error?: string }>} the tally.
   */
  async scanLogs() {
    try {
      const paths = await sessionLogPaths(this.sessionsDir)
      /** @type {Array<{ sessionId: string, events: object[] }>} */
      const read = []
      for (const path of paths) {
        const log = await readSessionLog(path)
        if (log.sessionId === '' || log.events.length === 0) continue
        read.push(log)
      }
      // A log that only repeats another session's calls is dropped before it is
      // folded: DSH writes one when a side conversation is opened, and because
      // the replay guard is keyed on the session id, folding it would count the
      // parent's calls a second time. See `withoutReplays`.
      const { kept, replays } = withoutReplays(read)
      // A ledger written before that check existed already holds the copies, and
      // a day bucket cannot be told which of its calls were copies after the
      // fact, so such a ledger is rebuilt from the logs instead. The logs are the
      // source of truth, and every settlement in them is folded exactly once.
      if (replays.length > 0 && this.doc.replayGuardAt === undefined) {
        this.doc.days = {}
        this.doc.hours = {}
        this.doc.sessions = {}
        this.doc.samples = {}
        this.doc.hoursBuiltAt = undefined
      }
      // A ledger written before the hour buckets existed has days but no hours,
      // and the day buckets cannot say what time of day a call happened. The
      // logs can: they carry each event's own timestamp, which is what the hour
      // key is made of. So the first scan on such a ledger also rebuilds the
      // hour map from scratch — reading every log without the replay guard,
      // because there is nothing in an empty map for it to double.
      const buildingHours = this.doc.hoursBuiltAt === undefined
      if (buildingHours) this.doc.hours = {}
      /** @type {Map<string, import('../core/samples.js').Sample>} */
      const hourSlots = new Map()
      let files = 0
      let events = 0
      // A settlement is folded once per scan, whichever log wrote it down.
      // Dropping whole copies (above) catches a log that repeats another session
      // and nothing else; this catches the rest — a log that repeats a parent's
      // first half and then makes calls of its own, or one that repeats a parent
      // entirely and adds to it. Without it the copied share would be folded a
      // second time, and the replay guard cannot see that: the guard is keyed on
      // the session id, and the copy has its own.
      const folded = new Set()
      for (const log of kept) {
        const { sessionId, events: list } = log
        files += 1
        for (const event of list) {
          // Without a sequence number an event cannot be told apart from one
          // the live fold already counted, and double-counting is worse than a
          // gap: a missing number is a gap the user never notices.
          if (typeof event.seq !== 'number' || !Number.isFinite(event.seq)) continue
          // Only an id can say "this is the same call written down twice": the
          // timestamp-and-coordinates fallback collides between two sessions that
          // happened to settle at the same instant, so it is left to whole-log
          // copy detection and never used to drop a single event.
          const key = settlementKeyOf(event)
          if (key.startsWith('id:')) {
            if (folded.has(key)) continue
            folded.add(key)
          }
          events += 1
          // Whether the replay guard is about to skip this event decides who
          // folds it into the hour map: the guard lets `onSessionEvent` write
          // both maps, and a skipped event has to be folded hour-only instead.
          // Doing both would count it twice.
          const row = this.doc.sessions[sessionId]
          const alreadyCounted = typeof row?.lastSeq === 'number' && event.seq <= row.lastSeq
          this.onSessionEvent({ id: sessionId }, event)
          if (buildingHours && alreadyCounted) this.foldHourOnly(hourSlots, sessionId, event)
        }
      }
      if (buildingHours) this.doc.hoursBuiltAt = Date.now()
      // Set on every scan, not only when a copy turned up: it means "the logs
      // have been checked for copies as of here", and that is what keeps a later
      // start from walking every log again.
      this.doc.replayGuardAt = Date.now()
      this.doc.history = { atMs: Date.now(), files, events }
      await this.flushDocument()
      return { files, events, skipped: false }
    } catch (error) {
      if (process.env.DSH_ABACUS_DEBUG === '1') throw error
      return { files: 0, events: 0, skipped: true, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /**
   * Fold one replayed event into the hour map alone, during the hour rebuild.
   *
   * Only events the replay guard skipped reach this method — everything else was
   * folded into both maps by `onSessionEvent`. The hour map is being built from
   * nothing, so its replacement slot is local and never persisted, and the day
   * and session maps are left untouched: they already hold this history, and
   * folding it again would double it.
   * @param {Map<string, import('../core/samples.js').Sample>} slots - the per-session replacement slots of this rebuild.
   * @param {string} sessionId - the session the event belongs to.
   * @param {object} event - the session event to fold.
   * @returns {void}
   */
  foldHourOnly(slots, sessionId, event) {
    // The route has to be re-learned here: the guard returned before
    // `onSessionEvent` could read it, and an event that names no route of its
    // own would otherwise be folded under an empty provider.
    if (event?.type === 'request/header') {
      this.rememberRoute(sessionId, event.data?.header?.config)
      return
    }
    if (event?.type === 'request/context') {
      this.rememberRoute(sessionId, event.data)
      return
    }
    const boundary = retryBoundaryOf(event)
    if (boundary !== undefined) {
      const previous = slots.get(sessionId)
      if (previous !== undefined && previous.turn === boundary.turn && previous.step === boundary.step) {
        slots.delete(sessionId)
      }
      return
    }
    const sample = sampleFromEvent(event, this.sessionRoutes.get(sessionId), Date.now(), sessionId)
    if (sample === undefined || isEmptySample(sample)) return
    const slot = slots.get(sessionId)
    const previous = slot !== undefined && slot.turn === sample.turn && slot.step === sample.step ? slot : undefined
    applySample(this.doc, sample, previous, { days: false, hours: true, sessions: false })
    slots.set(sessionId, sample)
  }

  /**
   * Stop folding and flush the pending write. The returned promise resolves
   * once the flush lands, so a successor instance can serialize its own load
   * behind it.
   * @returns {Promise<void>} resolves after the final write.
   */
  async stop() {
    this.disposed = true
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer)
      this.flushTimer = undefined
    }
    try {
      this.sessionListenerDisposer?.()
    } catch {
      // The session fiber is already gone during shutdown.
    }
    this.sessionListenerDisposer = undefined
    await this.flushDocument()
  }

  // ------------------------------------------------------------------
  // Configuration
  // ------------------------------------------------------------------

  /** The live configuration. */
  getConfig() {
    return { ...this.config }
  }

  /**
   * Apply a partial configuration update and persist it.
   * @param {unknown} patch - the untrusted partial update.
   * @returns {import('../core/types.js').UsageConfig} the config after the update.
   */
  async updateConfig(patch) {
    this.config = patchConfig(this.config, patch)
    await this.persistConfig()
    return this.getConfig()
  }

  // ------------------------------------------------------------------
  // Views
  // ------------------------------------------------------------------

  /**
   * Today's per-provider, per-model detail.
   * @param {string} dateKey - the local-date key.
   * @returns {import('../core/types.js').DayView} the day view.
   */
  day(dateKey) {
    const summary = summarizeBuckets([this.doc.days[dateKey] ?? {}])
    return {
      date: dateKey,
      totals: summary.totals,
      providers: summary.providers.map((row) => ({ ...row, displayName: providerDisplayName(row.provider) })),
    }
  }

  /**
   * One conversation's totals and its own per-provider, per-model breakdown,
   * as the composer badge and its click-open panel render them.
   * @param {string} sessionId - the session id.
   * @returns {import('../core/types.js').SessionUsageView} the session view.
   */
  session(sessionId) {
    const row = this.doc.sessions[sessionId]
    if (row === undefined) {
      return { sessionId, totals: emptyTotals(), updatedAt: 0, providers: [] }
    }
    // A session row written before this breakdown existed has totals but no
    // `providers` map. The panel then shows the total alone rather than
    // inventing an attribution it never recorded.
    const summary = summarizeBuckets([row.providers ?? {}])
    return {
      sessionId,
      totals: { ...row.totals },
      updatedAt: row.updatedAt ?? 0,
      providers: summary.providers.map((entry) => ({ ...entry, displayName: providerDisplayName(entry.provider) })),
      ...(row.provider !== undefined ? { provider: row.provider } : {}),
      ...(row.model !== undefined ? { model: row.model } : {}),
    }
  }

  /**
   * The document the browser polls. Assembled fresh on every call so a fold
   * that landed since the last poll is visible immediately.
   *
   * Deliberately small: only what every surface needs on every tick (the live
   * route, the provider roster, today, and the list of days that hold data).
   * A window aggregate is not here — it depends on what the user selected, so
   * it belongs to {@link UsageService#rangeView} and its own route.
   * @returns {import('../core/types.js').UsageOverviewView} the overview.
   */
  overview() {
    const todayKey = localDateKey(Date.now())
    const availableDays = ledgerDayKeys(this.doc)
    return {
      updatedAt: Date.now(),
      // Which build is live. The client cannot read the manifest, and after an
      // upgrade "did the new one load" is otherwise unanswerable from the UI.
      version: pluginVersion(),
      config: this.getConfig(),
      // The rows a model gets when the user has not priced it. Sent so the price
      // editor can name them instead of the client keeping a second copy of the
      // table that could drift from this one.
      builtinPrices: normalizePrices(this.upstream.effectivePrices()),
      current: this.currentView(todayKey),
      providers: this.listProviders(todayKey),
      usage: {
        today: this.day(todayKey),
        availableDays,
      },
      // The low-quota reminders, so the sidebar card can mark the provider row
      // on the same tick it draws the row.
      alerts: this.alerts(),
      // When the session logs were last replayed, so the settings tab can say
      // whether the history behind these numbers is complete.
      history: this.doc.history ?? null,
    }
  }

  /**
   * The reminders to show, or an empty list.
   *
   * A reminder source that throws must not take the overview down with it: the
   * usage numbers are the product, and a broken dot is not worth a blank card.
   * @returns {object[]} the reminders.
   */
  alerts() {
    try {
      return this.alertsProvider() ?? []
    } catch {
      return []
    }
  }

  /**
   * A caller-chosen window, aggregated per provider and per day.
   *
   * Inclusive at both ends and read straight off the retained ledger, so any
   * range the settings picker can express costs one cheap pass: no per-range
   * caching, and no second source of truth to keep in step with the fold.
   * @param {string} fromKey - the first local-date key, inclusive; `''` means the earliest retained day.
   * @param {string} toKey - the last local-date key, inclusive; `''` means the latest retained day.
   * @returns {import('../core/types.js').RangeView} the range view.
   */
  rangeView(fromKey, toKey) {
    const allKeys = ledgerDayKeys(this.doc)
    const fallback = localDateKey(Date.now())
    const from = fromKey === '' ? (allKeys[0] ?? fallback) : fromKey
    const to = toKey === '' ? (allKeys[allKeys.length - 1] ?? from) : toKey
    const keys = allKeys.filter((key) => key >= from && key <= to)
    const summary = summarizeBuckets(keys.map((key) => this.doc.days[key] ?? {}))
    // A window of exactly one day is the only one that can be charted across
    // the clock, so it is the only one that carries the hour breakdown. Sending
    // it for a seven-day window would be a kilobyte of data no chart can use.
    const single = from === to ? this.hourView(from) : undefined
    return {
      from,
      to,
      totals: summary.totals,
      providers: summary.providers.map((row) => ({ ...row, displayName: providerDisplayName(row.provider) })),
      // Each day carries its own money as well as its own tokens, so the cost tab
      // can draw one bar per day the way the usage tab does. Per day rather than
      // "window total ÷ days" because a day can hold a price change or a peak
      // window of its own.
      days: keys.map((date) => ({ date, totals: this.day(date).totals, cost: this.costOf([date]) })),
      // What those tokens would cost at the current price table. Money is
      // recomputed on every read rather than stored, so editing a price corrects
      // the figure for calls that already happened.
      cost: this.costOf(keys),
      ...(single !== undefined ? { hours: single } : {}),
    }
  }

  /**
   * Convert a set of days into money, hour by hour.
   *
   * Per hour rather than per day, because DeepSeek charges twice as much inside a
   * peak window and only the hour key remembers when a call happened. A day with
   * no hour buckets — a file written before the hour map existed, whose session
   * log is long gone — is billed flat instead of being dropped, so money is never
   * silently missing from a total.
   * @param {string[]} keys - the local-date keys to convert.
   * @returns {object} the cost breakdown, in the shape {@link costOfHourBuckets} returns.
   */
  costOf(keys) {
    const table = priceTable(this.config.prices, this.upstream.effectivePrices())
    /** @type {Array<{ key: string, buckets: object }>} */
    const entries = []
    for (const key of keys) {
      const rows = hoursOfDay(this.doc, key)
      if (rows.length === 0) {
        entries.push({ key: '', buckets: this.doc.days[key] ?? {} })
        continue
      }
      for (const row of rows) entries.push({ key: hourKeyOf(key, row.hour), buckets: row.buckets })
    }
    return costOfHourBuckets(entries, table, { holidays: this.upstream.effectiveHolidays() })
  }

  /**
   * One day's usage broken down by clock hour.
   *
   * Only hours that recorded something appear: a gap is drawn as a gap, never
   * as a zero, because "nothing was recorded" and "nothing was spent" are
   * different statements and the chart must not merge them.
   *
   * `available` says whether this ledger has hour resolution at all. A file
   * written before hours existed has none, and a day whose session log is long
   * gone keeps its daily totals without ever gaining hours, so the client has to
   * be able to tell the two silences apart instead of printing one message for
   * both.
   * @param {string} dateKey - the local-date key.
   * @returns {import('../core/types.js').HourView} the hour view.
   */
  hourView(dateKey) {
    const table = priceTable(this.config.prices, this.upstream.effectivePrices())
    // The same holiday calendar the day total uses: an hour inside a peak window
    // on a public holiday is off-peak, and a bar that disagreed with the total
    // above it would be a wrong number rather than a rounding difference.
    const holidays = this.upstream.effectiveHolidays()
    const rows = hoursOfDay(this.doc, dateKey)
    return {
      date: dateKey,
      available: hasHourBuckets(this.doc),
      // The day's own conversion, and one per hour. Both are carried because the
      // cost tab lets the user narrow to a provider or a single model, and that
      // narrowing is a read of this tree rather than a second request. The day's
      // is taken from `costOf` so it is the same money the range reports.
      cost: this.costOf([dateKey]),
      hours: rows.map((row) => ({
        hour: row.hour,
        totals: summarizeBuckets([row.buckets]).totals,
        cost: costOfHourBuckets(
          [{ key: hourKeyOf(dateKey, row.hour), buckets: row.buckets }],
          table,
          { holidays },
        ),
      })),
    }
  }

  /**
   * The route the settings header names: the newest call seen this boot, else
   * the heaviest provider of the newest recorded day, else nothing.
   * @param {string} todayKey - today's local-date key.
   * @returns {import('../core/types.js').CurrentRoute} the current route.
   */
  currentView(todayKey) {
    const route = this.current.provider !== undefined
      ? this.current
      : this.newestLedgerRoute()
    if (route.provider === undefined) return { source: 'default' }
    const day = this.doc.days[todayKey]
    const providerTotals = day?.[route.provider]
    let today
    if (providerTotals !== undefined) {
      today = emptyTotals()
      for (const totals of Object.values(providerTotals)) addTotals(today, totals)
    }
    return {
      provider: route.provider,
      ...(route.model !== undefined && route.model !== '' ? { model: route.model } : {}),
      displayName: providerDisplayName(route.provider),
      source: route.source,
      ...(today !== undefined ? { today } : {}),
    }
  }

  /** The heaviest provider of the newest recorded day, as a last-resort current route. */
  newestLedgerRoute() {
    const keys = ledgerDayKeys(this.doc)
    const last = keys[keys.length - 1]
    if (last === undefined) return { source: 'default' }
    const summary = summarizeBuckets([this.doc.days[last] ?? {}])
    const top = summary.providers[0]
    if (top === undefined) return { source: 'default' }
    return { provider: top.provider, model: top.models[0]?.model, source: 'ledger' }
  }

  /**
   * Every provider route the ledger has ever recorded.
   *
   * This is the "my providers" set: routes the user has actually spent tokens
   * through, whether or not they are still configured. The vendor probe uses it
   * to decide which accounts are worth asking about, so an unconfigured route
   * that was never used costs no network call.
   *
   * @returns {string[]} route keys, sorted.
   */
  knownRoutes() {
    const routes = new Set()
    for (const key of ledgerDayKeys(this.doc)) {
      for (const provider of Object.keys(this.doc.days[key])) routes.add(provider)
    }
    for (const row of Object.values(this.doc.sessions)) {
      if (typeof row?.provider === 'string' && row.provider !== '') routes.add(row.provider)
    }
    return [...routes].sort()
  }

  /**
   * Every provider worth listing.
   *
   * The LLM runtime exposes a catalog of roughly forty configurable routes, of
   * which the user has configured a handful. Shipping the whole catalog in
   * every overview poll would be mostly noise, so by default a route is listed
   * only when the runtime is actually serving it (`live`) or when the ledger
   * has recorded usage for it — a route that has since been unconfigured keeps
   * showing its history. Pass `includeDormant` to get the raw catalog, which is
   * what a future balance view needs in order to say "no credential
   * configured" for a route that was never used.
   *
   * @param {string} todayKey - today's local-date key.
   * @param {{ includeDormant?: boolean }} [options] - catalog options.
   * @returns {import('../core/types.js').ProviderInfo[]} the provider list.
   */
  listProviders(todayKey, options = {}) {
    const includeDormant = options.includeDormant === true
    /** @type {Map<string, { id: string, displayName: string, live: boolean }>} */
    const rows = new Map()
    /** Routes the ledger has ever recorded, regardless of configuration. */
    const recorded = new Set()
    for (const key of ledgerDayKeys(this.doc)) {
      for (const provider of Object.keys(this.doc.days[key])) recorded.add(provider)
    }

    const runtime = optionalService(this.ctx, 'llm')
    if (runtime !== undefined) {
      try {
        if (typeof runtime.listProviders === 'function') {
          for (const provider of runtime.listProviders() ?? []) {
            if (typeof provider?.id === 'string' && provider.id !== '') {
              rows.set(provider.id, { id: provider.id, displayName: resolveDisplayName(provider.name, provider.id), live: true })
            }
          }
        }
        if (typeof runtime.listConfigurableProviders === 'function') {
          for (const provider of runtime.listConfigurableProviders() ?? []) {
            const id = provider?.provider
            if (typeof id !== 'string' || id === '' || rows.has(id)) continue
            if (!includeDormant && !recorded.has(id)) continue
            rows.set(id, { id, displayName: resolveDisplayName(provider.displayName, id), live: false })
          }
        }
      } catch {
        // A registry hiccup degrades to ledger-only rows; the next poll retries.
      }
    }
    for (const provider of recorded) {
      if (!rows.has(provider)) rows.set(provider, { id: provider, displayName: providerDisplayName(provider), live: false })
    }
    const day = this.doc.days[todayKey]
    return [...rows.values()]
      .map((row) => {
        const models = day?.[row.id]
        let today
        if (models !== undefined) {
          today = emptyTotals()
          for (const totals of Object.values(models)) addTotals(today, totals)
        }
        return { ...row, ...(today !== undefined ? { today } : {}) }
      })
      .sort((a, b) => totalTokens(b.today ?? emptyTotals()) - totalTokens(a.today ?? emptyTotals())
        || Number(b.live) - Number(a.live)
        || a.displayName.localeCompare(b.displayName))
  }

  // ------------------------------------------------------------------
  // Session usage fold
  // ------------------------------------------------------------------

  /**
   * Fold one session event. A malformed event must never break the session
   * loop, so the whole body is guarded.
   * @param {{ id?: string }} session - the session the event belongs to.
   * @param {{ type?: string, data?: any, time?: unknown, seq?: unknown }} event - the event.
   */
  onSessionEvent(session, event) {
    try {
      if (!this.config.enabled) return
      const sessionId = typeof session?.id === 'string' ? session.id : ''
      if (sessionId === '') return

      // Both guards below — the replay sequence number and the replacement
      // slot — live in the persisted document, so they do not exist until the
      // initial read lands. A settlement that arrives during that read must
      // therefore WAIT for it rather than be folded as if it were new: the
      // file's copy of the same call would otherwise be merged on top of it
      // and the call would be counted twice, silently and permanently.
      // Deferring (not dropping) keeps the retry-after-restart case correct.
      if (!this.loaded) {
        void this.loadPersisted().then(() => {
          if (this.loaded) this.onSessionEvent(session, event)
        })
        return
      }

      // A scan is walking the same history right now. Folding live would move
      // the replay guard past settlements the scan has not reached yet, and the
      // scan would then skip them as already counted — losing every call the
      // live stream never saw, which is the whole reason the scan exists. Hold
      // them until it is done; by then the log's own copy is in, and the guard
      // drops the overlap by itself.
      if (this.backfilling !== undefined) {
        this.deferred.push([session, event])
        return
      }

      // Replay guard: a session reconstructed from its log must not fold
      // history a second time. Events carry their own sequence number, so a
      // stale or repeated one is dropped here.
      const seq = typeof event?.seq === 'number' && Number.isFinite(event.seq) ? event.seq : undefined
      const row = this.doc.sessions[sessionId]
      if (seq !== undefined && row?.lastSeq !== undefined && seq <= row.lastSeq) return

      if (event?.type === 'request/header') {
        this.rememberRoute(sessionId, event.data?.header?.config)
        return
      }
      if (event?.type === 'request/context') {
        this.rememberRoute(sessionId, event.data)
        return
      }

      const boundary = retryBoundaryOf(event)
      if (boundary !== undefined) {
        // The retried attempt is a fresh call: drop the slot so its sample
        // adds to the total instead of replacing the attempt it supersedes.
        const previous = this.doc.samples[sessionId]
        if (previous !== undefined && previous.turn === boundary.turn && previous.step === boundary.step) {
          delete this.doc.samples[sessionId]
          this.scheduleFlush()
        }
        return
      }

      const sample = sampleFromEvent(event, this.sessionRoutes.get(sessionId), Date.now(), sessionId)
      if (sample === undefined || isEmptySample(sample)) return
      // The slot only replaces a sample from the SAME step. A settlement for a
      // new step must add, even when its token counts happen to be identical.
      const slot = this.doc.samples[sessionId]
      const previous = slot !== undefined && slot.turn === sample.turn && slot.step === sample.step ? slot : undefined
      const changed = applySample(this.doc, sample, previous)
      if (seq !== undefined) {
        // The row exists whenever a non-empty sample was folded; a missing row
        // means the sample was refused, and a sequence number is not worth
        // resurrecting a swept row for.
        const target = this.doc.sessions[sessionId]
        if (target !== undefined) target.lastSeq = seq
      }
      this.current = { provider: sample.provider, model: sample.model, source: 'live' }
      if (changed) {
        this.pruneIfNeeded()
        this.scheduleFlush()
      }
    } catch (error) {
      // A malformed event must never break the session loop. Set
      // DSH_ABACUS_DEBUG=1 to surface the failure instead while developing.
      if (process.env.DSH_ABACUS_DEBUG === '1') throw error
    }
  }

  /**
   * Remember the route a session's newest request declared, as the fallback
   * attribution for settlements that omit `message.source`.
   * @param {string} sessionId - the session id.
   * @param {{ provider?: unknown, model?: unknown }|undefined} config - the request's route.
   */
  rememberRoute(sessionId, config) {
    const provider = config?.provider
    if (typeof provider !== 'string' || provider === '') return
    const model = typeof config?.model === 'string' ? config.model : ''
    // Bounded like `doc.sessions`: this cache is only a fallback attribution,
    // so an old entry is worth less than an unbounded map over a long-lived
    // host process. Re-setting an existing key keeps its original position,
    // which makes this eviction roughly oldest-first.
    if (this.sessionRoutes.size >= SESSION_ROUTE_CAP && !this.sessionRoutes.has(sessionId)) {
      const oldest = this.sessionRoutes.keys().next().value
      if (oldest !== undefined) this.sessionRoutes.delete(oldest)
    }
    this.sessionRoutes.set(sessionId, { provider, model })
    this.current = { provider, model, source: 'live' }
  }

  // ------------------------------------------------------------------
  // Persistence
  // ------------------------------------------------------------------

  /**
   * Load the persisted document and config, once per service instance.
   *
   * Single-flight on purpose: the fold *merges* the file into the live
   * document (so usage folded while the read was in flight survives), which
   * means two concurrent loads would fold the same file twice and double every
   * number. Callers that need to await the load — the stop path, tests — get
   * the same promise rather than a second read.
   * @returns {Promise<void>} resolves when the load has finished.
   */
  loadPersisted() {
    if (this.loadPromise === undefined) this.loadPromise = this.readPersisted()
    return this.loadPromise
  }

  /** Read and merge the persisted state; never throws. */
  async readPersisted() {
    try {
      const [rawDocument, rawConfig] = await Promise.all([
        readFile(this.documentPath, 'utf8').catch(() => undefined),
        readFile(this.configPath, 'utf8').catch(() => undefined),
      ])
      if (rawConfig !== undefined) {
        const parsed = JSON.parse(rawConfig)
        // The persisted config is the baseline; the caller's patch still wins,
        // but only for the fields it actually named — otherwise a partial
        // patch would reset every other saved setting to its default.
        const persisted = normalizeConfig(parsed)
        this.config = this.configExplicit ? patchConfig(persisted, this.configPatch) : persisted
      }
      if (rawDocument !== undefined) {
        const loaded = deserializeDocument(JSON.parse(rawDocument))
        // Merge into (never replace) the live document: folds that landed
        // during the read window must survive the load. Days and hours go into
        // their own maps from their own rows — `mergeBucketMap` explains why the
        // file cannot simply be replayed through the sample fold.
        mergeBucketMap(this.doc.days, loaded.days)
        mergeBucketMap(this.doc.hours, loaded.hours)
        for (const [sessionId, session] of Object.entries(loaded.sessions)) {
          const existing = this.doc.sessions[sessionId]
          this.doc.sessions[sessionId] = existing === undefined ? session : { ...session, ...existing }
        }
        for (const [sessionId, sample] of Object.entries(loaded.samples)) {
          if (this.doc.samples[sessionId] === undefined) this.doc.samples[sessionId] = sample
        }
        // The bookmarks ride along with the document, but the merge above is by
        // hand, so they have to be carried over by hand too. Losing the hour one
        // would re-walk every session log on every start, and losing the replay
        // one would rebuild the ledger on every scan.
        if (loaded.history !== undefined && this.doc.history === undefined) this.doc.history = loaded.history
        if (loaded.hoursBuiltAt !== undefined && this.doc.hoursBuiltAt === undefined) {
          this.doc.hoursBuiltAt = loaded.hoursBuiltAt
        }
        if (loaded.replayGuardAt !== undefined && this.doc.replayGuardAt === undefined) {
          this.doc.replayGuardAt = loaded.replayGuardAt
        }
        this.pruneIfNeeded(true)
      }
    } catch {
      // Corrupt or unreadable state starts fresh; the next flush rewrites it.
    } finally {
      // Only now may flushes overwrite the persisted file.
      this.loaded = true
    }
  }

  /**
   * Trim the session map back to its cap, at most once per local day.
   *
   * The daily ledger is never pruned — see {@link pruneDocument} — so this only
   * ever has work to do on a document that has accumulated more conversations
   * than the cap allows, which is not a daily event. Re-checking once a day
   * keeps the check off the fold path.
   */
  pruneIfNeeded(force = false) {
    const todayKey = localDateKey(Date.now())
    if (!force && this.lastPrune === todayKey) return
    pruneDocument(this.doc)
    this.lastPrune = todayKey
  }

  /** Queue a debounced document write. */
  scheduleFlush() {
    if (this.flushTimer !== undefined || this.disposed) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined
      void this.flushDocument()
    }, FLUSH_DEBOUNCE_MS)
    // A pending flush must not keep the host process alive.
    this.flushTimer.unref?.()
  }

  /**
   * Write the document and config atomically, serialized behind any flush
   * already in flight.
   * @returns {Promise<void>} resolves when this write has landed.
   */
  flushDocument() {
    const run = async () => {
      // A write before the initial load finished would clobber the file with
      // an empty document, so it waits instead.
      if (this.loadPromise !== undefined) await this.loadPromise
      try {
        await mkdir(this.dir, { recursive: true })
        await writeFileAtomic(this.documentPath, JSON.stringify(this.doc))
      } catch {
        // A failed write must not take the session loop down; the next fold retries.
      }
    }
    this.flushChain = this.flushChain.then(run, run)
    return this.flushChain
  }

  /** Persist the configuration. */
  async persistConfig() {
    try {
      await mkdir(this.dir, { recursive: true })
      await writeFileAtomic(this.configPath, JSON.stringify(this.config, null, 2))
    } catch {
      // Same policy as the document: a failed write is retried on the next save.
    }
  }
}

/**
 * Write a file by writing a sibling temp file and renaming it over the target.
 * A crash mid-write leaves the previous file intact instead of a truncated one.
 * @param {string} path - the destination path.
 * @param {string} contents - the file contents.
 */
export async function writeFileAtomic(path, contents) {
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`
  try {
    await writeFile(temp, contents, 'utf8')
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}
