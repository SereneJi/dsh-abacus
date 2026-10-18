/**
 * dsh-usage-stat host half.
 *
 * One row mounts both halves of this plugin: this module is the host side
 * (the token ledger folded from `session/event`, the `api/usage-stat/*` JSON
 * routes), and `./client` is the browser side the web plugin roster serves.
 *
 * There is no `Config` schema on purpose — see `host/config.js` for why the
 * plugin owns its own settings file instead of borrowing the Host's settings
 * surface. The consequence worth knowing: a settings save never remounts this
 * row, so the service and its routes stay up across a configuration change.
 *
 * @module dsh-usage-stat
 */

import { UsageService } from './host/usage-service.js'
import { ProbeService } from './host/probe-service.js'
import { makeRoutes } from './host/routes.js'

export const name = 'dsh-usage-stat'

/** The host services this row needs: the web server, to serve its JSON routes. */
export const inject = ['webServer']

/**
 * Cross-fiber mount guard.
 *
 * The Host can apply the same package more than once — an aggregate bundle
 * plus a standalone row, or a hot reload that overlaps the previous fiber.
 * Registering the same exact route twice is a boot failure ("duplicate prefix
 * route"), and two services would fold every call twice. The guard is keyed by
 * package name on a global symbol so every module instance in the process
 * agrees, and it is released on dispose so a reload can mount again.
 */
const MOUNTED = Symbol.for('dsh-usage-stat.mounted')

/**
 * Plugin body.
 * @param {object} ctx - host root context.
 */
export function apply(ctx) {
  const registry = /** @type {Record<symbol, boolean>} */ (globalThis)
  if (registry[MOUNTED] === true) return
  registry[MOUNTED] = true

  let live = true
  /** @type {UsageService|undefined} */
  let service
  /** @type {ProbeService|undefined} */
  let probes
  /** @type {Array<() => void>} */
  let routeDisposers = []

  const mount = () => {
    if (!live || service !== undefined) return
    // The ledger takes the reminders as a late-bound callback rather than a
    // constructor dependency: the two services are peers, and this way the
    // overview poll carries the dot on the same tick as the number beside it.
    const next = new UsageService(ctx, undefined, { alerts: () => probes?.alerts() ?? [] })
    service = next
    // Fire and forget: the load is single-flight and never rejects. Events that
    // arrive while it runs are replayed by the service once it lands.
    void next.start()
    // The vendor probe shares the ledger's state directory but not its cadence:
    // balances and plan windows are slow, rate-limited and nearly static, so
    // they refresh on their own much longer interval.
    const nextProbes = new ProbeService({
      ctx,
      stateDir: next.dir,
      // Read fresh every cycle: a provider used for the first time today is
      // worth asking about on the next pass without a restart.
      ledgerRoutes: () => next.knownRoutes(),
    })
    probes = nextProbes
    nextProbes.configure(next.getConfig())
    void nextProbes.start()
    routeDisposers = makeRoutes(ctx, next, nextProbes).map((route) => ctx.webServer.register(route))
  }

  /**
   * Tear down the service and its routes.
   * @returns {Promise<void>|undefined} the final-flush promise, so a runtime
   * that awaits async disposers can drain the last debounced write.
   */
  const unmount = () => {
    for (const dispose of routeDisposers) {
      try {
        dispose()
      } catch {
        // The route fiber is already gone during shutdown.
      }
    }
    routeDisposers = []
    const stoppingProbes = probes?.stop()
    probes = undefined
    const stopping = service?.stop()
    service = undefined
    return Promise.all([stoppingProbes, stopping]).then(() => undefined)
  }

  ctx.effect(() => {
    mount()
    return () => {
      live = false
      const stopping = unmount()
      delete registry[MOUNTED]
      // Returned rather than swallowed: DSH may await a disposer's value, and
      // the last ≤3 s of folded usage is otherwise lost if the process exits
      // before the debounced write lands.
      return stopping
    }
  }, 'dsh-usage-stat: runtime')
}
