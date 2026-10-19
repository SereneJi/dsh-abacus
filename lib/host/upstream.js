/**
 * The two things this plugin knows that somebody else publishes: what DeepSeek
 * charges, and which days are public holidays.
 *
 * Both are read from the network at most once a day (prices) or once a month
 * (holidays), cached in the state directory, and used only when the fetch
 * succeeded — a parse that drifts or a network that is down leaves the previous
 * answer in place, and with nothing cached at all the built-in tables stand.
 * Nothing here is required for the plugin to work: it is a way to stop the
 * built-in numbers from silently ageing.
 *
 * Parsing lives in its own exported functions because the shapes are published
 * by other people and will change: a test can feed a captured page in and see
 * whether the reader still finds the numbers, without touching the network.
 * @module dsh-usage-stat/host/upstream
 */

import { readFileSync, writeFileSync } from 'node:fs'

import { localDateKey } from '../core/document.js'
import { BUILTIN_PRICES, normalizePrices } from '../core/pricing.js'
import { BUILTIN_HOLIDAYS, daySet, holidaySet } from '../core/holidays.js'

/** DeepSeek's published price list, in Chinese — the numbers are the same in both. */
export const PRICE_URL = 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/'

/** A year's public holidays, as a machine-readable table. */
export function holidayUrl(year) {
  return `https://timor.tech/api/holiday/year/${year}`
}

/** How long a fetched price list stays good for. */
export const PRICE_INTERVAL_MS = 24 * 60 * 60 * 1000

/** How long a fetched holiday table stays good for. */
export const HOLIDAY_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000

/** A fetch that has not answered by now is not going to be waited for. */
export const FETCH_TIMEOUT_MS = 15_000

/**
 * The label each price row carries, mapped to the field it fills.
 *
 * The table's rows are `百万tokens输入（缓存命中）`, `…（缓存未命中）` and
 * `百万tokens输出`, each split into a `空闲时段` (off-peak) row and a
 * `高峰时段` (peak) row. Only the off-peak row is read: the plugin's own
 * `offPeak` flag doubles it for peak hours, so storing the peak column too
 * would be a second copy of the same fact.
 */
const PRICE_LABELS = Object.freeze({
  '百万tokens输入（缓存命中）': 'cacheRead',
  '百万tokens输入（缓存未命中）': 'input',
  '百万tokens输出': 'output',
})

/** A price cell as a number. `0.02元` → `0.02`; anything else is `undefined`. */
function yuan(text) {
  if (typeof text !== 'string') return undefined
  const value = Number.parseFloat(text.replace(/[^\d.]/g, ''))
  return Number.isFinite(value) ? value : undefined
}

/**
 * Read the price table out of DeepSeek's pricing page.
 *
 * Deliberately shallow: it finds the first `<table>`, splits rows on `</tr>` and
 * cells on `</td>`, and matches the row labels by their exact text. That is
 * enough for the page as published and it fails closed — a page that has been
 * restructured yields `{}`, and the caller keeps whatever it had.
 * @param {string} html - the page source.
 * @returns {object} `{model: {input, output, cacheRead, cacheWrite, offPeak}}`, empty on drift.
 */
export function parseDeepSeekPrices(html) {
  if (typeof html !== 'string') return {}
  const table = /<table[\s\S]*?<\/table>/.exec(html)
  if (table === null) return {}

  const rows = table[0]
    // Cells first, then rows — stripping every tag before splitting on `</tr>`
    // would remove the row separators along with the markup.
    .replace(/<\/t[dh]>/g, '\t')
    .split(/<\/tr>/)
    .map((row) => {
      const cells = row
        .replace(/<[^>]*>/g, '')
        .split('\t')
        .map((cell) => cell.replace(/\s+/g, ' ').trim())
      while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop()
      return cells
    })

  const header = rows.find((cells) => cells.includes('模型'))
  if (header === undefined) return {}
  // One column per model, each carrying its footnote marker inside the name.
  const models = header
    .filter((cell, at) => at > 0 && cell !== '')
    .map((cell) => cell.replace(/\(\d+\)$/, '').trim())
    .filter((cell) => cell !== '')
  if (models.length === 0) return {}

  const prices = {}
  for (const model of models) {
    prices[model] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, offPeak: true }
  }
  for (const cells of rows) {
    const label = cells.find((cell) => PRICE_LABELS[cell] !== undefined)
    if (label === undefined) continue
    const at = cells.indexOf(label)
    // `空闲时段` is the column this plugin stores; `高峰时段` is derived from it.
    if (cells[at + 1] !== '空闲时段') continue
    const amounts = cells.slice(at + 2, at + 2 + models.length).map(yuan)
    models.forEach((model, index) => {
      if (amounts[index] !== undefined) prices[model][PRICE_LABELS[label]] = amounts[index]
    })
  }
  for (const model of models) {
    // A row whose numbers did not parse is not a price; drop it rather than
    // publish a model that bills nothing.
    if (prices[model].input === 0 && prices[model].output === 0) delete prices[model]
  }
  return prices
}

/**
 * Read the public holidays out of a year table.
 *
 * The payload marks make-up workdays (`补班`) with `holiday: false`, so the flag
 * is what is trusted, not the presence of an entry.
 * @param {object} payload - the parsed JSON.
 * @returns {string[]} `YYYY-MM-DD`, sorted.
 */
export function parseHolidays(payload) {
  const table = payload?.holiday
  if (table === null || typeof table !== 'object') return []
  const days = []
  for (const entry of Object.values(table)) {
    if (entry?.holiday !== true) continue
    const date = typeof entry.date === 'string' ? entry.date : ''
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) days.push(date)
  }
  return days.sort()
}

/** Fetch a URL as text, giving up rather than hanging. */
async function defaultFetchText(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'user-agent': 'dsh-usage-stat' },
  })
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return response.text()
}

/**
 * The cached upstream tables, and the schedule that keeps them fresh.
 *
 * One instance lives on the usage service. Every method that answers a question
 * answers it from memory; `refresh()` is the only thing that touches the network
 * and it never throws — a failure is recorded and the previous answer stands.
 */
export class Upstream {
  /**
   * @param {object} options - `{file, fetchText?, now?, log?}`.
   */
  constructor(options) {
    this.file = options.file
    this.fetchText = options.fetchText ?? defaultFetchText
    this.now = options.now ?? (() => Date.now())
    this.log = options.log ?? (() => {})
    /** @type {object} the fetched price table, or `{}`. */
    this.prices = {}
    /** @type {string[]} the fetched holiday dates, or `[]`. */
    this.holidays = []
    /**
     * The years a fetched calendar covers.
     *
     * A fetch reads one year, and the official calendar is published a year at a
     * time. Without this list, the first refresh after New Year would replace
     * last year's holidays with this year's — and every call made on a public
     * holiday last year would be re-priced at the peak rate, because the money is
     * worked out at read time. The list is what lets a fetched year govern its
     * own dates while the bundled table keeps covering the years nobody fetched.
     * @type {string[]}
     */
    this.holidayYears = []
    this.pricesAt = 0
    this.holidaysAt = 0
    this.running = null
  }

  /** Read the cache. A missing or unreadable file is simply an empty cache. */
  load() {
    let stored = null
    try {
      stored = JSON.parse(readFileSync(this.file, 'utf8'))
    } catch {
      return this
    }
    if (stored !== null && typeof stored === 'object') {
      if (stored.prices !== null && typeof stored.prices === 'object') this.prices = normalizePrices(stored.prices)
      if (Array.isArray(stored.holidays)) this.holidays = stored.holidays.filter((day) => typeof day === 'string')
      if (Array.isArray(stored.holidayYears)) {
        this.holidayYears = stored.holidayYears.filter((year) => typeof year === 'string')
      } else {
        // A cache written before the years were tracked: the days it holds are
        // the years it covers, which is what that cache meant at the time.
        this.holidayYears = [...new Set(this.holidays.map((day) => day.slice(0, 4)))]
      }
      this.pricesAt = Number.isFinite(stored.pricesAt) ? stored.pricesAt : 0
      this.holidaysAt = Number.isFinite(stored.holidaysAt) ? stored.holidaysAt : 0
    }
    return this
  }

  /** Write the cache. A failure here costs a refetch next start, nothing more. */
  save() {
    try {
      writeFileSync(this.file, JSON.stringify({
        prices: this.prices,
        holidays: this.holidays,
        holidayYears: this.holidayYears,
        pricesAt: this.pricesAt,
        holidaysAt: this.holidaysAt,
      }))
    } catch (error) {
      this.log(`upstream cache not written: ${error.message}`)
    }
  }

  /** The price table to bill with: what was fetched, or the built-in one. */
  effectivePrices() {
    return Object.keys(this.prices).length > 0 ? this.prices : BUILTIN_PRICES
  }

  /**
   * Fold a freshly fetched table into the stored one, dated.
   *
   * A published price rise must not reprice the calls made before it, so a
   * changed number is appended as a new row starting **today** rather than
   * overwriting the row that is billing the past. An unchanged number is not a
   * new row at all: the daily fetch would otherwise grow the series by one row a
   * day. A model seen for the first time is undated, because there is no earlier
   * figure it could contradict.
   *
   * @param {object} fetched - `{model: {input, output, cacheRead, cacheWrite, offPeak}}`.
   * @param {number} now - the instant the fetch landed.
   * @returns {Record<string, object[]>} the dated table.
   */
  #dated(fetched, now) {
    const today = localDateKey(now)
    const table = { ...this.prices }
    for (const [model, row] of Object.entries(normalizePrices(fetched))) {
      const next = row[0]
      const series = table[model]
      if (series === undefined || series.length === 0) {
        table[model] = [{ ...next, from: '' }]
        continue
      }
      const last = series[series.length - 1]
      const same = last.input === next.input && last.output === next.output
        && last.cacheRead === next.cacheRead && last.cacheWrite === next.cacheWrite
        && last.offPeak === next.offPeak
      if (!same) table[model] = [...series, { ...next, from: today }]
    }
    return table
  }

  /**
   * The days to treat as public holidays.
   *
   * A year the fetch has covered is answered by the fetch alone — the official
   * calendar is authoritative for its own year, including the make-up workdays
   * it lists as `holiday: false`. Every other year falls back to the bundled
   * table, so fetching 2027 cannot silently turn 2026's holidays into workdays
   * and re-price a year of calls at the peak rate.
   */
  effectiveHolidays() {
    const fetched = new Set(this.holidayYears)
    const bundled = []
    for (const [year, days] of Object.entries(BUILTIN_HOLIDAYS)) {
      if (fetched.has(year)) continue
      for (const day of days) bundled.push(day)
    }
    return daySet([...bundled, ...this.holidays])
  }

  /** When the price list was last read successfully, or `0`. */
  pricesFetchedAt() {
    return this.pricesAt
  }

  /**
   * Bring both tables up to date if their interval has passed.
   *
   * Single-flight, and never throws: the caller is a timer, and a rejected
   * promise there would be an unhandled rejection rather than a retry.
   * @param {object} [options] - `{force}` to ignore the intervals.
   * @returns {Promise<{prices: boolean, holidays: boolean}>} what was refetched.
   */
  refresh(options = {}) {
    if (this.running !== null) return this.running
    const force = options.force === true
    this.running = this.#run(force).finally(() => {
      this.running = null
    })
    return this.running
  }

  async #run(force) {
    const now = this.now()
    const wantPrices = force || now - this.pricesAt >= PRICE_INTERVAL_MS
    const wantHolidays = force || now - this.holidaysAt >= HOLIDAY_INTERVAL_MS
    const done = { prices: false, holidays: false }
    if (!wantPrices && !wantHolidays) return done

    if (wantPrices) {
      try {
        const prices = parseDeepSeekPrices(await this.fetchText(PRICE_URL))
        if (Object.keys(prices).length > 0) {
          this.prices = this.#dated(prices, now)
          this.pricesAt = now
          done.prices = true
        } else {
          // A page that no longer parses is the interesting failure, so it is
          // logged and the old table stays. The stamp is left alone: retrying
          // tomorrow beats retrying every start.
          this.log('price list fetched but not recognised; keeping the previous one')
        }
      } catch (error) {
        this.log(`price list not fetched: ${error.message}`)
      }
    }

    if (wantHolidays) {
      try {
        const year = new Date(now).getFullYear()
        const days = parseHolidays(JSON.parse(await this.fetchText(holidayUrl(year))))
        if (days.length > 0) {
          // Accumulate rather than replace. A year fetched in January must not
          // erase the year that just ended: the holiday calendar is half of how a
          // past call was priced, and that money is worked out again on every
          // read.
          const known = new Set(this.holidays)
          for (const day of days) known.add(day)
          this.holidays = [...known].sort()
          if (!this.holidayYears.includes(String(year))) this.holidayYears.push(String(year))
          this.holidaysAt = now
          done.holidays = true
        } else {
          // Next year's table is published late, so an empty one is normal.
          this.log(`no holidays published for ${year} yet; keeping the built-in table`)
        }
      } catch (error) {
        this.log(`holidays not fetched: ${error.message}`)
      }
    }

    if (done.prices || done.holidays) this.save()
    return done
  }
}
