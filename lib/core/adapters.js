/**
 * Remote provider probes: where to ask, how to authenticate, how to read the
 * answer.
 *
 * The balance and plan tabs show facts this plugin cannot compute — how much
 * money an account holds and how much of a subscription window it has burned.
 * Those numbers live behind each vendor's own endpoint, so this module is the
 * one place that knows the wire contract, and it is deliberately split in two
 * halves:
 *
 * - **Data** — the frozen `BALANCE_ADAPTERS` / `PLAN_ADAPTERS` tables: a URL,
 *   a header builder and a parser per provider route.
 * - **Pure functions** — every `parse*` takes a decoded body and returns a
 *   value or `null`. No network, no clock, no `fetch`. That is what makes the
 *   whole contract testable from fixtures, and it is why the probe loop in
 *   `host/probe-service.js` holds no vendor knowledge at all.
 *
 * A parser returns `null` for a body it cannot recognize. The caller turns
 * that into `unrecognized response shape`, which is the honest answer: the
 * endpoint moved, and guessing would print a wrong number with confidence.
 *
 * Adding a provider is one entry plus, at most, one parser. Nothing else in
 * the plugin changes.
 *
 * @module dsh-usage-stat/core/adapters
 */

/** How long a single probe may take before it is abandoned. */
export const PROBE_TIMEOUT_MS = 10_000

/** Provider message excerpt length in an error line. */
const MESSAGE_CAP = 120

/**
 * `Authorization: Bearer …` for a plain API key.
 * @param {{ key?: string }} credential - the resolved credential.
 * @returns {Record<string, string>} request headers.
 */
function bearer(credential) {
  return { authorization: `Bearer ${credential.key ?? ''}` }
}

/**
 * A number, or `undefined` when the value is not a finite number.
 * @param {unknown} value - candidate.
 * @returns {number|undefined} the number.
 */
export function toNum(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/**
 * A non-empty string, or `undefined`.
 * @param {unknown} value - candidate.
 * @returns {string|undefined} the string.
 */
export function str(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * A percentage clamped to 0–100, or `undefined`.
 * @param {unknown} value - candidate.
 * @returns {number|undefined} the percentage.
 */
export function clampPercent(value) {
  const num = toNum(value)
  if (num === undefined) return undefined
  return Math.min(100, Math.max(0, num))
}

/**
 * Two decimal places as a string — the shape every balance endpoint uses for
 * money. Kept as a string so a vendor's own precision survives the round trip.
 * @param {number} value - the amount.
 * @returns {string} the formatted amount.
 */
export function money(value) {
  return value.toFixed(2)
}

/**
 * An ISO timestamp from seconds, milliseconds or an ISO string.
 *
 * Providers disagree about this: some send unix seconds, some milliseconds,
 * some already-formatted ISO text. Anything unreadable becomes `undefined`
 * rather than a wrong instant.
 *
 * @param {unknown} value - candidate timestamp.
 * @returns {string|undefined} an ISO string.
 */
export function toIso(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return undefined
    const parsed = Date.parse(trimmed)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
    const numeric = Number(trimmed)
    if (!Number.isFinite(numeric)) return undefined
    return toIso(numeric)
  }
  const num = toNum(value)
  if (num === undefined || num <= 0) return undefined
  // Anything below this is seconds; providers do not send millisecond stamps
  // for instants this far in the past, so the split is unambiguous.
  const ms = num < 100_000_000_000 ? num * 1000 : num
  const date = new Date(ms)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

/**
 * A percentage consumed, from either "percent used" or "amount / limit".
 * @param {unknown} used - the used amount or percent.
 * @param {unknown} limit - the limit, when the pair form is used.
 * @returns {number|undefined} the percentage.
 */
export function usedPercent(used, limit) {
  const usedNum = toNum(used)
  if (usedNum === undefined) return undefined
  const limitNum = toNum(limit)
  if (limitNum === undefined || limitNum <= 0) return clampPercent(usedNum)
  return clampPercent((usedNum / limitNum) * 100)
}

/**
 * The human-readable tail of a failed probe.
 * @param {number} status - the HTTP status.
 * @param {unknown} body - the decoded body, when there was one.
 * @returns {string} the error line.
 */
export function providerErrorMessage(status, body) {
  const message =
    str(body?.error?.message)
    ?? str(body?.error)
    ?? str(body?.message)
    ?? str(body?.msg)
    ?? str(body?.detail)
  if (message === undefined) return `HTTP ${status}`
  const excerpt = message.length > MESSAGE_CAP ? `${message.slice(0, MESSAGE_CAP)}…` : message
  return `HTTP ${status}: ${excerpt}`
}

/**
 * Build a balance adapter.
 * @param {string} url - the endpoint.
 * @param {(body: any) => {currency: string, totalBalance: string}|null} parse - the parser.
 * @param {{ origin?: string, headers?: (credential: any) => Record<string, string> }} [options] - origin gate and header override.
 * @returns {object} the adapter.
 */
function balanceSpec(url, parse, options = {}) {
  return {
    url,
    origin: options.origin,
    headers: options.headers ?? bearer,
    parse,
  }
}

/**
 * Build a plan adapter.
 * @param {string} url - the endpoint.
 * @param {(body: any) => {planName?: string, windows: Array<object>}|null} parse - the parser.
 * @param {{ headers?: (credential: any) => Record<string, string> }} [options] - header override.
 * @returns {object} the adapter.
 */
function planSpec(url, parse, options = {}) {
  return { url, headers: options.headers ?? bearer, parse }
}

/** `{ currency, totalBalance }` from a pair of already-validated strings. */
function balance(currency, amount) {
  const text = str(amount)
  return text === undefined ? null : { currency, totalBalance: text }
}

/** `{ currency, totalBalance }` from a numeric amount, formatted to 2dp. */
function moneyBalance(currency, amount) {
  const num = toNum(amount)
  return num === undefined ? null : { currency, totalBalance: money(num) }
}

/** DeepSeek's official balance payload: `balance_infos[0]`. */
function parseDeepSeekBalance(body) {
  const info = Array.isArray(body?.balance_infos) ? body.balance_infos[0] : undefined
  if (info === undefined) return null
  return balance(str(info.currency) ?? 'CNY', info.total_balance)
}

/** OpenRouter reports credits and usage separately; the spendable amount is the difference. */
function parseOpenRouterCredits(body) {
  const total = toNum(body?.data?.total_credits)
  if (total === undefined) return null
  const spent = toNum(body?.data?.total_usage) ?? 0
  return balance('USD', money(total - spent))
}

/** A window row, with `resetsAt` only when it means something. */
function window(key, percent, resetsAt, name) {
  const row = { key, percent }
  if (name !== undefined) row.name = name
  if (percent > 0 && resetsAt !== undefined) row.resetsAt = resetsAt
  return row
}

/**
 * OpenCode Go's plan: `usage.rolling/weekly/monthly`.
 * @param {any} body - the decoded body.
 * @returns {object|null} the plan.
 */
function parseOpencodeGoPlan(body) {
  const usage = body?.usage
  if (usage === null || typeof usage !== 'object') return null
  const windows = []
  for (const [field, key] of [['rolling', '5h'], ['weekly', 'week'], ['monthly', 'month']]) {
    const row = usage[field]
    if (row === null || typeof row !== 'object') continue
    const percent = clampPercent(row.percent)
    if (percent === undefined) continue
    windows.push(window(key, percent, toIso(row.resetsAt ?? row.resets_at ?? row.resetAt)))
  }
  if (windows.length === 0) return null
  return { planName: str(body?.planName) ?? str(body?.plan), windows }
}

/** Kimi For Coding: a `limits[]` list plus a top-level weekly bucket. */
function parseKimiPlan(body) {
  const limits = Array.isArray(body?.limits) ? body.limits : []
  const windows = []
  for (const row of limits) {
    if (row === null || typeof row !== 'object') continue
    const duration = toNum(row?.window?.duration)
    const unit = str(row?.window?.timeUnit)
    const key = duration === 300 && unit === 'TIME_UNIT_MINUTE' ? '5h' : undefined
    if (key === undefined) continue
    const percent = usedPercent(row?.used, row?.limit)
    if (percent === undefined) continue
    windows.push(window(key, percent, toIso(row?.resetTime ?? row?.resetsAt)))
  }
  const weekly = body?.usage
  if (weekly !== null && typeof weekly === 'object') {
    const percent = usedPercent(weekly?.used, weekly?.limit)
    if (percent !== undefined) windows.push(window('week', percent, toIso(weekly?.resetTime)))
  }
  if (windows.length === 0) return null
  return { planName: str(body?.user?.membership?.level), windows }
}

/** GLM's unit codes: the vendor's own enum for the window length. */
const ZAI_WINDOW_UNITS = Object.freeze({ 3: '5h', 5: 'month', 6: 'week' })

/** GLM (z.ai / bigmodel): `data.limits[]`, three different limit kinds. */
function parseZaiPlan(body) {
  if (body?.success === false) return null
  const limits = Array.isArray(body?.data?.limits) ? body.data.limits : []
  const windows = []
  for (const row of limits) {
    if (row === null || typeof row !== 'object') continue
    const type = str(row.type)
    // TIME_LIMIT caps the MCP tool call count, not tokens; it is not a plan window.
    if (type === 'TIME_LIMIT') continue
    const key = ZAI_WINDOW_UNITS[toNum(row.unit) ?? -1]
    if (key === undefined) continue
    const percent =
      type === 'CREDIT_LIMIT'
        ? usedPercent(row.currentValue, row.usage)
        : clampPercent(row.percentage)
    if (percent === undefined) continue
    windows.push(window(key, percent, toIso(row.nextResetTime ?? row.resetTime)))
  }
  if (windows.length === 0) return null
  return { planName: str(body?.data?.level), windows }
}

/** MiniMax: the `general` model row carries the coding-plan windows. */
function parseMinimaxPlan(body) {
  const rows = Array.isArray(body?.model_remains) ? body.model_remains : []
  const row = rows.find((candidate) => str(candidate?.model_name) === 'general')
  if (row === undefined) return null
  const windows = []
  const remaining = toNum(row.current_interval_remaining_percent)
  if (remaining !== undefined) {
    windows.push(window('5h', clampPercent(100 - remaining) ?? 0, toIso(row.end_time)))
  }
  if (toNum(row.current_weekly_status) === 1) {
    const weekly = toNum(row.current_weekly_remaining_percent)
    if (weekly !== undefined) {
      windows.push(window('week', clampPercent(100 - weekly) ?? 0, toIso(row.weekly_end_time)))
    }
  }
  if (windows.length === 0) return null
  return { windows }
}

/** Codex reports a window length in seconds; the plan UI keys on names. */
function codexWindowKey(seconds) {
  const num = toNum(seconds)
  if (num === undefined) return undefined
  if (num === 18_000) return '5h'
  if (num === 604_800) return 'week'
  if (num === 2_592_000) return 'month'
  const hours = num / 3600
  if (Number.isInteger(hours)) return `${hours}_hour`
  const days = num / 86_400
  return Number.isInteger(days) ? `${days}_day` : undefined
}

/** Codex's OAuth credential also carries the account to bill. */
function codexHeaders(credential) {
  const headers = {
    authorization: `Bearer ${credential.key ?? ''}`,
    'user-agent': 'codex-cli',
    accept: 'application/json',
  }
  if (str(credential.accountId) !== undefined) headers['chatgpt-account-id'] = credential.accountId
  return headers
}

/** OpenAI Codex: `rate_limit.primary_window` / `secondary_window`. */
function parseCodexPlan(body) {
  const rate = body?.rate_limit
  if (rate === null || typeof rate !== 'object') return null
  const windows = []
  for (const field of ['primary_window', 'secondary_window']) {
    const row = rate[field]
    if (row === null || typeof row !== 'object') continue
    const key = codexWindowKey(row.limit_window_seconds)
    const percent = clampPercent(row.used_percent)
    if (key === undefined || percent === undefined) continue
    windows.push(window(key, percent, toIso(row.reset_at)))
  }
  if (windows.length === 0) return null
  return { planName: str(body?.plan_type), windows }
}

/** GLM authenticates with the bare key and asks for English unit labels. */
function zaiHeaders(credential) {
  return { authorization: credential.key ?? '', 'accept-language': 'en-US,en' }
}

/** Balance adapters by provider route. */
export const BALANCE_ADAPTERS = Object.freeze({
  deepseek: balanceSpec('https://api.deepseek.com/user/balance', parseDeepSeekBalance, {
    // A DeepSeek-compatible reseller can be configured under this route id; the
    // official account's money must not be printed for it.
    origin: 'https://api.deepseek.com',
  }),
  'deepseek-official': balanceSpec('https://api.deepseek.com/user/balance', parseDeepSeekBalance, {
    origin: 'https://api.deepseek.com',
  }),
  'moonshotai-cn': balanceSpec('https://api.moonshot.cn/v1/users/me/balance', (body) =>
    moneyBalance('CNY', body?.data?.available_balance)),
  moonshotai: balanceSpec('https://api.moonshot.ai/v1/users/me/balance', (body) =>
    moneyBalance('USD', body?.data?.available_balance)),
  openrouter: balanceSpec('https://openrouter.ai/api/v1/credits', parseOpenRouterCredits),
  siliconflow: balanceSpec('https://api.siliconflow.cn/v1/user/info', (body) =>
    balance('CNY', body?.data?.totalBalance)),
  'siliconflow-cn': balanceSpec('https://api.siliconflow.cn/v1/user/info', (body) =>
    balance('CNY', body?.data?.totalBalance)),
  'siliconflow-intl': balanceSpec('https://api.siliconflow.com/v1/user/info', (body) =>
    balance('USD', body?.data?.totalBalance)),
  zenmux: balanceSpec('https://zenmux.ai/api/v1/management/payg/balance', (body) =>
    moneyBalance('USD', body?.data?.total_credits)),
})

/** Plan adapters by provider route. */
export const PLAN_ADAPTERS = Object.freeze({
  'opencode-go': planSpec('https://opencode.ai/zen/go/v1/usage', parseOpencodeGoPlan),
  'kimi-coding': planSpec('https://api.kimi.com/coding/v1/usages', parseKimiPlan),
  zai: planSpec('https://api.z.ai/api/monitor/usage/quota/limit', parseZaiPlan, { headers: zaiHeaders }),
  'zai-coding': planSpec('https://api.z.ai/api/monitor/usage/quota/limit', parseZaiPlan, { headers: zaiHeaders }),
  'zai-coding-cn': planSpec('https://open.bigmodel.cn/api/monitor/usage/quota/limit', parseZaiPlan, { headers: zaiHeaders }),
  minimax: planSpec('https://api.minimax.io/v1/api/openplatform/coding_plan/remains', parseMinimaxPlan),
  'minimax-cn': planSpec('https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains', parseMinimaxPlan),
  'openai-codex': planSpec('https://chatgpt.com/backend-api/wham/usage', parseCodexPlan, { headers: codexHeaders }),
})

/**
 * The balance adapter for a route, if the vendor publishes a balance endpoint.
 * @param {string} provider - the route key.
 * @returns {object|undefined} the adapter.
 */
export function balanceAdapterFor(provider) {
  return Object.hasOwn(BALANCE_ADAPTERS, provider) ? BALANCE_ADAPTERS[provider] : undefined
}

/**
 * The plan adapter for a route, if the vendor publishes a plan endpoint.
 * @param {string} provider - the route key.
 * @returns {object|undefined} the adapter.
 */
export function planAdapterFor(provider) {
  return Object.hasOwn(PLAN_ADAPTERS, provider) ? PLAN_ADAPTERS[provider] : undefined
}

/**
 * Every route this plugin can probe, in a stable order.
 * @returns {string[]} route keys.
 */
export function probeableRoutes() {
  return [...new Set([...Object.keys(BALANCE_ADAPTERS), ...Object.keys(PLAN_ADAPTERS)])].sort()
}

/**
 * The origin of a URL, or `undefined` when it is not absolute.
 * @param {unknown} url - candidate URL.
 * @returns {string|undefined} the origin.
 */
export function originOf(url) {
  const text = str(url)
  if (text === undefined) return undefined
  try {
    return new URL(text).origin
  } catch {
    return undefined
  }
}

/**
 * Whether a balance adapter may run for a route configured with `baseURL`.
 *
 * An adapter that declares an `origin` only applies when the route really
 * points at it. Without this gate, a DeepSeek-compatible reseller configured
 * under the `deepseek` route id would print the official account's balance.
 *
 * @param {object|undefined} adapter - the balance adapter.
 * @param {unknown} baseUrl - the route's configured base URL, if any.
 * @returns {boolean} whether the probe is trustworthy.
 */
export function balanceAppliesToRoute(adapter, baseUrl) {
  if (adapter === undefined) return false
  if (adapter.origin === undefined) return true
  const configured = originOf(baseUrl)
  // No configured base URL means the vendor default, which is the adapter's own origin.
  return configured === undefined || configured === adapter.origin
}
