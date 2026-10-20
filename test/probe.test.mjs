/**
 * Host-side tests for the vendor probes.
 *
 * Three modules are covered here because they are the ones that talk to the
 * outside world and therefore the ones whose failures are hardest to see: the
 * adapter table (what to call and how to read the answer), credential
 * resolution (who to call as), and the probe service (when to call, and what to
 * do with an answer that never came).
 *
 * No network is touched: every test injects a `fetchImpl` and a fake context.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'

import {
  BALANCE_ADAPTERS,
  PLAN_ADAPTERS,
  balanceAdapterFor,
  balanceAppliesToRoute,
  clampPercent,
  money,
  originOf,
  planAdapterFor,
  probeableRoutes,
  providerErrorMessage,
  toIso,
  toNum,
  usedPercent,
} from '../lib/core/adapters.js'
import {
  apiKeyEnvFor,
  isDeepSeekRoute,
  isKeySegment,
  isRefName,
  readNamespace,
  resolveCredential,
} from '../lib/host/credentials.js'
import { ProbeService } from '../lib/host/probe-service.js'

const HOMES = []

/** A fresh state directory that is removed when the run ends. */
function stateDir() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-abacus-probe-'))
  HOMES.push(dir)
  return dir
}

after(() => {
  for (const dir of HOMES) rmSync(dir, { recursive: true, force: true })
})

//#region ------------------------------------------------------------- harness

/**
 * A fake plugin context.
 *
 * `namespaces` answers the settings service, `records` the credential records
 * and `refs` the named references — the three lookups the real host performs,
 * in the order the code performs them.
 */
function fakeContext({ namespaces = {}, records = {}, refs = {} } = {}) {
  const credentials = {
    async readRecord(key) {
      return records[key]
    },
    async resolve(name) {
      const value = refs[name]
      return value === undefined ? undefined : { value, source: name }
    },
  }
  return {
    get(service) {
      if (service === 'credentials') return credentials
      if (service === 'settings') return { get: (namespace) => namespaces[namespace] }
      return undefined
    },
    root: { loader: { entries: () => [] } },
  }
}

/** A fake `fetch` that answers from a table and records every request. */
function fakeFetch(answers = {}) {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, headers: options?.headers ?? {} })
    const answer = answers[url] ?? answers['*'] ?? { status: 200, body: {} }
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      async json() {
        if (answer.unparsed === true) throw new Error('not json')
        return answer.body
      },
    }
  }
  return { fetchImpl, calls }
}

/**
 * The real host's shape for the OpenCode Go route: the key lives in an ambient
 * reference that the `llm-pi-ai` profile names. Without both halves the route
 * resolves to no credential, which is exactly how the plugin sees an
 * unconfigured provider.
 */
function opencodeContext() {
  return fakeContext({
    namespaces: { 'llm-pi-ai': { providers: { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } } } },
    refs: { OPENCODE_GO_API_KEY: 'k' },
  })
}

/** A service wired to a fake clock and a fake network. */
function service({ ctx, answers, routes = [], config, now } = {}) {
  const { fetchImpl, calls } = fakeFetch(answers)
  const instance = new ProbeService({
    ctx: ctx ?? fakeContext(),
    stateDir: stateDir(),
    ledgerRoutes: () => routes,
    fetchImpl,
    now: now ?? (() => 1_700_000_000_000),
  })
  if (config !== undefined) instance.configure(config)
  return { instance, calls }
}

//#endregion

//#region ------------------------------------------------------------- adapters

test('the scalar helpers refuse what they cannot read instead of guessing', () => {
  assert.equal(toNum(3), 3)
  assert.equal(toNum('3'), 3, 'a numeric string from a JSON body is a number')
  assert.equal(toNum(''), undefined)
  assert.equal(toNum('nope'), undefined)
  assert.equal(toNum(NaN), undefined)
  assert.equal(toNum(undefined), undefined)

  assert.equal(money(12.3), '12.30')
  assert.equal(money(0), '0.00')

  assert.equal(clampPercent(0), 0)
  assert.equal(clampPercent(41.5), 41.5)
  assert.equal(clampPercent(120), 100, 'a share above 100 is clamped, not printed')
  assert.equal(clampPercent(-4), 0)
  assert.equal(clampPercent('41'), 41)

  assert.equal(usedPercent(25, 100), 25)
  assert.equal(usedPercent(41, undefined), 41, 'a bare percent needs no limit')
  assert.equal(usedPercent(0, 0), 0, 'a zero limit falls back to the bare percent')
  assert.equal(usedPercent('nope', 100), undefined)
})

test('an epoch in seconds and one in milliseconds both become the same instant', () => {
  const seconds = 1_765_000_000
  assert.equal(toIso(seconds), new Date(seconds * 1000).toISOString())
  assert.equal(toIso(seconds * 1000), new Date(seconds * 1000).toISOString())
  assert.equal(toIso('2026-10-19T00:00:00.000Z'), '2026-10-19T00:00:00.000Z')
  assert.equal(toIso(undefined), undefined)
  assert.equal(toIso('not a date'), undefined)
})

test('a provider error is quoted from the body, capped, and never blank', () => {
  assert.equal(providerErrorMessage(429, { error: { message: 'slow down' } }), 'HTTP 429: slow down')
  assert.equal(providerErrorMessage(500, { message: 'boom' }), 'HTTP 500: boom')
  assert.equal(providerErrorMessage(503, undefined), 'HTTP 503')
  // A long vendor message is cut, and the cut is visible.
  const long = providerErrorMessage(400, { error: { message: 'x'.repeat(400) } })
  assert.equal(long.length, 'HTTP 400: '.length + 120 + 1)
  assert.ok(long.endsWith('…'))
})

test('the origin gate only binds adapters that name an origin', () => {
  assert.equal(originOf('https://api.deepseek.com/user/balance'), 'https://api.deepseek.com')
  assert.equal(originOf('nonsense'), undefined)

  const deepseek = balanceAdapterFor('deepseek')
  assert.equal(balanceAppliesToRoute(deepseek, undefined), true, 'an unset base URL means the official one')
  assert.equal(balanceAppliesToRoute(deepseek, 'https://api.deepseek.com/v1'), true)
  assert.equal(balanceAppliesToRoute(deepseek, 'https://reseller.example.com/v1'), false)

  const openrouter = balanceAdapterFor('openrouter')
  assert.equal(balanceAppliesToRoute(openrouter, 'https://reseller.example.com/v1'), true, 'no origin, no gate')
})

test('the adapter table is keyed by route and every entry can parse something', () => {
  assert.equal(balanceAdapterFor('deepseek-official'), BALANCE_ADAPTERS['deepseek-official'])
  assert.equal(planAdapterFor('zai-coding-cn'), PLAN_ADAPTERS['zai-coding-cn'])
  assert.equal(balanceAdapterFor('nobody'), undefined)
  assert.equal(planAdapterFor('nobody'), undefined)

  const probeable = probeableRoutes()
  assert.ok(probeable.includes('opencode-go'))
  assert.ok(probeable.includes('deepseek'))
  assert.equal(new Set(probeable).size, probeable.length, 'no route is listed twice')
})

test('a DeepSeek balance is read from balance_infos[0]', () => {
  const adapter = balanceAdapterFor('deepseek')
  assert.deepEqual(adapter.parse({ balance_infos: [{ currency: 'CNY', total_balance: '12.34' }] }), {
    currency: 'CNY',
    totalBalance: '12.34',
  })
  assert.equal(adapter.parse({ balance_infos: [] }), null)
  assert.equal(adapter.parse({}), null)
})

test('OpenRouter reports spendable credits as total minus usage', () => {
  const adapter = balanceAdapterFor('openrouter')
  assert.deepEqual(adapter.parse({ data: { total_credits: 20, total_usage: 7.5 } }), {
    currency: 'USD',
    totalBalance: '12.50',
  })
  assert.deepEqual(adapter.parse({ data: { total_credits: 20 } }), { currency: 'USD', totalBalance: '20.00' })
  assert.equal(adapter.parse({ data: {} }), null)
})

test('OpenCode Go plan windows keep their order and drop a reset time at zero', () => {
  const plan = planAdapterFor('opencode-go').parse({
    usage: {
      rolling: { percent: 11, resetsAt: '2026-10-17T20:17:33.000Z' },
      weekly: { percent: 41, resets_at: '2026-10-19T00:00:00.000Z' },
      monthly: { percent: 0, resetsAt: '2026-11-12T14:08:30.000Z' },
    },
  })
  assert.deepEqual(plan.windows.map((row) => row.key), ['5h', 'week', 'month'])
  assert.equal(plan.windows[0].percent, 11)
  assert.equal(plan.windows[0].resetsAt, '2026-10-17T20:17:33.000Z')
  assert.equal(plan.windows[1].resetsAt, '2026-10-19T00:00:00.000Z')
  assert.equal(plan.windows[2].resetsAt, undefined, 'a window nobody has touched has nothing to reset')
})

test('the zai endpoints take a bare key, not a bearer token', () => {
  const headers = planAdapterFor('zai').headers({ kind: 'api-key', key: 'abc' })
  assert.equal(headers.authorization, 'abc')
  assert.equal(headers['accept-language'], 'en-US,en')

  // A route with no header override uses the ordinary bearer form.
  assert.equal(planAdapterFor('opencode-go').headers({ key: 'abc' }).authorization, 'Bearer abc')
})

test('Codex carries its account id only when it has one', () => {
  const adapter = planAdapterFor('openai-codex')
  assert.equal(adapter.headers({ key: 'abc' })['chatgpt-account-id'], undefined)
  const withAccount = adapter.headers({ key: 'abc', accountId: 'acc-1' })
  assert.equal(withAccount['chatgpt-account-id'], 'acc-1')
  assert.equal(withAccount['user-agent'], 'codex-cli')
})

//#endregion

//#region ---------------------------------------------------------- credentials

test('the credential grammar is checked before a name is used as one', () => {
  assert.equal(isRefName('OPENCODE_GO_API_KEY'), true)
  assert.equal(isRefName('1BAD'), false)
  assert.equal(isRefName('has-dash'), false)
  assert.equal(isRefName(undefined), false)

  assert.equal(isKeySegment('opencode-go'), true)
  assert.equal(isKeySegment('deepseek-v4.1-flash'), false, 'a model id is not a route segment')
  assert.equal(isKeySegment('Upper'), false)
})

test('a namespace is read from the settings service before the loader', () => {
  const ctx = fakeContext({ namespaces: { 'llm-pi-ai': { providers: { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } } } } })
  assert.deepEqual(readNamespace(ctx, 'llm-pi-ai').providers['opencode-go'], { apiKeyEnv: 'OPENCODE_GO_API_KEY' })
  assert.equal(readNamespace(ctx, 'nobody'), undefined)
  assert.equal(readNamespace(undefined, 'llm-pi-ai'), undefined, 'a context without services reads as unconfigured')
})

test('the reference name comes from the route profile, then from the DeepSeek default', () => {
  const ctx = fakeContext({ namespaces: { 'llm-pi-ai': { providers: { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } } } } })
  assert.equal(apiKeyEnvFor(ctx, 'opencode-go'), 'OPENCODE_GO_API_KEY')
  assert.equal(apiKeyEnvFor(ctx, 'kimi-coding'), undefined)
  assert.equal(apiKeyEnvFor(ctx, 'deepseek-official'), 'DEEPSEEK_API_KEY', 'the official route has a default name')
  assert.equal(isDeepSeekRoute('deepseek'), true)
  assert.equal(isDeepSeekRoute('deepseek-v4'), false)
})

test('a credential record wins over the ambient reference', async () => {
  const ctx = fakeContext({
    namespaces: { 'llm-pi-ai': { providers: { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } } } },
    records: { 'llm-pi-ai/opencode-go': { kind: 'api-key', key: 'from-record' } },
    refs: { OPENCODE_GO_API_KEY: 'from-env' },
  })
  assert.deepEqual(await resolveCredential(ctx, 'opencode-go'), { kind: 'api-key', key: 'from-record', source: 'record' })
})

test('a grant becomes an OAuth credential with its account id', async () => {
  const ctx = fakeContext({
    records: { 'llm-pi-ai/openai-codex': { kind: 'grant', payload: { access: 'oauth-token', chatgpt_account_id: 'acc-9' } } },
  })
  assert.deepEqual(await resolveCredential(ctx, 'openai-codex'), {
    kind: 'oauth',
    key: 'oauth-token',
    accountId: 'acc-9',
    source: 'record',
  })
})

test('with no record the ambient reference is resolved, and nothing is a real answer', async () => {
  assert.deepEqual(await resolveCredential(opencodeContext(), 'opencode-go'), {
    kind: 'api-key',
    key: 'k',
    source: 'OPENCODE_GO_API_KEY',
  })

  // The reference is named but unset: unset is not a credential.
  const unset = fakeContext({ namespaces: { 'llm-pi-ai': { providers: { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } } } } })
  assert.deepEqual(await resolveCredential(unset, 'opencode-go'), { kind: 'none' })

  // A route with no profile and no default reference name has no way to resolve.
  assert.deepEqual(await resolveCredential(fakeContext({ refs: { OPENCODE_GO_API_KEY: 'k' } }), 'opencode-go'), { kind: 'none' })

  const noService = { get: () => undefined }
  assert.deepEqual(await resolveCredential(noService, 'opencode-go'), { kind: 'none' }, 'no credential service is not an error')
})

//#endregion

//#region --------------------------------------------------------- probe service

test('a plan probe folds the vendor windows into a snapshot', async () => {
  const ctx = opencodeContext()
  const { instance, calls } = service({
    ctx,
    answers: {
      'https://opencode.ai/zen/go/v1/usage': {
        status: 200,
        body: { usage: { rolling: { percent: 11 }, weekly: { percent: 41 }, monthly: { percent: 20 } } },
      },
    },
  })

  await instance.refresh({ force: true })

  const snapshot = instance.providers.get('opencode-go')
  assert.equal(snapshot.credential, 'api-key')
  assert.equal(snapshot.credentialSource, 'OPENCODE_GO_API_KEY')
  assert.equal(snapshot.planSupported, true)
  assert.equal(snapshot.balanceSupported, false)
  assert.equal(snapshot.balanceError, 'unsupported', 'no balance endpoint is a stated fact, not a silence')
  assert.deepEqual(snapshot.plan.windows.map((row) => row.key), ['5h', 'week', 'month'])
  assert.equal(calls.length, 1)
  assert.equal(calls[0].headers.authorization, 'Bearer k')
})

test('an OAuth credential is not sent to a balance endpoint', async () => {
  const ctx = fakeContext({
    records: { 'llm-pi-ai/deepseek-official': { kind: 'grant', payload: { access: 'oauth-token' } } },
  })
  const { instance, calls } = service({ ctx })

  await instance.refresh({ force: true })

  const snapshot = instance.providers.get('deepseek-official')
  assert.equal(snapshot.credential, 'oauth')
  assert.equal(snapshot.balanceError, 'oauth-credential')
  assert.equal(snapshot.balance, undefined)
  assert.equal(calls.length, 0, 'the refusal is local: nothing is dialled')
})

test('a configured base URL that is not the vendor origin disables its balance', async () => {
  const ctx = fakeContext({
    namespaces: {
      'llm-pi-ai': { providers: { 'deepseek-official': { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://reseller.example.com/v1' } } },
    },
    refs: { DEEPSEEK_API_KEY: 'k' },
  })
  const { instance, calls } = service({ ctx })

  await instance.refresh({ force: true })

  const snapshot = instance.providers.get('deepseek-official')
  assert.equal(snapshot.balanceSupported, false)
  assert.equal(snapshot.balanceError, 'origin-mismatch')
  // The `deepseek` route shares the ambient reference and has no base URL of its
  // own, so it is still probed; what must never happen is a call to the reseller
  // that was configured for this route.
  assert.equal(calls.some((call) => call.url.includes('reseller')), false)
  assert.equal(instance.providers.get('deepseek').balanceSupported, true)
})

test('a failed probe keeps the last good fact and states the failure', async () => {
  const ctx = opencodeContext()
  const good = { status: 200, body: { usage: { weekly: { percent: 41 } } } }
  const { instance } = service({ ctx, answers: { 'https://opencode.ai/zen/go/v1/usage': good } })

  await instance.refresh({ force: true })
  const first = instance.providers.get('opencode-go')
  assert.equal(first.plan.windows[0].percent, 41)
  assert.equal(first.planError, undefined)

  // The same service, now answering with a failure.
  const { instance: failing } = service({ ctx, answers: { 'https://opencode.ai/zen/go/v1/usage': { status: 503 } } })
  failing.providers.set('opencode-go', first)
  await failing.refresh({ force: true })

  const after = failing.providers.get('opencode-go')
  assert.match(after.planError, /HTTP 503/)
  assert.equal(after.plan.windows[0].percent, 41, 'a stale fact is still a fact; it is shown, with its error')
})

test('losing the credential clears the fact rather than showing a stale one', async () => {
  const ctx = opencodeContext()
  const { instance } = service({ ctx, answers: { 'https://opencode.ai/zen/go/v1/usage': { status: 200, body: { usage: { weekly: { percent: 41 } } } } } })
  await instance.refresh({ force: true })
  assert.ok(instance.providers.get('opencode-go').plan)

  // The reference goes away, but the route stays in the ledger, so it is still
  // visited — and the visit is what discovers the credential is gone.
  const bare = fakeContext({})
  const { instance: revoked } = service({ ctx: bare, routes: ['opencode-go'] })
  revoked.providers.set('opencode-go', instance.providers.get('opencode-go'))
  await revoked.refresh({ force: true })

  const after = revoked.providers.get('opencode-go')
  assert.equal(after.credential, 'none')
  assert.equal(after.planError, 'no-credential')
  assert.equal(after.plan, undefined, 'an unverifiable number must not survive on screen')
})

test('the probe list is the ledger routes plus whatever has a credential', async () => {
  const ctx = opencodeContext()
  const { instance } = service({ ctx, routes: ['opencode-go', 'a-route-without-an-adapter'] })
  const routes = await instance.routesToProbe()
  assert.ok(routes.includes('opencode-go'))
  assert.equal(routes.includes('a-route-without-an-adapter'), false, 'a route with no endpoint is not dialled')
})

test('probeEnabled off stops the cadence but not an explicit request', async () => {
  const ctx = opencodeContext()
  const { instance, calls } = service({ ctx, answers: { 'https://opencode.ai/zen/go/v1/usage': { status: 200, body: { usage: { weekly: { percent: 1 } } } } } })
  instance.configure({ probeEnabled: false })

  await instance.refresh()
  assert.equal(calls.length, 0, 'a disabled cadence makes no calls')

  await instance.refresh({ force: true })
  assert.equal(calls.length, 1, 'the refresh button still works')
})

test('snapshots survive a restart through one atomic write', async () => {
  const dir = stateDir()
  const ctx = opencodeContext()
  const { fetchImpl } = fakeFetch({ 'https://opencode.ai/zen/go/v1/usage': { status: 200, body: { usage: { weekly: { percent: 41 } } } } })

  const first = new ProbeService({ ctx, stateDir: dir, ledgerRoutes: () => ['opencode-go'], fetchImpl, now: () => 42 })
  await first.refresh({ force: true })
  await first.flush()

  const written = JSON.parse(readFileSync(join(dir, 'providers.json'), 'utf8'))
  assert.equal(written.version, 1)
  assert.equal(written.providers['opencode-go'].plan.windows[0].percent, 41)

  const second = new ProbeService({ ctx, stateDir: dir, ledgerRoutes: () => ['opencode-go'], fetchImpl, now: () => 42 })
  await second.start()
  assert.equal(second.providers.get('opencode-go').plan.windows[0].percent, 41)
  assert.equal(second.updatedAt, 42)
  await second.stop()
})

test('a corrupt snapshot file is ignored, not fatal', async () => {
  const dir = stateDir()
  writeFileSync(join(dir, 'providers.json'), '{ not json', 'utf8')
  const instance = new ProbeService({ ctx: fakeContext(), stateDir: dir, ledgerRoutes: () => [], fetchImpl: fakeFetch().fetchImpl })
  await instance.start()
  assert.equal(instance.providers.size, 0)
  assert.equal(instance.loaded, true)
  await instance.stop()
})

test('the view sorts providers by display name and always lists the catalog', async () => {
  const ctx = opencodeContext()
  const { instance } = service({ ctx, answers: { 'https://opencode.ai/zen/go/v1/usage': { status: 200, body: { usage: { weekly: { percent: 1 } } } } } })
  await instance.refresh({ force: true })

  const view = instance.view()
  assert.equal(view.probing, false)
  assert.equal(view.intervalSec, 300)
  assert.equal(view.providers.length, 1)
  assert.equal(view.providers[0].displayName, 'OpenCode Go')
  assert.ok(view.catalog.probeable.length > 1)
  assert.equal(view.updatedAt, 1_700_000_000_000)
})

//#region --------------------------------------------------------------- alerts

test('the probe view carries the reminders the current thresholds arm', async () => {
  const ctx = opencodeContext()
  const { instance } = service({
    ctx,
    answers: { 'https://opencode.ai/zen/go/v1/usage': { status: 200, body: { usage: { weekly: { percent: 95 } } } } },
  })
  instance.configure({ alertWindowWeek: 10 })

  await instance.refresh({ force: true })

  const view = instance.view()
  assert.equal(view.alerts.length, 1)
  assert.equal(view.alerts[0].provider, 'opencode-go')
  assert.equal(view.alerts[0].displayName, 'OpenCode Go')
  assert.equal(view.alerts[0].window, 'week')
  assert.equal(view.alerts[0].remaining, 5)
  assert.equal(view.alerts[0].threshold, 10)
  // The reminder is derived from the same snapshot the view is built from, so
  // it can never describe a reading the numbers next to it do not show.
  assert.equal(view.providers[0].plan.windows[0].percent, 95)
})

test('a threshold of zero leaves the view without reminders', async () => {
  const ctx = opencodeContext()
  const { instance } = service({
    ctx,
    answers: { 'https://opencode.ai/zen/go/v1/usage': { status: 200, body: { usage: { weekly: { percent: 99 } } } } },
  })
  instance.configure({ alertWindowWeek: 0 })

  await instance.refresh({ force: true })

  assert.deepEqual(instance.view().alerts, [])
  assert.deepEqual(instance.alerts(), [])
})

test('re-configuring the thresholds re-judges the facts already held', async () => {
  const ctx = opencodeContext()
  const { instance } = service({
    ctx,
    answers: { 'https://opencode.ai/zen/go/v1/usage': { status: 200, body: { usage: { weekly: { percent: 95 } } } } },
  })
  instance.configure({ alertWindowWeek: 10 })
  await instance.refresh({ force: true })
  assert.equal(instance.alerts().length, 1)

  // Raising the bar past what is left clears it without another probe: the
  // judgement is made on read, not frozen into the snapshot.
  instance.configure({ alertWindowWeek: 3 })
  assert.deepEqual(instance.alerts(), [])
  // And switching the feature off clears it too.
  instance.configure({ alertWindowWeek: 10, alertEnabled: false })
  assert.deepEqual(instance.alerts(), [])
})

//#endregion

