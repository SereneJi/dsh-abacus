/**
 * The disjoint token buckets this plugin aggregates, plus their arithmetic.
 *
 * One bucket set is the atomic unit of the whole plugin: the ledger folds it
 * per call, the HTTP routes serve sums of it, and the browser renders it. The
 * five numeric fields are disjoint by construction (billed input is
 * `inputTokens + cacheReadTokens + cacheWriteTokens`), so summing buckets can
 * never double count.
 *
 * Field naming: `inputTokens` is the *uncached* input. The DSH session
 * projection spells the same quantity `uncachedInputTokens`; the host maps
 * that spelling onto this one at the fold site so nothing downstream has to
 * know both.
 *
 * @module dsh-usage-stat/core/totals
 */

/** The bucket field names, in the display order the UI uses. */
export const BUCKET_KEYS = Object.freeze([
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
])

/**
 * A zeroed bucket set.
 * @returns {import('./types.js').TokenTotals} a fresh, all-zero bucket.
 */
export function emptyTotals() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    calls: 0,
  }
}

/**
 * Add `right` into `left` in place.
 * @param {import('./types.js').TokenTotals} left - the bucket to mutate.
 * @param {Readonly<import('./types.js').TokenTotals>} right - the bucket to add.
 * @returns {import('./types.js').TokenTotals} `left`, for chaining.
 */
export function addTotals(left, right) {
  left.inputTokens += right.inputTokens
  left.outputTokens += right.outputTokens
  left.cacheReadTokens += right.cacheReadTokens
  left.cacheWriteTokens += right.cacheWriteTokens
  left.reasoningTokens += right.reasoningTokens
  left.calls += right.calls
  return left
}

/**
 * Total billed tokens of a bucket set: every disjoint input bucket plus the
 * output. Reasoning tokens are *inside* output and are therefore never added.
 * @param {Readonly<import('./types.js').TokenTotals>} totals - the bucket.
 * @returns {number} the token total.
 */
export function totalTokens(totals) {
  return totals.inputTokens + totals.cacheReadTokens + totals.cacheWriteTokens + totals.outputTokens
}

/**
 * Whether a bucket carries anything at all. Used to drop no-op folds so the
 * ledger never grows a row for an event that reported nothing.
 * @param {Readonly<import('./types.js').TokenTotals>} totals - the bucket.
 * @returns {boolean} true when at least one token or call was recorded.
 */
export function hasUsage(totals) {
  return totals.calls > 0 || totalTokens(totals) > 0
}
