/**
 * Unit tests for the price table and the token-to-money conversion.
 *
 * Three rules carry the feature:
 *
 *   1. Money is recomputed, never stored. The table is editable, so a corrected
 *      price has to correct the history too — which only works if nothing was
 *      stamped into a row at fold time.
 *   2. An unpriced model is *reported*, not billed at zero. A total that
 *      silently omits half the tokens is worse than no total.
 *   3. A row that names no price is not a row. It would read as "free".
 *
 * Run with: node --test test/
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  BUILTIN_PRICES,
  CURRENCY,
  PEAK_FACTOR,
  billedTokens,
  costOfBuckets,
  costOfHourBuckets,
  costOfTotals,
  msOfHourKey,
  normalizePrices,
  peakFactorOf,
  priceOf,
  priceRow,
  priceTable,
} from '../lib/core/pricing.js'
import { holidaySet } from '../lib/core/holidays.js'

/** A totals row. */
function totals(overrides = {}) {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    calls: 1,
    ...overrides,
  }
}

test('the built-in table prices the DeepSeek family, aliases included', () => {
  const table = priceTable(undefined)
  assert.deepEqual(priceOf(table, 'deepseek-flash'), BUILTIN_PRICES['deepseek-flash'])
  // The ids this machine actually records: the current one, and the retired
  // spellings DeepSeek still accepts.
  for (const id of ['deepseek-v4.1-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
    assert.deepEqual(priceOf(table, id), BUILTIN_PRICES['deepseek-flash'], id)
  }
  // Case and stray whitespace are the provider's business, not the user's.
  assert.deepEqual(priceOf(table, ' DeepSeek-Flash '), BUILTIN_PRICES['deepseek-flash'])
  assert.equal(priceOf(table, 'gpt-5.6-luna'), undefined)
})

test('a user row overrides a built-in one and adds models the book has never heard of', () => {
  const table = priceTable({
    'deepseek-flash': { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1 },
    'mimo-v2.6-flash': { input: 0.5, output: 1.5 },
  })
  // The override replaces the built-in row outright, peak rate included: a typed
  // price is a flat number. Both are undated, so the typed one wins from the start.
  assert.deepEqual(priceOf(table, 'deepseek-flash'), { from: '', input: 1, output: 2, cacheRead: 0.5, cacheWrite: 1, offPeak: false })
  // Two fields is a complete row: a cache read and a cache write are then free,
  // because the row says nothing about either.
  assert.deepEqual(priceOf(table, 'mimo-v2.6-flash'), { from: '', input: 0.5, output: 1.5, cacheRead: 0, cacheWrite: 0, offPeak: false })
  // The other built-in row is untouched.
  assert.deepEqual(priceOf(table, 'deepseek-v4-pro'), BUILTIN_PRICES['deepseek-v4-pro'])
})

test('a row that names no price is dropped rather than read as free', () => {
  assert.equal(priceRow({}), undefined)
  assert.equal(priceRow({ input: 0, output: 0 }), undefined)
  assert.equal(priceRow({ input: -1, output: -1 }), undefined)
  assert.equal(priceRow('2'), undefined)
  assert.equal(priceRow(null), undefined)
  // One priced class is enough to be a row.
  assert.deepEqual(priceRow({ output: 3 }), { from: '', input: 0, output: 3, cacheRead: 0, cacheWrite: 0, offPeak: false })
  // A numeric string is a number the user typed. The cache-write cell is absent,
  // so it stays 0 rather than borrowing the input price.
  assert.deepEqual(priceRow({ input: '2', output: '8' }), { from: '', input: 2, output: 8, cacheRead: 0, cacheWrite: 0, offPeak: false })
  // A date that is not a date is not a date: `2026-02-30` would roll into March.
  assert.equal(priceRow({ input: 2, output: 8, from: '2026-02-30' }).from, '')
  assert.equal(priceRow({ input: 2, output: 8, from: '2026-11-01' }).from, '2026-11-01')
})

test('normalizePrices drops junk and refuses to touch a prototype', () => {
  const table = normalizePrices({
    'deepseek-flash': { input: 1, output: 2 },
    '  ': { input: 1, output: 2 },
    free: {},
    '__proto__': { input: 1, output: 2 },
    constructor: { input: 1, output: 2 },
  })
  assert.deepEqual(Object.keys(table), ['deepseek-flash'])
  // The guard is not decoration: without it this line would replace the table's
  // prototype instead of adding a row.
  assert.equal(Object.getPrototypeOf(table), Object.prototype)
})

test('costOfTotals prices each class at its own rate, per million tokens', () => {
  const row = { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 2 }
  assert.equal(costOfTotals(totals({ inputTokens: 1_000_000 }), row), 2)
  assert.equal(costOfTotals(totals({ outputTokens: 1_000_000 }), row), 8)
  assert.equal(costOfTotals(totals({ cacheReadTokens: 1_000_000 }), row), 0.04)
  assert.equal(costOfTotals(totals({ cacheWriteTokens: 1_000_000 }), row), 2)
  assert.equal(costOfTotals(totals({ inputTokens: 500_000, outputTokens: 250_000 }), row), 3)
  // An empty row costs nothing, and so does a missing one.
  assert.equal(costOfTotals(totals(), row), 0)
  assert.equal(costOfTotals(undefined, row), 0)
})

test('reasoning tokens are not billed twice', () => {
  // Providers report reasoning inside the output count, so adding it again
  // would inflate every estimate that involves a thinking model.
  const withReasoning = totals({ outputTokens: 1000, reasoningTokens: 800 })
  assert.equal(billedTokens(withReasoning), 1000)
})

test('costOfBuckets returns the whole tree, dearest first', () => {
  const table = priceTable(undefined)
  const breakdown = costOfBuckets({
    'opencode-go': {
      'deepseek-v4.1-flash': totals({ inputTokens: 1_000_000, outputTokens: 1_000_000, calls: 4 }),
      'gpt-5.6-luna': totals({ inputTokens: 2_000_000, calls: 2 }),
    },
    'deepseek-official': {
      'deepseek-flash': totals({ inputTokens: 1_000_000, calls: 1 }),
    },
  }, table)

  assert.equal(breakdown.currency, CURRENCY)
  // flash: 1M input at 1 + 1M output at 4 = 5; official: 1M input at 1 = 1.
  assert.equal(breakdown.total, 6)
  assert.equal(breakdown.tokens, 5_000_000)
  assert.equal(breakdown.pricedTokens, 3_000_000)
  assert.equal(breakdown.unpricedTokens, 2_000_000)
  assert.equal(breakdown.unpricedCount, 1)
  assert.deepEqual(breakdown.unpriced, [{ model: 'gpt-5.6-luna', tokens: 2_000_000 }])

  // Providers are ordered by what they cost, not by name.
  assert.deepEqual(breakdown.providers.map((row) => row.provider), ['opencode-go', 'deepseek-official'])
  const opencode = breakdown.providers[0]
  assert.equal(opencode.cost, 5)
  // The flash call billed 2M tokens (1M in, 1M out) and all of them are priced;
  // luna's 2M are not.
  assert.equal(opencode.pricedTokens, 2_000_000)
  assert.equal(opencode.unpricedTokens, 2_000_000)
  // Inside a provider the dearest model leads, and the unpriced one is still
  // listed — with `priced: false`, so the UI can say why it shows no money.
  assert.deepEqual(opencode.models.map((row) => row.model), ['deepseek-v4.1-flash', 'gpt-5.6-luna'])
  assert.deepEqual(opencode.models[0], { model: 'deepseek-v4.1-flash', cost: 5, tokens: 2_000_000, calls: 4, priced: true })
  assert.deepEqual(opencode.models[1], { model: 'gpt-5.6-luna', cost: 0, tokens: 2_000_000, calls: 2, priced: false })
})

test('costOfBuckets survives an empty ledger and skips empty rows', () => {
  const table = priceTable(undefined)
  for (const buckets of [undefined, {}, { 'opencode-go': {} }]) {
    const breakdown = costOfBuckets(buckets, table)
    assert.equal(breakdown.total, 0)
    assert.equal(breakdown.tokens, 0)
    assert.equal(breakdown.unpricedCount, 0)
    assert.deepEqual(breakdown.providers, [])
  }
  // A row with no tokens is not a model that was used.
  const quiet = costOfBuckets({ 'opencode-go': { 'deepseek-flash': totals() } }, table)
  assert.deepEqual(quiet.providers, [])
})

/** A local instant, built from its parts so the test never parses a string. */
function at(year, month, day, hour) {
  return new Date(year, month - 1, day, hour, 0, 0, 0).getTime()
}

test('peakFactorOf doubles a weekday inside a peak window and nothing else', () => {
  // 2026-10-19 is a Monday; DeepSeek's windows are 09:00-12:00 and 14:00-18:00.
  const row = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, offPeak: true }
  assert.equal(peakFactorOf(at(2026, 10, 19, 9), row), PEAK_FACTOR)
  assert.equal(peakFactorOf(at(2026, 10, 19, 11), row), PEAK_FACTOR)
  assert.equal(peakFactorOf(at(2026, 10, 19, 14), row), PEAK_FACTOR)
  assert.equal(peakFactorOf(at(2026, 10, 19, 17), row), PEAK_FACTOR)
  // The ends of a window belong to the off-peak side, so nothing is billed at the
  // peak rate for a minute longer than the window says.
  assert.equal(peakFactorOf(at(2026, 10, 19, 8), row), 1)
  assert.equal(peakFactorOf(at(2026, 10, 19, 12), row), 1)
  assert.equal(peakFactorOf(at(2026, 10, 19, 13), row), 1)
  assert.equal(peakFactorOf(at(2026, 10, 19, 18), row), 1)
  // 2026-10-18 is a Sunday: off-peak all day, at an hour that is peak on a Monday.
  assert.equal(peakFactorOf(at(2026, 10, 18, 10), row), 1)
})

test('a row the user typed has no peak rate', () => {
  // A price someone entered by hand is the price they meant; doubling it would be
  // inventing a rule the user never wrote down.
  const typed = priceRow({ input: 1, output: 2 })
  assert.equal(typed.offPeak, false)
  assert.equal(peakFactorOf(at(2026, 10, 19, 10), typed), 1)
  // The built-in rows are the published table, and the published table has one.
  assert.equal(priceRow(BUILTIN_PRICES['deepseek-flash']).offPeak, true)
})

test('costOfHourBuckets bills each hour at the rate that applied', () => {
  const table = priceTable(undefined)
  const buckets = { 'opencode-go': { 'deepseek-flash': totals({ inputTokens: 1_000_000, calls: 1 }) } }

  // One flat multiplication is the fallback, not the rule: 1M input tokens at the
  // flash input price (1 per million) is 1.
  assert.equal(costOfBuckets(buckets, table).total, 1)
  // The same call at 10:00 on a Monday is inside a peak window, so it costs twice.
  assert.equal(costOfHourBuckets([{ key: '2026-10-19T10', buckets }], table).total, 2)
  // 13:00 falls between the two windows, so it bills at the off-peak rate.
  assert.equal(costOfHourBuckets([{ key: '2026-10-19T13', buckets }], table).total, 1)

  // A day is its hours, peak hour and quiet hour alike.
  const both = costOfHourBuckets([
    { key: '2026-10-19T10', buckets },
    { key: '2026-10-19T13', buckets },
  ], table)
  assert.equal(both.total, 3)
  assert.equal(both.tokens, 2_000_000)
  assert.deepEqual(both.providers[0].models[0], {
    model: 'deepseek-flash',
    cost: 3,
    tokens: 2_000_000,
    calls: 2,
    priced: true,
  })

  // An empty key is the fallback for a day whose hour record is gone: billed flat
  // rather than dropped, so money is never silently missing from a total.
  assert.equal(costOfHourBuckets([{ key: '', buckets }], table).total, 1)
})

test('msOfHourKey reads an hour key as local time', () => {
  assert.equal(msOfHourKey('2026-10-19T14'), at(2026, 10, 19, 14))
  assert.equal(msOfHourKey('2026-10-19T00'), at(2026, 10, 19, 0))
})

test('a dated row bills only the days it was in force', () => {
  // The whole point of dating a row: a price rise must not rewrite last month.
  const table = priceTable({
    'deepseek-flash': [{ from: '2026-11-01', input: 8, output: 32 }],
  })
  // Before the rise the built-in row still answers, and after it the new one does.
  assert.equal(priceOf(table, 'deepseek-flash', at(2026, 10, 20, 10)).input, 1)
  assert.equal(priceOf(table, 'deepseek-flash', at(2026, 11, 1, 10)).input, 8)
  assert.equal(priceOf(table, 'deepseek-flash', at(2026, 12, 1, 10)).input, 8)
  // With no time at all the newest row is the best answer available.
  assert.equal(priceOf(table, 'deepseek-flash').input, 8)

  // Money follows the date, not the settings page.
  const buckets = { 'opencode-go': { 'deepseek-flash': totals({ inputTokens: 1_000_000, calls: 1 }) } }
  // 2026-10-20 is a Tuesday: 10:00 is peak, so the built-in 1/1M bills 2.
  assert.equal(costOfHourBuckets([{ key: '2026-10-20T10', buckets }], table).total, 2)
  // 13:00 the same day falls between the windows, so it bills 1.
  assert.equal(costOfHourBuckets([{ key: '2026-10-20T13', buckets }], table).total, 1)
  // November: the typed row is a flat number, so the peak window does not double it.
  assert.equal(costOfHourBuckets([{ key: '2026-11-01T10', buckets }], table).total, 8)
})

test('a public holiday is off-peak all day', () => {
  const row = { from: '', input: 1, output: 1, cacheRead: 0, cacheWrite: 0, offPeak: true }
  const holidays = holidaySet({ 2026: ['2026-10-01'] })
  // 2026-10-01 is a Thursday at 10:00 — inside a peak window, and a public holiday.
  assert.equal(peakFactorOf(at(2026, 10, 1, 10), row), PEAK_FACTOR)
  assert.equal(peakFactorOf(at(2026, 10, 1, 10), row, holidays), 1)
  // A weekday that is not in the table still bills peak.
  assert.equal(peakFactorOf(at(2026, 10, 8, 10), row, holidays), PEAK_FACTOR)
  // The bundled calendar carries the real dates, so the rule works out of the box.
  assert.equal(holidaySet().size, 33)
  assert.equal(peakFactorOf(at(2026, 10, 1, 10), row, holidaySet()), 1)
  // A junk entry is dropped rather than repaired: a typo must not move a price.
  assert.equal(holidaySet({ 2026: ['2026-02-30', 'nope', 7] }).size, 0)
})
