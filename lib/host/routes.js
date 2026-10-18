/**
 * The JSON routes the browser half polls.
 *
 * Path convention: `/api/<plugin-id>/<name>`, registered WITH a leading slash.
 * The browser must fetch the *document-relative* form (`api/usage-stat/...`,
 * no leading slash) because the GUI is served with `<base href="./">`, so a
 * sub-path deployment resolves the URL against its own entry directory instead
 * of escaping to the origin root. Getting this asymmetry wrong is a 404.
 *
 * Every route is behind {@link isUsageRequestAllowed} and answers with
 * `cache-control: no-store`, so a refresh always observes the live document.
 *
 * @module dsh-usage-stat/host/routes
 */

import { isUsageRequestAllowed } from './access.js'
import { readJsonBody, writeJson } from './http.js'
import { isLedgerDateKey } from '../core/document.js'

/** Route prefix; the browser omits the leading slash. */
export const API_PREFIX = '/api/usage-stat'

/** Shared 403 body. */
const FORBIDDEN = { ok: false, error: 'forbidden: loopback or paired device only' }

/** Shared response headers. */
const NO_STORE = { 'cache-control': 'no-store' }

/**
 * Reject a request that fails the trust fence, or one that is not a GET.
 * @param {object} ctx - host context.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {string} [method] - the method this route accepts.
 * @returns {boolean} true when the caller may proceed.
 */
function guard(ctx, req, res, method = 'GET') {
  if (!isUsageRequestAllowed(ctx, req)) {
    writeJson(res, 403, FORBIDDEN, NO_STORE)
    return false
  }
  if (req.method !== method) {
    writeJson(res, 405, { ok: false, error: `method not allowed: use ${method}` }, NO_STORE)
    return false
  }
  return true
}

/**
 * `GET api/usage-stat/overview` — the whole browser-facing document: config,
 * today's detail, the trend window, and the provider list.
 * @param {object} ctx - host context.
 * @param {import('./usage-service.js').UsageService} service - the usage service.
 * @returns {object} the route.
 */
export function makeOverviewRoute(ctx, service) {
  return {
    kind: 'exact',
    path: `${API_PREFIX}/overview`,
    handler: (req, res) => {
      if (!guard(ctx, req, res)) return
      writeJson(res, 200, { ok: true, overview: service.overview() }, NO_STORE)
    },
  }
}

/**
 * `GET api/usage-stat/day?date=YYYY-MM-DD` — one retained day's per-provider
 * and per-model detail, so the settings day picker can show a past day. A key
 * that is not a real local date is refused with 400 rather than folded into a
 * bogus day.
 * @param {object} ctx - host context.
 * @param {import('./usage-service.js').UsageService} service - the usage service.
 * @returns {object} the route.
 */
export function makeDayRoute(ctx, service) {
  return {
    kind: 'exact',
    path: `${API_PREFIX}/day`,
    handler: (req, res) => {
      if (!guard(ctx, req, res)) return
      const date = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('date') ?? ''
      if (!isLedgerDateKey(date)) {
        writeJson(res, 400, { ok: false, error: 'date must be a real YYYY-MM-DD local date' }, NO_STORE)
        return
      }
      writeJson(res, 200, { ok: true, day: service.day(date) }, NO_STORE)
    },
  }
}

/**
 * `GET api/usage-stat/range?from=YYYY-MM-DD&to=YYYY-MM-DD` — an arbitrary
 * window, aggregated per provider and per day, for the settings range picker.
 *
 * Both ends are inclusive and either may be omitted (open-ended at that end),
 * which is how the 全部 preset is expressed. A key that is not a real local
 * date, or a window that runs backwards, is refused with 400 rather than
 * silently folded into a different window.
 * @param {object} ctx - host context.
 * @param {import('./usage-service.js').UsageService} service - the usage service.
 * @returns {object} the route.
 */
export function makeRangeRoute(ctx, service) {
  return {
    kind: 'exact',
    path: `${API_PREFIX}/range`,
    handler: (req, res) => {
      if (!guard(ctx, req, res)) return
      const params = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
      const from = params.get('from') ?? ''
      const to = params.get('to') ?? ''
      for (const [name, value] of [['from', from], ['to', to]]) {
        if (value !== '' && !isLedgerDateKey(value)) {
          writeJson(res, 400, { ok: false, error: `${name} must be a real YYYY-MM-DD local date` }, NO_STORE)
          return
        }
      }
      if (from !== '' && to !== '' && from > to) {
        writeJson(res, 400, { ok: false, error: 'from must not be after to' }, NO_STORE)
        return
      }
      writeJson(res, 200, { ok: true, range: service.rangeView(from, to) }, NO_STORE)
    },
  }
}

/**
 * `GET api/usage-stat/session?id=<sessionId>` — one conversation's totals.
 *
 * The composer badge reads the session projection directly and needs no route;
 * this exists for the settings section, which can show a specific conversation
 * and for any client that cannot reach the projection.
 * @param {object} ctx - host context.
 * @param {import('./usage-service.js').UsageService} service - the usage service.
 * @returns {object} the route.
 */
export function makeSessionRoute(ctx, service) {
  return {
    kind: 'exact',
    path: `${API_PREFIX}/session`,
    handler: (req, res) => {
      if (!guard(ctx, req, res)) return
      const id = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('id') ?? ''
      if (id === '') {
        writeJson(res, 400, { ok: false, error: 'id is required' }, NO_STORE)
        return
      }
      writeJson(res, 200, { ok: true, session: service.session(id) }, NO_STORE)
    },
  }
}

/**
 * `POST api/usage-stat/config` — apply a partial configuration update. The
 * body is bounded and every field is validated by `normalizeConfig`, so an
 * unknown key or an out-of-range number cannot reach the service.
 * @param {object} ctx - host context.
 * @param {import('./usage-service.js').UsageService} service - the usage service.
 * @returns {object} the route.
 */
export function makeConfigRoute(ctx, service, probes) {
  return {
    kind: 'exact',
    path: `${API_PREFIX}/config`,
    handler: async (req, res) => {
      if (!guard(ctx, req, res, 'POST')) return
      const body = await readJsonBody(req, { objectOnly: true })
      if (body === null) {
        writeJson(res, 400, { ok: false, error: 'body must be a JSON object' }, NO_STORE)
        return
      }
      const config = await service.updateConfig(body)
      // The probe service has its own switches and cadence, so a save must
      // reach it too — otherwise turning probing off would not stop the cycle
      // until the next restart.
      probes.configure(config)
      writeJson(res, 200, { ok: true, config }, NO_STORE)
    },
  }
}

/**
 * `POST api/usage-stat/refresh` — flush any pending write and answer with a
 * freshly assembled overview.
 *
 * The numbers need no re-probe: usage is folded from live session events, so
 * the overview is always current. This route exists to give the settings
 * card's 刷新 button one honest meaning — "commit what you have and give me
 * the current numbers now" — rather than pretending to re-query a provider.
 * @param {object} ctx - host context.
 * @param {import('./usage-service.js').UsageService} service - the usage service.
 * @returns {object} the route.
 */
export function makeRefreshRoute(ctx, service) {
  return {
    kind: 'exact',
    path: `${API_PREFIX}/refresh`,
    handler: async (req, res) => {
      if (!guard(ctx, req, res, 'POST')) return
      await service.flushDocument()
      writeJson(res, 200, { ok: true, overview: service.overview() }, NO_STORE)
    },
  }
}

/**
 * `GET api/usage-stat/providers` — the cached vendor facts: what each provider
 * account holds and how much of its subscription window is spent.
 *
 * These numbers come from remote endpoints on their own slow cadence, so they
 * are served from the snapshot the probe service already holds rather than
 * being re-queried per request. `updatedAt` is when that snapshot was taken.
 * @param {object} ctx - host context.
 * @param {import('./probe-service.js').ProbeService} probes - the probe service.
 * @returns {object} the route.
 */
export function makeProvidersRoute(ctx, probes) {
  return {
    kind: 'exact',
    path: `${API_PREFIX}/providers`,
    handler: (req, res) => {
      if (!guard(ctx, req, res)) return
      writeJson(res, 200, { ok: true, providers: probes.view() }, NO_STORE)
    },
  }
}

/**
 * `POST api/usage-stat/probe` — probe the vendor endpoints now.
 *
 * This is the one route that reaches the network on demand, and it is the
 * settings card's 刷新 button for the two tabs that show vendor facts. It
 * resolves once the cycle has finished so the answer already carries the new
 * facts.
 * @param {object} ctx - host context.
 * @param {import('./probe-service.js').ProbeService} probes - the probe service.
 * @returns {object} the route.
 */
export function makeProbeRoute(ctx, probes) {
  return {
    kind: 'exact',
    path: `${API_PREFIX}/probe`,
    handler: async (req, res) => {
      if (!guard(ctx, req, res, 'POST')) return
      await probes.refresh({ force: true })
      writeJson(res, 200, { ok: true, providers: probes.view() }, NO_STORE)
    },
  }
}

/**
 * `POST /api/usage-stat/backfill` — replay the session logs again.
 *
 * The automatic replay happens once, at start. This route exists for the gap
 * that bookmark cannot see: the plugin was switched off for a while, so calls
 * settled that no replay has read yet.
 * @param {object} ctx - host context.
 * @param {import('./usage-service.js').UsageService} service - the usage service.
 * @returns {object} the route.
 */
export function makeBackfillRoute(ctx, service) {
  return {
    kind: 'exact',
    path: `${API_PREFIX}/backfill`,
    handler: async (req, res) => {
      if (!guard(ctx, req, res, 'POST')) return
      const tally = await service.backfill({ force: true })
      writeJson(res, 200, { ok: true, backfill: tally }, NO_STORE)
    },
  }
}

/**
 * Every route this plugin serves, in registration order.
 * @param {object} ctx - host context.
 * @param {import('./usage-service.js').UsageService} service - the usage service.
 * @param {import('./probe-service.js').ProbeService} probes - the probe service.
 * @returns {object[]} the routes.
 */
export function makeRoutes(ctx, service, probes) {
  return [
    makeOverviewRoute(ctx, service),
    makeDayRoute(ctx, service),
    makeRangeRoute(ctx, service),
    makeSessionRoute(ctx, service),
    makeProvidersRoute(ctx, probes),
    makeProbeRoute(ctx, probes),
    makeBackfillRoute(ctx, service),
    makeConfigRoute(ctx, service, probes),
    makeRefreshRoute(ctx, service),
  ]
}
