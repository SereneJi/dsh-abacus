/**
 * The Chinese public holidays, for the peak/off-peak rule.
 *
 * DeepSeek bills peak hours at twice the off-peak rate, and its peak windows are
 * weekdays only: a public holiday is off-peak the whole day, even at 10:00 on a
 * Thursday. So the peak rule needs a calendar, and this is it.
 *
 * The dates move every year and the State Council publishes the next year's
 * calendar only in the November before, so this table is a starting point rather
 * than the source of truth. The host refreshes it (see `lib/host/calendar.js`)
 * and passes the result to the pricing functions as a set of date keys; a year
 * with no table bills no holiday as off-peak, which is the same behaviour as not
 * having the feature at all. Guessing which days are holidays would be worse
 * than not knowing.
 *
 * @module dsh-abacus/core/holidays
 */

/**
 * Public holidays by year, as `YYYY-MM-DD` keys.
 *
 * 2026 is the year the State Council published at the time of writing. 2027 has
 * no published calendar yet, and inventing one would be a guess.
 */
export const BUILTIN_HOLIDAYS = Object.freeze({
  2026: Object.freeze([
    '2026-01-01', '2026-01-02', '2026-01-03',
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
    '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
    '2026-04-04', '2026-04-05', '2026-04-06',
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
    '2026-06-19', '2026-06-20', '2026-06-21',
    '2026-09-25', '2026-09-26', '2026-09-27',
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05',
    '2026-10-06', '2026-10-07',
  ]),
})

/** A `YYYY-MM-DD` key, or nothing. */
function dateKeyOf(value) {
  if (typeof value !== 'string') return undefined
  const key = value.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return undefined
  // Shape is not enough: `2026-02-30` would roll into March rather than fail.
  const [year, month, day] = key.split('-').map(Number)
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined
  return key
}

/**
 * Flatten a `{year: [date, ...]}` table into a set of date keys.
 *
 * Rows that are not dates are dropped rather than repaired: this table decides
 * whether a call is billed at double, and a typo silently billed at the wrong
 * rate is worse than a day that is simply not marked as a holiday.
 *
 * @param {object|undefined} table - a holiday table; defaults to {@link BUILTIN_HOLIDAYS}.
 * @returns {Set<string>} the date keys.
 */
export function holidaySet(table = BUILTIN_HOLIDAYS) {
  const set = new Set()
  if (table === null || typeof table !== 'object' || Array.isArray(table)) return set
  for (const days of Object.values(table)) {
    for (const key of daySet(days)) set.add(key)
  }
  return set
}

/**
 * A set of date keys from a flat list.
 *
 * The built-in table is grouped by year; a fetched one is a plain list of days,
 * and both have to end up as the same kind of set.
 * @param {string[]} days - `YYYY-MM-DD` entries.
 * @returns {Set<string>} the date keys.
 */
export function daySet(days) {
  const set = new Set()
  if (!Array.isArray(days)) return set
  for (const day of days) {
    const key = dateKeyOf(day)
    if (key !== undefined) set.add(key)
  }
  return set
}

/**
 * Whether a date is a public holiday.
 * @param {string} dateKey - `YYYY-MM-DD`.
 * @param {Set<string>|undefined} holidays - from {@link holidaySet}.
 * @returns {boolean} true when the day is off-peak all day.
 */
export function isPublicHoliday(dateKey, holidays) {
  if (holidays === undefined) return false
  return holidays.has(dateKey)
}
