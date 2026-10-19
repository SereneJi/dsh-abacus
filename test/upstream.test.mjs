/**
 * The upstream readers, against the pages as they were actually published.
 *
 * The fixtures are captured copies, not hand-written markup: the whole risk in
 * this module is that DeepSeek or the holiday service restructures a page, and a
 * fixture invented to match the parser would never notice that.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  HOLIDAY_INTERVAL_MS,
  PRICE_INTERVAL_MS,
  Upstream,
  holidayUrl,
  parseDeepSeekPrices,
  parseHolidays,
} from '../lib/host/upstream.js'
import { BUILTIN_PRICES, priceOf, priceTable } from '../lib/core/pricing.js'
import { localDateKey } from '../lib/core/document.js'
import { isPublicHoliday } from '../lib/core/holidays.js'

const pricing = readFileSync(new URL('./fixtures/deepseek-pricing.html', import.meta.url), 'utf8')
const holidays = JSON.parse(readFileSync(new URL('./fixtures/holidays-2026.json', import.meta.url), 'utf8'))

test('the price reader finds both models and the off-peak column', () => {
  const prices = parseDeepSeekPrices(pricing)
  assert.deepEqual(Object.keys(prices).sort(), ['deepseek-flash', 'deepseek-v4-pro'])
  // Off-peak: the peak column is derived by doubling, so it is not stored.
  assert.deepEqual(prices['deepseek-flash'], {
    input: 1, output: 4, cacheRead: 0.02, cacheWrite: 0, offPeak: true,
  })
  assert.deepEqual(prices['deepseek-v4-pro'], {
    input: 4.5, output: 13.5, cacheRead: 0.15, cacheWrite: 0, offPeak: true,
  })
})

test('a restructured price page yields nothing rather than a wrong price', () => {
  assert.deepEqual(parseDeepSeekPrices('<html><body>no table here</body></html>'), {})
  assert.deepEqual(parseDeepSeekPrices('<table><tr><td>模型</td></tr></table>'), {})
  assert.deepEqual(parseDeepSeekPrices(undefined), {})
})

test('the holiday reader takes the flag, not the presence of a day', () => {
  const days = parseHolidays(holidays)
  assert.ok(days.length > 20, `expected a year of holidays, got ${days.length}`)
  // 01-04 is 元旦后补班 — a make-up workday, which the payload carries with
  // holiday: false. It must not be treated as a day off.
  assert.equal(days.includes('2026-01-04'), false)
  assert.equal(days.includes('2026-01-01'), true)
  assert.deepEqual(days, [...days].sort())
  assert.deepEqual(parseHolidays({ holiday: {} }), [])
  assert.deepEqual(parseHolidays(null), [])
})

test('the built-in table and the published one agree on what they can', () => {
  // The built-in rows are the published off-peak numbers, so a refresh should
  // not move the bill. This is the assertion that catches the page and the
  // hard-coded table drifting apart.
  const prices = parseDeepSeekPrices(pricing)
  for (const [model, row] of Object.entries(BUILTIN_PRICES)) {
    const fetched = prices[model]
    if (fetched === undefined) continue
    assert.equal(fetched.input, row.input, `${model} input`)
    assert.equal(fetched.output, row.output, `${model} output`)
    assert.equal(fetched.cacheRead, row.cacheRead, `${model} cache read`)
  }
})

test('a refresh caches what it fetched and then leaves it alone', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'upstream-'))
  const file = join(dir, 'upstream.json')
  let asked = []
  const upstream = new Upstream({
    file,
    fetchText: async (url) => {
      asked.push(url)
      if (url.startsWith('https://timor.tech')) return JSON.stringify(holidays)
      return pricing
    },
  }).load()

  const first = await upstream.refresh()
  assert.deepEqual(first, { prices: true, holidays: true })
  assert.equal(asked.length, 2)
  assert.equal(asked[1], holidayUrl(2026))
  assert.equal(Object.keys(upstream.effectivePrices()).includes('deepseek-v4-pro'), true)
  assert.equal(isPublicHoliday('2026-10-01', upstream.effectiveHolidays()), true)

  // Inside the interval nothing is fetched again, so a restart costs no request.
  const second = await upstream.refresh()
  assert.deepEqual(second, { prices: false, holidays: false })
  assert.equal(asked.length, 2)

  // A second instance reads the cache and does not need the network at all.
  const reloaded = new Upstream({ file, fetchText: async () => { throw new Error('should not be called') } }).load()
  assert.equal(reloaded.pricesFetchedAt() > 0, true)
  assert.deepEqual(Object.keys(reloaded.effectivePrices()).sort(), ['deepseek-flash', 'deepseek-v4-pro'])
})

test('a failed fetch keeps the previous answer and never throws', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'upstream-'))
  const file = join(dir, 'upstream.json')
  const logs = []
  const upstream = new Upstream({
    file,
    log: (message) => logs.push(message),
    fetchText: async () => {
      throw new Error('offline')
    },
  }).load()

  assert.deepEqual(await upstream.refresh(), { prices: false, holidays: false })
  // The built-in tables stand in, so a machine that cannot reach the network
  // still bills and still knows the holidays.
  assert.deepEqual(upstream.effectivePrices(), BUILTIN_PRICES)
  assert.equal(isPublicHoliday('2026-10-01', upstream.effectiveHolidays()), true)
  assert.equal(logs.length, 2)
  assert.equal(upstream.pricesFetchedAt(), 0)

  // And a page that no longer parses is kept out of the table rather than
  // stored as a price of nothing.
  const drifted = new Upstream({ file, fetchText: async () => '<html></html>' }).load()
  await drifted.refresh({ force: true })
  assert.deepEqual(drifted.effectivePrices(), BUILTIN_PRICES)
})

test('the intervals are a day and a month', () => {
  assert.equal(PRICE_INTERVAL_MS, 24 * 60 * 60 * 1000)
  assert.equal(HOLIDAY_INTERVAL_MS, 30 * 24 * 60 * 60 * 1000)
  // A cached file written by an older run is still readable.
  const dir = mkdtempSync(join(tmpdir(), 'upstream-'))
  const file = join(dir, 'upstream.json')
  writeFileSync(file, JSON.stringify({ prices: {}, holidays: ['2026-05-01'], pricesAt: 5, holidaysAt: 7 }))
  const upstream = new Upstream({ file }).load()
  assert.equal(upstream.pricesFetchedAt(), 5)
  assert.equal(isPublicHoliday('2026-05-01', upstream.effectiveHolidays()), true)
})

test('a fetched price rise starts today and leaves yesterday at the old price', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'upstream-'))
  const file = join(dir, 'upstream.json')
  // The machine read the page yesterday and stored it; today DeepSeek doubles it.
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  yesterday.setHours(10, 0, 0, 0)
  const today = new Date()
  today.setHours(10, 0, 0, 0)
  const first = new Upstream({ file, now: () => yesterday.getTime(), fetchText: async () => pricing }).load()
  await first.refresh()
  assert.deepEqual(first.effectivePrices()['deepseek-flash'], [
    { from: '', input: 1, output: 4, cacheRead: 0.02, cacheWrite: 0, offPeak: true },
  ])

  const raised = pricing.replace(/>1元</, '>2元<')
  const second = new Upstream({ file, now: () => today.getTime(), fetchText: async () => raised }).load()
  assert.deepEqual(await second.refresh(), { prices: true, holidays: false })
  const series = second.effectivePrices()['deepseek-flash']
  // Two rows: the undated one that was already billing the past, and today's.
  assert.equal(series.length, 2)
  assert.equal(series[1].input, 2)
  assert.equal(series[1].from, localDateKey(today.getTime()))
  // This is the whole point: the call made yesterday is still billed at 1.
  const table = priceTable({}, second.effectivePrices())
  assert.equal(priceOf(table, 'deepseek-flash', yesterday.getTime()).input, 1)
  assert.equal(priceOf(table, 'deepseek-flash', today.getTime()).input, 2)
})

test('a fetch that changes nothing does not grow the series', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'upstream-'))
  const file = join(dir, 'upstream.json')
  const upstream = new Upstream({ file, fetchText: async () => pricing }).load()
  await upstream.refresh()
  const before = upstream.effectivePrices()['deepseek-flash'].length
  await upstream.refresh({ force: true })
  await upstream.refresh({ force: true })
  // Three identical reads, still one row: the daily timer must not turn the
  // series into a diary of every day the price happened to be looked at.
  assert.equal(upstream.effectivePrices()['deepseek-flash'].length, before)
  assert.equal(before, 1)
})

test('a later year keeps the years already fetched, so history is not re-priced', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'upstream-'))
  const file = join(dir, 'upstream.json')
  let clock = new Date('2026-06-01T12:00:00').getTime()
  const next = { holiday: { a: { holiday: true, name: '元旦', date: '2027-01-01' } } }
  const upstream = new Upstream({
    file,
    now: () => clock,
    fetchText: async (url) => {
      if (url.startsWith('https://timor.tech')) return JSON.stringify(url.endsWith('2027') ? next : holidays)
      return pricing
    },
  }).load()

  await upstream.refresh()
  assert.equal(isPublicHoliday('2026-10-01', upstream.effectiveHolidays()), true)

  // The monthly refresh that first lands after New Year fetches 2027 only.
  clock = new Date('2027-01-05T12:00:00').getTime()
  await upstream.refresh({ force: true })
  assert.equal(isPublicHoliday('2027-01-01', upstream.effectiveHolidays()), true)
  // 2026's calendar must survive: a call made on one of those days is priced
  // off-peak for ever, not at the peak rate from the day the year turned over.
  assert.equal(isPublicHoliday('2026-10-01', upstream.effectiveHolidays()), true)

  // The cache remembers which years it covers, so a restart does not fall back
  // to the bundled table for a year the fetch already answered.
  const reloaded = new Upstream({ file }).load()
  assert.deepEqual(reloaded.holidayYears.sort(), ['2026', '2027'])
  assert.equal(isPublicHoliday('2027-01-01', reloaded.effectiveHolidays()), true)
})