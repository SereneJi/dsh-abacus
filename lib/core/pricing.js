/**
 * Converting tokens to money.
 *
 * The ledger counts tokens and nothing else. Money is a *view* over those
 * counts, computed when someone looks at it — never a field written into a
 * bucket. That is the opposite of what the cost plugins in this ecosystem do,
 * and the reason is the price table: it has to be editable, because most of the
 * models this plugin sees are relay or subscription routes with no published
 * price.
 *
 * Recomputing at read time raises the obvious question: if a provider raises its
 * prices today, does yesterday's money change? It must not. So a price row
 * carries the date it takes effect `from`, and a call is priced by the row that
 * was in force *when it happened* — which is why the hour buckets matter here
 * and not only to the charts: they are the only record of when a call happened,
 * so a window is converted hour by hour. Correcting a row's numbers corrects
 * that row's whole period, which is what a correction means; changing what a
 * model costs means adding a row dated the day the new price starts.
 *
 * Prices are CNY per million tokens at the provider's published list price.
 * Subscription plans and promotional rates are not modelled: the figure is what
 * those tokens would cost at list, and the UI says so rather than pretending to
 * know what was actually billed.
 *
 * A model with no price is *reported*, never silently counted as zero. A total
 * that quietly omits half the tokens is worse than no total at all, so
 * {@link costOfBuckets} carries the unpriced models and their token counts back
 * to the caller and the UI names them.
 *
 * @module dsh-usage-stat/core/pricing
 */

import { localDateKey } from './document.js'
import { isPublicHoliday } from './holidays.js'

/** Prices are quoted per this many tokens. */
export const PRICE_UNIT = 1_000_000

/** The currency every built-in row is quoted in. */
export const CURRENCY = 'CNY'

/** The four classes a price row quotes, in editor order. */
export const PRICE_FIELDS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite'])

/** How many unpriced models a cost breakdown names before it stops listing. */
export const UNPRICED_CAP = 6

/**
 * The built-in rows: DeepSeek's published list price, CNY per million tokens.
 *
 * Only the official family is here, because it is the only one with a published
 * price book. Everything else the user runs is priced by the user, in the
 * settings tab — which is the point of keeping the table editable.
 *
 * These are the OFF-PEAK rates. DeepSeek bills peak hours at twice them, so the
 * rows carry `offPeak: true` and {@link peakFactorOf} doubles the money for a
 * call that happened inside a peak window. A row the user types carries no such
 * flag: a price someone entered by hand is the price they meant, and the plugin
 * has no business doubling it.
 *
 * A cache write bills as an input miss (DeepSeek publishes no separate
 * cache-write class), but the price book has no line for one either, so the
 * column stays 0 rather than repeating the input price: the table should say
 * what the provider publishes, and nothing else.
 */
export const BUILTIN_PRICES = Object.freeze({
  'deepseek-flash': Object.freeze({ from: '', input: 1, output: 4, cacheRead: 0.02, cacheWrite: 0, offPeak: true }),
  'deepseek-v4-pro': Object.freeze({ from: '', input: 4.5, output: 13.5, cacheRead: 0.15, cacheWrite: 0, offPeak: true }),
})

/** Retired and renamed ids that bill at one of the rows above. */
const PRICE_ALIASES = Object.freeze({
  'deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
})

/** A price, whether the user typed a number or a numeric string. */
function price(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
  }
  return undefined
}

/**
 * Whether a key is safe to write into a plain object.
 *
 * A model id arrives from a provider, a config file or a text box, and
 * `table['__proto__'] = row` would not add a row — it would change the
 * prototype of the table. The ledger's bucket keys are guarded the same way.
 */
function isSafeKey(key) {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
}

/** A token count off a totals row. */
function tokens(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** A `YYYY-MM-DD` date, or nothing. A shape check alone would accept `2026-02-30`. */
function dateKey(value) {
  if (typeof value !== 'string') return undefined
  const key = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return undefined
  const [year, month, day] = key.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined
  return key
}

/**
 * Normalize one price row.
 *
 * A row that names no input and no output price is not a row: it would convert
 * every token to zero, which reads as "free" rather than "unpriced". `cacheWrite`
 * has no fallback: a model whose provider publishes no cache-write class (every
 * DeepSeek model, for one) simply has no price for it, and saying so is more
 * honest than inventing one. Leave the cell empty and those tokens cost nothing.
 *
 * `from` is the day the row starts to apply. `''` means "as far back as the
 * ledger goes" — the built-in rows, and any row the user did not date. Two rows
 * of the same model with different dates are a price change; one row edited in
 * place is a correction.
 *
 * @param {object|undefined} value - the row as stored.
 * @returns {{from: string, input: number, output: number, cacheRead: number, cacheWrite: number, offPeak: boolean}|undefined} the row, or nothing.
 */
export function priceRow(value) {
  if (value === null || typeof value !== 'object') return undefined
  const input = price(value.input) ?? 0
  const output = price(value.output) ?? 0
  if (input <= 0 && output <= 0) return undefined
  return {
    from: dateKey(value.from) ?? '',
    input,
    output,
    cacheRead: price(value.cacheRead) ?? 0,
    cacheWrite: price(value.cacheWrite) ?? 0,
    // Only a built-in row says so, and a user row that replaced it does not: the
    // flag travels with the price book that publishes a peak rate.
    offPeak: value.offPeak === true,
  }
}

/** Peak hours are billed at twice the off-peak rate. */
export const PEAK_FACTOR = 2

/**
 * DeepSeek's peak windows, in the machine's local time: 09:00-12:00 and
 * 14:00-18:00 on weekdays that are not public holidays.
 *
 * Local time is the right clock here. The windows are published in Beijing time,
 * and this plugin already files usage under the local date — a second time zone
 * living inside one plugin is a bug waiting to happen.
 */
const PEAK_WINDOWS = Object.freeze([Object.freeze([9, 12]), Object.freeze([14, 18])])

/**
 * The multiplier for a call at one instant.
 *
 * Only rows flagged `offPeak` have a peak rate at all: a row the user typed is a
 * flat number, and doubling a hand-entered price would be inventing a rule the
 * user never wrote down.
 *
 * @param {number} atMs - when the call happened.
 * @param {object} row - a price row.
 * @param {Set<string>} [holidays] - public holiday date keys, from `holidaySet`.
 *   Without them a holiday inside a peak window bills at the peak rate, which is
 *   the same as not knowing the calendar.
 * @returns {number} {@link PEAK_FACTOR} inside a peak window, otherwise 1.
 */
export function peakFactorOf(atMs, row, holidays) {
  if (row?.offPeak !== true) return 1
  const date = new Date(atMs)
  const weekday = date.getDay()
  if (weekday === 0 || weekday === 6) return 1
  // A public holiday is off-peak all day, even at 10:00 on a Thursday.
  if (isPublicHoliday(localDateKey(atMs), holidays)) return 1
  const hour = date.getHours() + date.getMinutes() / 60
  for (const [from, to] of PEAK_WINDOWS) {
    if (hour >= from && hour < to) return PEAK_FACTOR
  }
  return 1
}

/**
 * The instant an hour bucket starts at.
 * @param {string} key - an hour key, `YYYY-MM-DDTHH`.
 * @returns {number} milliseconds in local time.
 */
export function msOfHourKey(key) {
  return new Date(
    Number(key.slice(0, 4)),
    Number(key.slice(5, 7)) - 1,
    Number(key.slice(8, 10)),
    Number(key.slice(11, 13)),
  ).getTime()
}

/** Oldest first, with the undated row — the one that applies from the start — leading. */
function byFrom(a, b) {
  if (a.from === b.from) return 0
  if (a.from === '') return -1
  if (b.from === '') return 1
  return a.from < b.from ? -1 : 1
}

/**
 * Normalize a whole table.
 *
 * A model carries a list of dated rows, not one row: a price change is a second
 * row, while editing the numbers of an existing row is a correction to the
 * period that row covers. The list is sorted oldest first so a lookup can walk it
 * forward.
 *
 * @param {object|undefined} value - `{model: row}` or `{model: [row, ...]}` as stored or as sent.
 * @returns {Record<string, object[]>} the rows that survived, keyed by lowercased model id.
 */
export function normalizePrices(value) {
  /** @type {Record<string, object[]>} */
  const out = {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out
  for (const [key, entry] of Object.entries(value)) {
    const model = String(key).trim().toLowerCase()
    if (model === '' || !isSafeKey(model)) continue
    const rows = (Array.isArray(entry) ? entry : [entry])
      .map(priceRow)
      .filter((row) => row !== undefined)
    if (rows.length > 0) out[model] = rows.sort(byFrom)
  }
  return out
}

/**
 * The table to price with: the built-in rows, extended by the user's.
 *
 * A user row dated the same day as a built-in one replaces it — that is how a
 * typed price overrides the published one. A user row dated later *extends* the
 * series instead, so the built-in price still bills the days before it.
 *
 * @param {object|undefined} overrides - the config's `prices`.
 * @param {object} [base] - the published table to start from; defaults to the
 *   bundled one, and the host passes what it last read upstream.
 * @returns {Record<string, object[]>} the effective table.
 */
export function priceTable(overrides, base = BUILTIN_PRICES) {
  /** @type {Record<string, object[]>} */
  const table = {}
  for (const [model, rows] of Object.entries(normalizePrices(base))) table[model] = [...rows]
  for (const [model, rows] of Object.entries(normalizePrices(overrides))) {
    const byDate = new Map((table[model] ?? []).map((row) => [row.from, row]))
    for (const row of rows) byDate.set(row.from, row)
    table[model] = [...byDate.values()].sort(byFrom)
  }
  return table
}

/**
 * The row in force at one instant.
 *
 * This is what keeps a price change from rewriting history: the row is chosen by
 * the day the call happened, not by the day someone opened the settings page.
 *
 * @param {Record<string, object[]>} table - from {@link priceTable}.
 * @param {string} model - the model id as the provider reported it.
 * @param {number} [atMs] - when the calls happened. Without it the newest row
 *   answers, which is the right guess for a window whose time is not recorded.
 * @returns {object|undefined} the row, or nothing when the model is unpriced.
 */
export function priceOf(table, model, atMs) {
  const key = String(model ?? '').trim().toLowerCase()
  if (key === '') return undefined
  const rows = table[key] ?? table[PRICE_ALIASES[key]]
  if (rows === undefined) return undefined
  return rowAt(Array.isArray(rows) ? rows : [rows], atMs)
}

/** The newest row that had started by `atMs`. */
function rowAt(rows, atMs) {
  if (rows.length === 0) return undefined
  if (atMs === undefined) return rows[rows.length - 1]
  const day = localDateKey(atMs)
  let found
  for (const row of rows) {
    if (row.from === '' || row.from <= day) found = row
    else break
  }
  return found
}

/**
 * The tokens a row of the ledger bills for.
 *
 * Reasoning tokens are not added separately: providers report them inside the
 * output count, and billing them twice would inflate every estimate.
 *
 * @param {object|undefined} totals - a totals row.
 * @returns {number} the billed token count.
 */
export function billedTokens(totals) {
  return tokens(totals?.inputTokens) + tokens(totals?.outputTokens)
    + tokens(totals?.cacheReadTokens) + tokens(totals?.cacheWriteTokens)
}

/**
 * The cost of one totals row at one price.
 * @param {object|undefined} totals - a totals row.
 * @param {object} row - a price row.
 * @returns {number} the cost, in the table's currency.
 */
export function costOfTotals(totals, row) {
  return (
    tokens(totals?.inputTokens) * row.input
    + tokens(totals?.outputTokens) * row.output
    + tokens(totals?.cacheReadTokens) * row.cacheRead
    + tokens(totals?.cacheWriteTokens) * row.cacheWrite
  ) / PRICE_UNIT
}

/** Sort a list of costed entries: dearest first, then by volume. */
function byCost(a, b) {
  if (b.cost !== a.cost) return b.cost - a.cost
  return b.tokens - a.tokens
}

/**
 * Convert a `provider -> model -> totals` bucket map into money.
 *
 * Returns the whole tree rather than one number, because the UI lets the user
 * narrow to a single provider or a single model: narrowing is a read of this
 * tree, not a second request.
 *
 * @param {Record<string, Record<string, object>>|undefined} buckets - a bucket map.
 * @param {Record<string, object[]>} table - from {@link priceTable}.
 * @param {{atMs?: number, holidays?: Set<string>}} [options] - when the calls
 *   happened, and the public holiday calendar the peak rule reads.
 * @returns {object} the breakdown, with `unpriced` naming what the table could not price.
 */
export function costOfBuckets(buckets, table, options) {
  const acc = createCostAccumulator()
  for (const [provider, models] of Object.entries(buckets ?? {})) {
    if (models === null || typeof models !== 'object') continue
    for (const [model, totals] of Object.entries(models)) {
      addCost(acc, provider, model, totals, table, options?.atMs, options?.holidays)
    }
  }
  return finishCost(acc)
}

/**
 * Convert hour buckets into money, billing each hour at the rate that applied.
 *
 * This is the honest way to convert a window. A day holds both peak and off-peak
 * hours and DeepSeek charges twice as much for one of them, so one flat
 * multiplication over the day's totals would be wrong in both directions at once
 * — too cheap for the peak calls and too dear for the rest. The hour key is the
 * only record of when a call happened, which is why the hour map exists.
 *
 * @param {Array<{ key: string, buckets: object }>} hours - hour buckets, keyed `YYYY-MM-DDTHH`; an
 *   empty key bills flat, which is what a day with no hour record has to fall back on.
 * @param {Record<string, object[]>} table - from {@link priceTable}.
 * @param {{atMs?: number, holidays?: Set<string>}} [options] - the instant an
 *   empty hour key stands for, and the public holiday calendar.
 * @returns {object} the breakdown, in the same shape as {@link costOfBuckets}.
 */
export function costOfHourBuckets(hours, table, options) {
  const acc = createCostAccumulator()
  for (const hour of hours) {
    const atMs = hour.key === '' ? options?.atMs : msOfHourKey(hour.key)
    for (const [provider, models] of Object.entries(hour.buckets ?? {})) {
      if (models === null || typeof models !== 'object') continue
      for (const [model, totals] of Object.entries(models)) {
        addCost(acc, provider, model, totals, table, atMs, options?.holidays)
      }
    }
  }
  return finishCost(acc)
}

/** A running total while a bucket map is turned into money. */
function createCostAccumulator() {
  return { providers: new Map(), unpriced: new Map(), total: 0, tokens: 0, pricedTokens: 0 }
}

/**
 * Bill one totals row into an accumulator.
 * @param {object} acc - from {@link createCostAccumulator}.
 * @param {string} provider - the route the calls went through.
 * @param {string} model - the model id as reported.
 * @param {object|undefined} totals - the row's totals.
 * @param {Record<string, object[]>} table - from {@link priceTable}.
 * @param {number} [atMs] - when the calls happened, when that is known.
 * @param {Set<string>} [holidays] - public holiday date keys.
 * @returns {void}
 */
function addCost(acc, provider, model, totals, table, atMs, holidays) {
  const count = billedTokens(totals)
  if (count <= 0) return
  const row = priceOf(table, model, atMs)
  const factor = row === undefined || atMs === undefined ? 1 : peakFactorOf(atMs, row, holidays)
  const cost = row === undefined ? 0 : costOfTotals(totals, row) * factor
  if (row === undefined) acc.unpriced.set(model, (acc.unpriced.get(model) ?? 0) + count)
  else acc.pricedTokens += count

  let entry = acc.providers.get(provider)
  if (entry === undefined) {
    entry = { provider, cost: 0, tokens: 0, pricedTokens: 0, models: new Map() }
    acc.providers.set(provider, entry)
  }
  entry.cost += cost
  entry.tokens += count
  if (row !== undefined) entry.pricedTokens += count

  const modelRow = entry.models.get(model) ?? { model, cost: 0, tokens: 0, calls: 0, priced: row !== undefined }
  modelRow.cost += cost
  modelRow.tokens += count
  modelRow.calls += tokens(totals?.calls)
  entry.models.set(model, modelRow)

  acc.total += cost
  acc.tokens += count
}

/** Turn an accumulator into the breakdown the UI reads. */
function finishCost(acc) {
  /** @type {object[]} */
  const providers = []
  for (const entry of acc.providers.values()) {
    providers.push({
      provider: entry.provider,
      cost: entry.cost,
      tokens: entry.tokens,
      pricedTokens: entry.pricedTokens,
      unpricedTokens: entry.tokens - entry.pricedTokens,
      models: [...entry.models.values()].sort(byCost),
    })
  }
  providers.sort(byCost)

  const unpricedRows = [...acc.unpriced.entries()]
    .map(([model, count]) => ({ model, tokens: count }))
    .sort((a, b) => b.tokens - a.tokens)

  return {
    currency: CURRENCY,
    total: acc.total,
    tokens: acc.tokens,
    pricedTokens: acc.pricedTokens,
    unpricedTokens: acc.tokens - acc.pricedTokens,
    unpricedCount: unpricedRows.length,
    unpriced: unpricedRows.slice(0, UNPRICED_CAP),
    providers,
  }
}
