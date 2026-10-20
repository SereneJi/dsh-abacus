/**
 * Integration tests for the host service and its routes.
 *
 * These drive the real service with synthetic `session/event` payloads and
 * then call the real route handlers with fake request/response objects, which
 * is the strongest verification available without the live server: it covers
 * the fold, the JSON documents, the trust fence, and the config write path.
 *
 * `DSH_HOME` is redirected to a fresh temp directory for every service, so the
 * tests never touch the user's real ledger and never see each other's writes.
 *
 * Run with: node --test test/
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'

const { UsageService } = await import('../lib/host/usage-service.js')
const { makeRoutes } = await import('../lib/host/routes.js')
const { localDateKey } = await import('../lib/core/document.js')

/**
 * A minimal host context: records the `session/event` listener and the
 * registered routes, and answers `get` for the optional services.
 * @param {Record<string, unknown>} [services] - optional services to expose.
 */
function fakeContext(services = {}) {
  const listeners = new Map()
  const routes = []
  return {
    listeners,
    routes,
    on(name, listener) {
      listeners.set(name, listener)
      return () => listeners.delete(name)
    },
    get(name) {
      return services[name]
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    },
  }
}

/** A fake request that passes the loopback fence. */
function loopbackRequest(url = '/', method = 'GET', body = undefined) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  return {
    url,
    method,
    headers: { host: '127.0.0.1:19387' },
    socket: { remoteAddress: '127.0.0.1' },
    destroy() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** A fake response capturing status, body and headers. */
function fakeResponse() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(payload) {
      this.body = payload
    },
    json() {
      return JSON.parse(this.body)
    },
  }
}

/** Fire one session event at the service. */
function emit(ctx, sessionId, event) {
  const listener = ctx.listeners.get('session/event')
  assert.ok(listener, 'the service subscribed to session/event')
  listener({ id: sessionId }, event)
}

/**
 * Dispatch one request through the route table the way the web server does:
 * by exact path, first match wins.
 */
async function answer(routes, request, response) {
  const route = routes.find((entry) => entry.kind === 'exact' && entry.path === request.url.split('?')[0])
  assert.ok(route, `no route for ${request.url}`)
  await route.handler(request, response)
  return response
}

/**
 * A local timestamp at `hour` o'clock, `dayOffset` days before today.
 *
 * The live fold's fixtures used to hardcode `2026-10-18`, which made this suite
 * pass only on the day it was written: `overview.usage.today` is derived from
 * the clock, so the next morning every folded call landed on a day the
 * assertions never asked about and four tests failed with `0 !== 2`. Anything
 * that asserts against "today" has to be built from today. Tests that need a
 * fixed date — the range route, the replay guard — pass `time` explicitly.
 * @param {number} hour - local hour of day.
 * @param {number} [dayOffset] - days before today.
 * @returns {number} epoch milliseconds.
 */
function localTime(hour, dayOffset = 0) {
  const date = new Date()
  date.setDate(date.getDate() - dayOffset)
  date.setHours(hour, 0, 0, 0)
  return date.getTime()
}

/** A settlement event carrying usage. */
function settlement(overrides = {}) {
  return {
    type: 'assistant/message',
    seq: overrides.seq ?? 1,
    time: overrides.time ?? localTime(10),
    data: {
      turn: overrides.turn ?? 1,
      step: overrides.step ?? 1,
      usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000, cacheWriteTokens: 0, ...(overrides.usage ?? {}) },
      message: { source: { kind: 'model', provider: overrides.provider ?? 'opencode-go', model: overrides.model ?? 'deepseek-v4.1-flash' } },
    },
  }
}

/**
 * Build a started service on a fake context.
 *
 * `start()` is awaited because the service defers events that arrive before the
 * persisted ledger has been merged, and these tests emit immediately.
 * @param {object} [config] - an explicit config.
 * @param {string} [home] - reuse an existing DSH home (the reload test does).
 * @param {object} [options] - passed through to the service (a `sessionsDir`).
 */
async function started(config, home, options = {}) {
  process.env.DSH_HOME = home ?? mkdtempSync(join(tmpdir(), 'dsh-abacus-test-'))
  const ctx = fakeContext()
  const service = new UsageService(ctx, config, options)
  await service.start()
  // `start()` fires the log scan without waiting for it, and a settlement that
  // lands while that scan is walking is held until it ends — otherwise the scan
  // would skip the log as already counted and the history would be lost. Wait
  // for the scan that is already running, without starting or consuming one.
  if (service.backfilling !== undefined) await service.backfilling
  return { ctx, service, home: process.env.DSH_HOME }
}

/**
 * Build a sessions tree the way DSH writes one: a directory per session holding
 * a log that is a concatenation of independently compressed zstd frames.
 * @param {Record<string, object[]>} logs - session id to its events.
 * @returns {string} the sessions root.
 */
function sessionsRoot(logs) {
  const root = join(mkdtempSync(join(tmpdir(), 'dsh-abacus-sessions-')), 'sessions')
  for (const [id, events] of Object.entries(logs)) {
    const dir = join(root, id)
    mkdirSync(dir, { recursive: true })
    const frames = events.map((event) => zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`)))
    writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
  }
  return root
}

/** A logged settlement: the same envelope the live fold sees. */
function logged(overrides = {}) {
  return {
    type: 'assistant/message',
    seq: overrides.seq ?? 1,
    time: overrides.time ?? new Date('2026-10-16T10:00:00').getTime(),
    data: {
      turn: overrides.turn ?? 1,
      step: overrides.step ?? 1,
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110, ...(overrides.usage ?? {}) },
      message: {
        source: { kind: 'model', provider: overrides.provider ?? 'opencode-go', model: overrides.model ?? 'deepseek-v4.1-flash' },
        // Real settlements carry a message id. It is optional here so the tests
        // that predate it keep exercising the id-less path, which must not be
        // de-duplicated across logs.
        ...(overrides.id === undefined ? {} : { id: overrides.id }),
      },
    },
  }
}

test('a fresh service replays the sessions DSH already saved', async () => {
  // The whole point of the feature: install today and yesterday is not blank.
  const root = sessionsRoot({
    'session-one': [
      { type: 'session', version: 4, id: 'session-one' },
      logged({ seq: 1, time: new Date('2026-10-16T09:00:00').getTime() }),
      logged({ seq: 2, turn: 1, step: 2, usage: { inputTokens: 50, outputTokens: 5, totalTokens: 55 } }),
    ],
    'session-two': [
      { type: 'session', version: 4, id: 'session-two' },
      logged({ seq: 1, time: new Date('2026-10-17T09:00:00').getTime(), provider: 'deepseek', model: 'deepseek-flash' }),
    ],
  })

  const { service } = await started(undefined, undefined, { sessionsDir: root })
  // `started()` already waited for the first scan, so a plain call answers
  // "nothing to do"; forcing it is what replays the logs again, and the replay
  // guard is what keeps that second pass from counting anything twice.
  const tally = await service.backfill({ force: true })

  assert.equal(tally.skipped, false)
  assert.equal(tally.files, 2)
  assert.equal(tally.events, 3)

  const overview = service.overview()
  assert.deepEqual(overview.usage.availableDays, ['2026-10-16', '2026-10-17'], 'replayed calls land on the day they happened')
  assert.equal(overview.usage.today.totals.calls, 0, 'and none of them land on today')
  assert.equal(overview.history.files, 2)
  assert.equal(overview.history.events, 3)
  assert.equal(overview.providers.length, 2)

  const day = service.day('2026-10-16')
  assert.equal(day.totals.calls, 2)
  assert.equal(day.totals.inputTokens, 150)
  assert.equal(day.totals.outputTokens, 15)
})

test('replaying the same logs twice counts every call once', async () => {
  // The `seq` guard is what makes the bookmark an optimization rather than a
  // correctness requirement — this is the test that proves it.
  const root = sessionsRoot({
    'session-one': [
      { type: 'session', version: 4, id: 'session-one' },
      logged({ seq: 1 }),
      logged({ seq: 2, turn: 1, step: 2 }),
    ],
  })

  const { service } = await started(undefined, undefined, { sessionsDir: root })
  await service.backfill()
  const first = service.day('2026-10-16').totals.calls

  await service.backfill({ force: true })
  await service.backfill({ force: true })

  assert.equal(first, 2)
  assert.equal(service.day('2026-10-16').totals.calls, 2, 'a second replay adds nothing')
})

test('the automatic replay is skipped once the bookmark exists', async () => {
  const root = sessionsRoot({ 'session-one': [{ type: 'session', id: 'session-one' }, logged({ seq: 1 })] })

  const { service, home } = await started(undefined, undefined, { sessionsDir: root })
  await service.backfill()

  // A restart with the same home: the bookmark says the past is already in.
  const { service: reloaded } = await started(undefined, home, { sessionsDir: root })
  assert.equal(reloaded.overview().history.files, 1, 'the bookmark survives the reload')
  assert.equal(reloaded.overview().usage.today.totals.calls, 0)

  // And the tally is a skip rather than a re-read.
  const tally = await reloaded.backfill()
  assert.equal(tally.skipped, true)
})

test('a replay skips events that carry no sequence number', async () => {
  // Without a `seq` there is no way to tell a logged call from one the live fold
  // already counted, so it is left out: a gap beats a double count.
  const root = sessionsRoot({
    'session-one': [
      { type: 'session', id: 'session-one' },
      logged({ seq: 1 }),
      (() => {
        const event = logged({ seq: 2, turn: 1, step: 2 })
        delete event.seq
        return event
      })(),
    ],
  })

  const { service } = await started(undefined, undefined, { sessionsDir: root })
  // `started()` already waited for the first scan, so a plain call answers
  // "nothing to do"; forcing it is what replays the logs again, and the replay
  // guard is what keeps that second pass from counting anything twice.
  const tally = await service.backfill({ force: true })

  assert.equal(tally.events, 1, 'the unsequenced event is not replayed')
  assert.equal(service.day('2026-10-16').totals.calls, 1)
})

test('a disabled plugin replays nothing', async () => {
  const root = sessionsRoot({ 'session-one': [{ type: 'session', id: 'session-one' }, logged({ seq: 1 })] })

  const { service } = await started({ enabled: false }, undefined, { sessionsDir: root })
  const tally = await service.backfill({ force: true })

  assert.equal(tally.skipped, true)
  assert.equal(service.overview().history, null)
})

test('the backfill route forces a scan and answers with the tally', async () => {
  const root = sessionsRoot({ 'session-one': [{ type: 'session', id: 'session-one' }, logged({ seq: 1 })] })
  const { ctx, service } = await started(undefined, undefined, { sessionsDir: root })
  await service.backfill()
  const routes = makeRoutes(ctx, service, { view: () => ({}), refresh: async () => ({}), configure() {} })

  const request = loopbackRequest('/api/abacus/backfill', 'POST')
  const response = await answer(routes, request, fakeResponse())

  assert.equal(response.status, 200)
  assert.deepEqual(response.json().backfill, { files: 1, events: 1, skipped: false })
  assert.equal(response.headers['cache-control'], 'no-store')

  const wrongMethod = await answer(routes, loopbackRequest('/api/abacus/backfill', 'GET'), fakeResponse())
  assert.equal(wrongMethod.status, 405)
})

test('folds live events into the overview, the day view and the session view', async () => {
  const { ctx, service } = await started()
  emit(ctx, 's1', { type: 'request/header', data: { header: { config: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } } } })
  emit(ctx, 's1', settlement({ seq: 2, turn: 1, step: 1 }))
  emit(ctx, 's1', settlement({ seq: 3, turn: 1, step: 2, usage: { inputTokens: 50, outputTokens: 5 } }))

  const overview = service.overview()
  assert.equal(overview.usage.today.totals.calls, 2)
  assert.equal(overview.usage.today.totals.inputTokens, 150)
  assert.equal(overview.usage.today.totals.cacheReadTokens, 2000)
  assert.equal(overview.usage.today.providers[0].provider, 'opencode-go')
  assert.equal(overview.usage.today.providers[0].displayName, 'OpenCode Go')
  assert.equal(overview.current.provider, 'opencode-go')
  assert.equal(overview.current.source, 'live')
  assert.deepEqual(overview.usage.availableDays, [overview.usage.today.date])

  const session = service.session('s1')
  assert.equal(session.totals.calls, 2)
  assert.equal(session.provider, 'opencode-go')
  // The composer panel is served from this view, so it must carry the
  // conversation's own breakdown, not only its grand total.
  assert.equal(session.providers.length, 1)
  assert.equal(session.providers[0].provider, 'opencode-go')
  assert.equal(session.providers[0].displayName, 'OpenCode Go')
  assert.equal(session.providers[0].models[0].model, 'deepseek-v4.1-flash')
  assert.equal(session.providers[0].totals.inputTokens, 150)

  await service.stop()
})

test('a session view splits a conversation across the vendors it actually used', async () => {
  const { ctx, service } = await started()
  emit(ctx, 's1', settlement({ seq: 1, turn: 1, step: 1, provider: 'opencode-go', usage: { inputTokens: 900, outputTokens: 0 } }))
  emit(ctx, 's1', settlement({ seq: 2, turn: 2, step: 1, provider: 'deepseek', usage: { inputTokens: 100, outputTokens: 0 } }))

  const session = service.session('s1')
  assert.equal(session.totals.inputTokens, 1_000)
  assert.deepEqual(session.providers.map((row) => row.provider), ['opencode-go', 'deepseek'])
  assert.equal(session.providers[0].totals.inputTokens, 900)
  assert.equal(session.providers[1].totals.inputTokens, 100)

  // A conversation the host has never seen is not an error: the panel opened
  // on a brand-new chat must render something honest.
  const unknown = service.session('never-seen')
  assert.equal(unknown.sessionId, 'never-seen')
  assert.equal(unknown.totals.calls, 0)
  assert.deepEqual(unknown.providers, [])

  await service.stop()
})

test('a retried step replaces its sample instead of double counting', async () => {
  const { ctx, service } = await started()
  emit(ctx, 's1', settlement({ seq: 1, turn: 4, step: 9, usage: { inputTokens: 100, outputTokens: 10 } }))
  // The retry re-settles the same step with different numbers.
  emit(ctx, 's1', settlement({ seq: 2, turn: 4, step: 9, usage: { inputTokens: 300, outputTokens: 30 } }))
  assert.equal(service.overview().usage.today.totals.calls, 1)
  assert.equal(service.overview().usage.today.totals.inputTokens, 300)
  assert.equal(service.session('s1').totals.calls, 1)

  // llm/retry-started closes the slot: the next settlement for the step ADDS.
  emit(ctx, 's1', { type: 'llm/retry-started', seq: 3, data: { turn: 4, step: 9 } })
  emit(ctx, 's1', settlement({ seq: 4, turn: 4, step: 9, usage: { inputTokens: 300, outputTokens: 30 } }))
  assert.equal(service.session('s1').totals.calls, 2)
  assert.equal(service.session('s1').totals.inputTokens, 600)

  await service.stop()
})

test('the replay guard ignores an event whose sequence was already folded', async () => {
  const { ctx, service } = await started()
  emit(ctx, 's1', settlement({ seq: 7 }))
  emit(ctx, 's1', settlement({ seq: 7 }))
  assert.equal(service.session('s1').totals.calls, 1)

  await service.stop()
})

test('an event that lands during the initial load is replayed, not dropped or double counted', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-abacus-test-'))
  process.env.DSH_HOME = home

  // Seed a ledger on disk, so the second boot has something to merge.
  const first = fakeContext()
  const seeding = new UsageService(first)
  await seeding.start()
  emit(first, 's1', settlement({ seq: 1, turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10 } }))
  await seeding.stop()

  // Boot again and emit *before* awaiting the load. The guard must hold the
  // event until the file is merged: folding it blind would let the persisted
  // copy of the same call stack on top and double count forever.
  const second = fakeContext()
  const service = new UsageService(second)
  const loading = service.start()
  emit(second, 's1', settlement({ seq: 1, turn: 1, step: 1, usage: { inputTokens: 100, outputTokens: 10 } }))
  await loading

  assert.equal(service.session('s1').totals.calls, 1, 'the replayed event replaces the loaded sample')
  assert.equal(service.session('s1').totals.inputTokens, 100)

  // A genuinely new call still adds on top of the replayed one.
  emit(second, 's1', settlement({ seq: 2, turn: 1, step: 2, usage: { inputTokens: 50, outputTokens: 5 } }))
  assert.equal(service.session('s1').totals.calls, 2)
  assert.equal(service.session('s1').totals.inputTokens, 150)

  await service.stop()
})

test('the trust fence refuses a non-loopback request and a wrong method', async () => {
  const { ctx, service } = await started()
  const routes = makeRoutes(ctx, service)
  const overview = routes.find((route) => route.path.endsWith('/overview'))
  const config = routes.find((route) => route.path.endsWith('/config'))

  const remote = fakeResponse()
  overview.handler({
    url: '/api/abacus/overview',
    method: 'GET',
    headers: { host: '192.168.1.9:19387' },
    socket: { remoteAddress: '192.168.1.9' },
  }, remote)
  assert.equal(remote.status, 403)

  const wrongMethod = fakeResponse()
  overview.handler(loopbackRequest('/api/abacus/overview', 'POST'), wrongMethod)
  assert.equal(wrongMethod.status, 405)

  const wrongConfigMethod = fakeResponse()
  await config.handler(loopbackRequest('/api/abacus/config', 'GET'), wrongConfigMethod)
  assert.equal(wrongConfigMethod.status, 405)

  await service.stop()
})

test('the routes answer with the documents the browser polls', async () => {
  const { ctx, service } = await started()
  emit(ctx, 's1', settlement({ seq: 1 }))
  const routes = makeRoutes(ctx, service)

  const overview = fakeResponse()
  routes.find((route) => route.path.endsWith('/overview')).handler(loopbackRequest(), overview)
  assert.equal(overview.status, 200)
  assert.equal(overview.headers['cache-control'], 'no-store')
  assert.equal(overview.json().overview.usage.today.totals.calls, 1)

  const date = service.overview().usage.today.date
  const day = fakeResponse()
  routes.find((route) => route.path.endsWith('/day')).handler(loopbackRequest(`/api/abacus/day?date=${date}`), day)
  assert.equal(day.status, 200)
  assert.equal(day.json().day.date, date)

  const badDay = fakeResponse()
  routes.find((route) => route.path.endsWith('/day')).handler(loopbackRequest('/api/abacus/day?date=2026-02-30'), badDay)
  assert.equal(badDay.status, 400)

  const session = fakeResponse()
  routes.find((route) => route.path.endsWith('/session')).handler(loopbackRequest('/api/abacus/session?id=s1'), session)
  assert.equal(session.status, 200)
  assert.equal(session.json().session.totals.calls, 1)

  const noId = fakeResponse()
  routes.find((route) => route.path.endsWith('/session')).handler(loopbackRequest('/api/abacus/session'), noId)
  assert.equal(noId.status, 400)

  await service.stop()
})

test('the range route answers for exactly the window asked for', async () => {
  const { ctx, service } = await started()
  // Three days, one call each, so a window that leaks a day is visible.
  emit(ctx, 's1', settlement({ seq: 1, turn: 1, step: 1, time: new Date('2026-10-16T10:00:00').getTime() }))
  emit(ctx, 's1', settlement({ seq: 2, turn: 2, step: 2, time: new Date('2026-10-17T10:00:00').getTime() }))
  emit(ctx, 's1', settlement({ seq: 3, turn: 3, step: 3, time: new Date('2026-10-18T10:00:00').getTime() }))
  const routes = makeRoutes(ctx, service)
  const range = routes.find((route) => route.path.endsWith('/range'))
  const ask = (query) => {
    const res = fakeResponse()
    range.handler(loopbackRequest(`/api/abacus/range${query}`), res)
    return res
  }

  const twoDays = ask('?from=2026-10-17&to=2026-10-18')
  assert.equal(twoDays.status, 200)
  assert.equal(twoDays.headers['cache-control'], 'no-store')
  assert.deepEqual(twoDays.json().range.days.map((day) => day.date), ['2026-10-17', '2026-10-18'])
  assert.equal(twoDays.json().range.totals.calls, 2)
  assert.equal(twoDays.json().range.from, '2026-10-17')
  assert.equal(twoDays.json().range.to, '2026-10-18')

  const oneDay = ask('?from=2026-10-16&to=2026-10-16')
  assert.deepEqual(oneDay.json().range.days.map((day) => day.date), ['2026-10-16'])
  assert.equal(oneDay.json().range.totals.calls, 1)

  // Empty bounds mean "everything still retained", not "nothing".
  const all = ask('?from=&to=')
  assert.equal(all.status, 200)
  assert.equal(all.json().range.from, '2026-10-16')
  assert.equal(all.json().range.to, '2026-10-18')
  assert.equal(all.json().range.days.length, 3)
  assert.equal(all.json().range.totals.calls, 3)

  // A window before retention is empty rather than an error: the UI can ask for
  // a range the ledger simply has nothing in.
  const before = ask('?from=2026-10-01&to=2026-10-02')
  assert.equal(before.status, 200)
  assert.equal(before.json().range.days.length, 0)
  assert.equal(before.json().range.totals.calls, 0)

  assert.equal(ask('?from=2026-02-30&to=2026-10-18').status, 400)
  assert.equal(ask('?from=2026-10-18&to=2026-10-17').status, 400)

  await service.stop()
})

test('the config route validates, persists and answers with the stored config', async () => {
  const { ctx, service } = await started()
  const probes = { configure: () => {}, view: () => ({ updatedAt: 0, probing: false, intervalSec: 300, providers: [], catalog: { probeable: [] } }) }
  const routes = makeRoutes(ctx, service, probes)
  const config = routes.find((route) => route.path.endsWith('/config'))

  const saved = fakeResponse()
  await config.handler(loopbackRequest('/api/abacus/config', 'POST', { pollIntervalSec: 900, probeIntervalSec: 5, nonsense: true }), saved)
  assert.equal(saved.status, 200)
  // 900 is above the poll bound and 5 is below the probe bound; both are
  // clamped, not accepted.
  assert.equal(saved.json().config.pollIntervalSec, 600)
  assert.equal(saved.json().config.probeIntervalSec, 60)
  assert.equal('nonsense' in saved.json().config, false)
  // The two fields that bounded the ledger are gone; a client that still sends
  // them cannot bring them back.
  assert.equal('retainDays' in saved.json().config, false)
  assert.equal('ledgerMaxKb' in saved.json().config, false)

  const persisted = JSON.parse(readFileSync(join(process.env.DSH_HOME, 'abacus', 'config.json'), 'utf8'))
  assert.equal(persisted.pollIntervalSec, 600)

  const badBody = fakeResponse()
  await config.handler(loopbackRequest('/api/abacus/config', 'POST'), badBody)
  assert.equal(badBody.status, 400)

  await service.stop()
})

test('the probe routes answer with vendor facts and force a sweep on demand', async () => {
  const { ctx, service } = await started()
  const swept = []
  const probes = {
    configure: () => {},
    view: () => ({ updatedAt: 7, probing: false, intervalSec: 300, providers: [{ provider: 'opencode-go' }], catalog: { probeable: ['opencode-go'] } }),
    refresh: async (options) => {
      swept.push(options)
    },
  }
  const routes = makeRoutes(ctx, service, probes)

  const listed = fakeResponse()
  await routes.find((route) => route.path.endsWith('/providers')).handler(loopbackRequest('/api/abacus/providers', 'GET'), listed)
  assert.equal(listed.status, 200)
  assert.equal(listed.json().providers.providers[0].provider, 'opencode-go')

  const forced = fakeResponse()
  await routes.find((route) => route.path.endsWith('/probe')).handler(loopbackRequest('/api/abacus/probe', 'POST'), forced)
  assert.equal(forced.status, 200)
  // A manual probe is a forced one: it ignores the enabled gate and the cadence.
  assert.deepEqual(swept, [{ force: true }])

  // The read route is GET-only and the sweep is POST-only.
  assert.equal((await answer(routes, loopbackRequest('/api/abacus/providers', 'POST'), fakeResponse())).status, 405)
  assert.equal((await answer(routes, loopbackRequest('/api/abacus/probe', 'GET'), fakeResponse())).status, 405)

  await service.stop()
})

test('saving a config re-arms the probe cadence without a restart', async () => {
  const { ctx, service } = await started()
  const configured = []
  const probes = { configure: (config) => configured.push(config), view: () => ({ providers: [] }), refresh: async () => {} }
  const routes = makeRoutes(ctx, service, probes)

  const saved = fakeResponse()
  await routes.find((route) => route.path.endsWith('/config')).handler(
    loopbackRequest('/api/abacus/config', 'POST', { probeEnabled: false, probeIntervalSec: 120 }),
    saved,
  )
  assert.equal(saved.status, 200)
  assert.equal(configured.length, 1, 'the probe service is reconfigured on save')
  assert.equal(configured[0].probeEnabled, false)
  assert.equal(configured[0].probeIntervalSec, 120)

  await service.stop()
})

test('a disabled plugin folds nothing', async () => {
  const { ctx, service } = await started({ enabled: false })
  emit(ctx, 's1', settlement({ seq: 1 }))
  assert.equal(service.overview().usage.today.totals.calls, 0)
  await service.stop()
})

test('the document is written atomically and reloads with the same totals', async () => {
  const first = await started()
  emit(first.ctx, 's1', settlement({ seq: 1 }))
  emit(first.ctx, 's1', settlement({ seq: 2, turn: 1, step: 2 }))
  await first.service.stop()

  const path = join(first.home, 'abacus', 'usage.json')
  const written = JSON.parse(readFileSync(path, 'utf8'))
  assert.equal(written.sessions.s1.totals.calls, 2)
  assert.equal(written.sessions.s1.lastSeq, 2)

  // A second service over the same home sees the same numbers.
  const second = await started(undefined, first.home)
  await second.service.loadPersisted()
  assert.equal(second.service.session('s1').totals.calls, 2)
  assert.equal(second.service.overview().usage.today.totals.calls, 2)
  await second.service.stop()
})

test('the rename adopts the pre-2.0.0 state directory, once, and never merges', async () => {
  const first = await started()
  emit(first.ctx, 's1', settlement({ seq: 1 }))
  await first.service.stop()

  // Recreate the 1.1.0 layout: `$DSH_HOME/usage-stat`, no `abacus` beside it.
  renameSync(join(first.home, 'abacus'), join(first.home, 'usage-stat'))
  assert.equal(existsSync(join(first.home, 'abacus')), false)

  const second = await started(undefined, first.home)
  assert.equal(second.service.adoptedLegacyState, true)
  assert.equal(second.service.session('s1').totals.calls, 1, 'the old ledger must be inherited')
  // The old directory stays as a backup; the copy is what the plugin now owns.
  assert.equal(existsSync(join(first.home, 'usage-stat', 'usage.json')), true)
  await second.service.stop()
  assert.equal(existsSync(join(first.home, 'abacus', 'usage.json')), true)

  // A later boot must not re-adopt (and so must not resurrect stale numbers),
  // and a ledger already under the new name is never merged with the backup.
  const third = await started(undefined, first.home)
  assert.equal(third.service.adoptedLegacyState, false)
  assert.equal(third.service.session('s1').totals.calls, 1)
  await third.service.stop()
})

test('the provider list keeps live and recorded routes and hides the dormant catalog', async () => {
  // Its own home: a ledger left behind by an earlier test would make this
  // test's low sequence numbers look like replays and be ignored.
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-abacus-test-'))
  const ctx = fakeContext({
    llm: {
      listProviders: () => [{ id: 'opencode-go', name: 'opencode-go' }],
      listConfigurableProviders: () => [
        { provider: 'deepseek', displayName: 'DeepSeek' },
        { provider: 'groq', displayName: 'Groq' },
      ],
    },
  })
  const service = new UsageService(ctx)
  await service.start()
  // The scan `start()` kicks off runs behind the live fold, and an event that
  // lands while it walks is held until it ends. Wait for it here so the
  // settlement below is folded straight away instead of queued.
  await service.backfill()

  // Live routes are always listed, and a runtime name that merely repeats the
  // route key is replaced by the fallback table's legible name.
  const overview = service.overview()
  assert.deepEqual(overview.providers.map((row) => row.id), ['opencode-go'])
  assert.equal(overview.providers[0].displayName, 'OpenCode Go')
  assert.equal(overview.providers[0].live, true)

  // A dormant route appears once the ledger has recorded it.
  emit(ctx, 's1', settlement({ seq: 1, provider: 'deepseek', model: 'deepseek-flash' }))
  const withUsage = service.overview().providers.map((row) => row.id).sort()
  assert.deepEqual(withUsage, ['deepseek', 'opencode-go'])
  assert.equal(service.overview().providers.find((row) => row.id === 'deepseek').displayName, 'DeepSeek')
  assert.equal(service.overview().providers.find((row) => row.id === 'deepseek').live, false)

  // The raw catalog is available for a view that must name unconfigured routes.
  assert.deepEqual(service.listProviders(service.overview().usage.today.date, { includeDormant: true }).map((row) => row.id).sort(), ['deepseek', 'groq', 'opencode-go'])

  await service.stop()
})

test('the overview carries the reminders its injected provider reports', async () => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-abacus-test-'))
  const reminder = { provider: 'opencode-go', displayName: 'OpenCode Go', kind: 'window', window: 'week', percent: 95, remaining: 5, threshold: 10 }
  const service = new UsageService(fakeContext(), undefined, { alerts: () => [reminder] })
  await service.start()

  assert.deepEqual(service.overview().alerts, [reminder])

  await service.stop()
})

test('a reminder provider that throws cannot take the overview down with it', async () => {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-abacus-test-'))
  const service = new UsageService(fakeContext(), undefined, {
    alerts: () => {
      throw new Error('the probe half is not up yet')
    },
  })
  await service.start()

  const overview = service.overview()
  assert.deepEqual(overview.alerts, [])
  // The ledger half is unaffected: the numbers are still there.
  assert.equal(overview.usage.today.totals.calls, 0)
  assert.ok(overview.providers !== undefined)

  await service.stop()
})

test('a service built without a reminder provider reports an empty list', async () => {
  const { service } = await started()
  assert.deepEqual(service.overview().alerts, [])
  await service.stop()
})

test('folds each settlement into the hour it happened in', async () => {
  // The day map is the ledger; the hour map is the same fold at a finer key.
  // Both come out of one `applySample`, so they cannot disagree.
  const root = sessionsRoot({})
  const { ctx, service } = await started(undefined, undefined, { sessionsDir: root })
  emit(ctx, 's1', settlement({ seq: 1, turn: 1, step: 1, time: localTime(9) }))
  emit(ctx, 's1', settlement({ seq: 2, turn: 1, step: 2, time: localTime(9) }))
  emit(ctx, 's1', settlement({ seq: 3, turn: 1, step: 3, time: localTime(14) }))

  const hours = service.hourView(localDateKey(localTime(9)))
  assert.deepEqual(hours.hours.map((row) => row.hour), [9, 14])
  assert.equal(hours.hours[0].totals.calls, 2)
  assert.equal(hours.hours[1].totals.calls, 1)
  assert.equal(hours.available, true)

  // The invariant the two maps are held to: a day is exactly its hours.
  const day = service.day(localDateKey(localTime(9))).totals
  const summed = hours.hours.reduce((acc, row) => acc + row.totals.calls, 0)
  assert.equal(day.calls, summed)
  assert.equal(day.inputTokens, hours.hours.reduce((acc, row) => acc + row.totals.inputTokens, 0))
  await service.stop()
})

test('a ledger written before hour buckets rebuilds them from the session logs', async () => {
  // The upgrade path: an existing ledger has days but no hours, and a day
  // bucket cannot say what time of day a call happened. The logs can.
  const root = sessionsRoot({
    'session-old': [
      logged({ seq: 1, turn: 1, step: 1, time: localTime(8, 1) }),
      logged({ seq: 2, turn: 1, step: 2, time: localTime(16, 1) }),
    ],
  })
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-abacus-test-'))
  const home = process.env.DSH_HOME
  const stateDir = join(home, 'abacus')
  mkdirSync(stateDir, { recursive: true })
  const yesterday = localDateKey(localTime(8, 1))
  // A ledger from the previous version: day buckets, a bookmark, no hours.
  writeFileSync(join(stateDir, 'usage.json'), JSON.stringify({
    version: 1,
    days: { [yesterday]: { 'opencode-go': { 'deepseek-v4.1-flash': { inputTokens: 200, outputTokens: 20, calls: 2 } } } },
    sessions: { 'session-old': { totals: { inputTokens: 200, outputTokens: 20, calls: 2 }, updatedAt: 1, providers: {}, lastSeq: 2 } },
    samples: {},
    history: { atMs: 1, files: 1, events: 2 },
  }))

  const ctx = fakeContext()
  const service = new UsageService(ctx, undefined, { sessionsDir: root })
  await service.start()
  // `start()` kicks the replay off in the background on purpose; the rebuild is
  // part of it, so the test waits for the same shared scan.
  await service.backfill()

  const hours = service.hourView(yesterday)
  assert.equal(hours.available, true)
  // The hours come from the events' own timestamps, not from when the rebuild
  // ran — which is the whole reason the logs are read instead of the day bucket
  // being smeared over the clock.
  assert.deepEqual(hours.hours.map((row) => row.hour), [8, 16])
  assert.equal(hours.hours.reduce((acc, row) => acc + row.totals.calls, 0), 2)
  // And the rebuild did not touch the day map it was derived from.
  assert.equal(service.day(yesterday).totals.calls, 2)
  assert.equal(service.day(yesterday).totals.inputTokens, 200)

  // The rebuild is one-time: the bookmark is written, so a second start does
  // not walk every log again.
  await service.stop()
  const written = JSON.parse(readFileSync(join(stateDir, 'usage.json'), 'utf8'))
  assert.ok(typeof written.hoursBuiltAt === 'number')
  assert.equal(written.hours[`${yesterday}T08`]['opencode-go']['deepseek-v4.1-flash'].calls, 1)
})

test('a single-day range carries the hour breakdown and a longer one does not', async () => {
  const root = sessionsRoot({})
  const { ctx, service } = await started(undefined, undefined, { sessionsDir: root })
  const today = localDateKey(localTime(11))
  emit(ctx, 's1', settlement({ seq: 1, turn: 1, step: 1, time: localTime(11) }))
  emit(ctx, 's1', settlement({ seq: 2, turn: 1, step: 2, time: localTime(11, 1) }))

  const oneDay = service.rangeView(today, today)
  assert.deepEqual(oneDay.hours.hours.map((row) => row.hour), [11])
  assert.equal(oneDay.hours.date, today)

  // A window that cannot be charted across the clock does not pay for the data.
  const wider = service.rangeView('', '')
  assert.equal(wider.hours, undefined)
  await service.stop()
})


test('the range view converts its tokens to money at the price table', async () => {
  const { ctx, service } = await started()
  emit(ctx, 's1', settlement({ seq: 1, turn: 1, step: 1, time: new Date('2026-10-16T10:00:00').getTime() }))
  emit(ctx, 's1', settlement({ seq: 2, turn: 2, step: 2, time: new Date('2026-10-17T10:00:00').getTime(), model: 'gpt-5.6-luna' }))
  const routes = makeRoutes(ctx, service)
  const range = routes.find((route) => route.path.endsWith('/range'))

  const res = fakeResponse()
  range.handler(loopbackRequest('/api/abacus/range?from=&to='), res)
  assert.equal(res.status, 200)
  const cost = res.json().range.cost

  // The default fixture bills 100 in, 10 out and 1000 cached read tokens. The
  // built-in flash row is DeepSeek's off-peak rate (1 / 4 / 0.02 per million),
  // which is 100 + 40 + 20 per million, and 2026-10-16 is a Friday with the call
  // at 10:00 — inside DeepSeek's 09:00-12:00 peak window — so the row bills it at
  // twice that: 320 per million. Written as the expression rather than the literal
  // so the test does not depend on how a decimal rounds through binary floating
  // point.
  assert.equal(cost.currency, 'CNY')
  assert.equal(cost.total, 320 / 1_000_000)
  assert.equal(cost.tokens, 2220)
  assert.equal(cost.pricedTokens, 1110)
  assert.equal(cost.unpricedTokens, 1110)
  // luna has no published price, so it is named rather than billed at zero.
  assert.equal(cost.unpricedCount, 1)
  assert.deepEqual(cost.unpriced, [{ model: 'gpt-5.6-luna', tokens: 1110 }])
  const models = cost.providers[0].models
  assert.deepEqual(models.map((row) => [row.model, row.priced]), [
    ['deepseek-v4.1-flash', true],
    ['gpt-5.6-luna', false],
  ])
  assert.equal(models[1].cost, 0)

  // Each day carries its own money as well as its own tokens, which is what lets
  // the cost tab chart a window day by day instead of only converting the total.
  const days = res.json().range.days
  assert.deepEqual(days.map((row) => row.date), ['2026-10-16', '2026-10-17'])
  assert.equal(days[0].cost.total, 320 / 1_000_000)
  // The unpriced day reports what it could not count rather than billing zero.
  assert.equal(days[1].cost.total, 0)
  assert.equal(days[1].cost.unpricedTokens, 1110)

  await service.stop()
})

test('a single-day range carries the money for each hour', async () => {
  const { ctx, service } = await started()
  const day = new Date('2026-10-16T00:00:00')
  const at = (hour) => {
    const stamp = new Date(day)
    stamp.setHours(hour, 0, 0, 0)
    return stamp.getTime()
  }
  emit(ctx, 's1', settlement({ seq: 1, turn: 1, step: 1, time: at(9) }))
  // 13:00 rather than 15:00 on purpose: 09:00-12:00 and 14:00-18:00 are the peak
  // windows, so 13:00 is the one hour between them that bills at the off-peak
  // rate. One peak hour and one off-peak hour is what makes this test say
  // something about the clock.
  emit(ctx, 's1', settlement({ seq: 2, turn: 2, step: 2, time: at(13), usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0 } }))
  const routes = makeRoutes(ctx, service)
  const range = routes.find((route) => route.path.endsWith('/range'))

  const res = fakeResponse()
  range.handler(loopbackRequest('/api/abacus/range?from=2026-10-16&to=2026-10-16'), res)
  const hours = res.json().range.hours

  assert.equal(hours.date, '2026-10-16')
  assert.deepEqual(hours.hours.map((row) => row.hour), [9, 13])
  assert.equal(hours.hours[0].cost.total, 320 / 1_000_000)
  assert.equal(hours.hours[1].cost.total, 280 / 1_000_000)
  // The day's own conversion is the same money the range carries, so the two
  // numbers on the screen can never disagree.
  assert.equal(hours.cost.total, res.json().range.cost.total)
  // And it is exactly its two hours added up, peak hour and off-peak hour alike.
  assert.equal(hours.cost.total, hours.hours[0].cost.total + hours.hours[1].cost.total)

  await service.stop()
})

test('correcting a price changes the money reported for calls that already happened', async () => {
  // This is the whole reason money is a view and not a stored field: a user who
  // fixes a wrong price expects the fix to apply to the history behind it.
  const { ctx, service } = await started()
  emit(ctx, 's1', settlement({ seq: 1, turn: 1, step: 1, time: new Date('2026-10-16T10:00:00').getTime() }))
  const probes = { configure: () => {}, view: () => ({ updatedAt: 0, probing: false, intervalSec: 300, providers: [], catalog: { probeable: [] } }) }
  const routes = makeRoutes(ctx, service, probes)
  const range = routes.find((route) => route.path.endsWith('/range'))
  const config = routes.find((route) => route.path.endsWith('/config'))
  const money = () => {
    const res = fakeResponse()
    range.handler(loopbackRequest('/api/abacus/range?from=&to='), res)
    return res.json().range.cost.total
  }

  // Peak-priced: 2026-10-16 is a Friday and the call is at 10:00, inside the
  // 09:00-12:00 window, so the built-in row bills double the off-peak rate.
  assert.equal(money(), 320 / 1_000_000)

  const saved = fakeResponse()
  await config.handler(loopbackRequest('/api/abacus/config', 'POST', {
    prices: { 'deepseek-v4.1-flash': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } },
  }), saved)
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.json().config.prices, {
    // `offPeak: false` because this row is the user's: a typed price is a flat
    // number, so replacing the built-in row also drops its peak rate. Undated, so
    // it replaces that row from the start rather than adding a later one.
    'deepseek-v4.1-flash': [{ from: '', input: 1, output: 1, cacheRead: 1, cacheWrite: 1, offPeak: false }],
  })

  // A different table, different money, with no new call in between: 100 in + 10
  // out + 1000 cached read at 1 each, and no peak rate on a row the user typed.
  assert.equal(money(), 1110 / 1_000_000)

  await service.stop()
})

test('a log that only repeats another session is left out of the fold', async () => {
  // DSH writes a whole-session copy when a side conversation is opened. Its
  // settlements are already in the parent's log, and the replay guard is keyed
  // on the session id, so folding it counts the parent's calls twice — which is
  // how a ledger ends up reporting tokens nobody spent.
  const at = localTime(9)
  const root = sessionsRoot({
    'session-parent': [
      logged({ seq: 1, turn: 1, step: 1, time: at }),
      logged({ seq: 2, turn: 1, step: 2, time: at + 60_000 }),
    ],
    'session-copy': [logged({ seq: 1, turn: 1, step: 1, time: at })],
  })
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-abacus-test-'))

  const ctx = fakeContext()
  const service = new UsageService(ctx, undefined, { sessionsDir: root })
  await service.start()
  await service.backfill()

  const totals = service.day(localDateKey(at)).totals
  assert.equal(totals.calls, 2)
  assert.equal(totals.inputTokens, 200)
  await service.stop()
})

test('a log that repeats a prefix and then adds its own calls is folded once', async () => {
  // The copy that `withoutReplays` deliberately keeps: its settlements are not a
  // subset, because it goes on to make a call of its own. Dropping the log would
  // lose that call; keeping it whole would fold the copied prefix a second time.
  // So the fold de-duplicates by settlement, not by log, and the replay guard
  // cannot help here — that guard is keyed on the session id and the copy has its
  // own.
  const at = localTime(9)
  const root = sessionsRoot({
    'session-parent': [
      logged({ id: 'm1', seq: 1, turn: 1, step: 1, time: at }),
      logged({ id: 'm2', seq: 2, turn: 1, step: 2, time: at + 60_000 }),
    ],
    'session-child': [
      // The parent's first call, written down again under the same message id.
      logged({ id: 'm1', seq: 1, turn: 1, step: 1, time: at }),
      // ...and one of its own.
      logged({ id: 'm3', seq: 2, turn: 9, step: 1, time: at + 120_000 }),
    ],
  })
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-abacus-test-'))

  const ctx = fakeContext()
  const service = new UsageService(ctx, undefined, { sessionsDir: root })
  await service.start()
  await service.backfill()

  // Three settlements were spent; three were recorded.
  const totals = service.day(localDateKey(at)).totals
  assert.equal(totals.calls, 3)
  await service.stop()
})

test('a ledger that already counted a copied log is rebuilt once', async () => {
  // The upgrade path. A ledger written before the check existed holds the copies
  // too, and a day bucket cannot be told which of its calls were copies after the
  // fact, so the only honest fix is to rebuild it from the logs.
  const at = localTime(9)
  const root = sessionsRoot({
    'session-parent': [
      logged({ seq: 1, turn: 1, step: 1, time: at }),
      logged({ seq: 2, turn: 1, step: 2, time: at + 60_000 }),
    ],
    'session-copy': [logged({ seq: 1, turn: 1, step: 1, time: at })],
  })
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-abacus-test-'))
  const home = process.env.DSH_HOME
  const stateDir = join(home, 'abacus')
  mkdirSync(stateDir, { recursive: true })
  const day = localDateKey(at)
  writeFileSync(join(stateDir, 'usage.json'), JSON.stringify({
    version: 1,
    days: { [day]: { 'opencode-go': { 'deepseek-v4.1-flash': { inputTokens: 300, outputTokens: 30, calls: 3 } } } },
    hours: {},
    sessions: {},
    samples: {},
    history: { atMs: 1, files: 2, events: 3 },
    hoursBuiltAt: 1,
  }))

  const ctx = fakeContext()
  const service = new UsageService(ctx, undefined, { sessionsDir: root })
  await service.start()
  await service.backfill()

  // Two calls, not three: the copy's repeat of the first one is gone.
  assert.equal(service.day(day).totals.calls, 2)
  assert.equal(service.day(day).totals.inputTokens, 200)

  await service.stop()
  const written = JSON.parse(readFileSync(join(stateDir, 'usage.json'), 'utf8'))
  // The bookmark is what keeps the rebuild one-time.
  assert.ok(typeof written.replayGuardAt === 'number')
  assert.equal(written.sessions['session-copy'], undefined)
  assert.equal(written.sessions['session-parent'].lastSeq, 2)
})
test('a settlement that lands mid-scan is folded after the scan, not into its way', async () => {
  // The startup order is: subscribe, load the ledger, then walk the logs. A live
  // settlement can land inside that walk. Folding it immediately would move the
  // session's replay guard past everything the scan has not reached yet, and the
  // scan would then skip the whole log as "already counted" — silently losing
  // every call the live stream never saw, which is the only reason to walk it.
  const log = [1, 2, 3, 4, 5].map((seq) => settlement({ seq, turn: seq, step: 1 }))
  const root = sessionsRoot({ 'session-a': log })
  const { service } = await started(undefined, undefined, { sessionsDir: root })

  const scan = service.backfill({ force: true })
  // Arrives while the scan is in flight, and numbered past everything in the log.
  service.onSessionEvent({ id: 'session-a' }, settlement({ seq: 99, turn: 99, step: 1 }))
  await scan

  const today = localDateKey(Date.now())
  const totals = service.day(today).totals
  // Six calls: the five in the log and the live one. Before the fix this was one.
  assert.equal(totals.calls, 6)
  assert.equal(totals.inputTokens, 600)
  // And the guard still holds: the log's copies were not folded twice.
  assert.equal(service.doc.sessions['session-a'].lastSeq, 99)
})