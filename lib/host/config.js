/**
 * This plugin's own configuration: the values the 用量统计 settings card edits,
 * their defaults, their bounds, and their file.
 *
 * The plugin deliberately does **not** expose a schemastery `Config` schema.
 * A schema would make the Host render the form, which couples the plugin to
 * the Host's settings-surface version and hides the values behind the Host's
 * own edit path. Instead the values live in one small JSON file this plugin
 * owns, are edited through `POST api/abacus/config`, and are validated by
 * {@link normalizeConfig} on every read — so a hand-edited file can never put
 * the service into a state the UI cannot express.
 *
 * @module dsh-abacus/host/config
 */

import { normalizePrices } from '../core/pricing.js'

/** The shipped defaults. */
export const DEFAULT_CONFIG = Object.freeze({
  /** Whether the host folds usage and the browser renders any surface. */
  enabled: true,
  /**
   * Browser refresh cadence in seconds.
   *
   * Usage is folded from live session events, so a poll costs one small local
   * read; a minute is frequent enough to watch a conversation grow and quiet
   * enough not to matter in a devtools network panel.
   */
  pollIntervalSec: 60,
  /** Whether the host may call vendor balance and plan endpoints. */
  probeEnabled: true,
  /**
   * Seconds between vendor probe cycles.
   *
   * Five minutes by default, and deliberately unrelated to `pollIntervalSec`:
   * these calls leave the machine, hit third-party rate limits, and return
   * numbers that move on the scale of hours.
   */
  probeIntervalSec: 300,
  /** Master switch for the low-quota reminder dots. */
  alertEnabled: true,
  /** Balance below this amount (in the vendor's own currency) raises a reminder; 0 is off. */
  alertBalanceBelow: 0,
  /** Plan windows whose *remaining* share is below this percentage raise a reminder; 0 is off. */
  alertWindow5h: 0,
  alertWindowWeek: 0,
  alertWindowMonth: 0,
  /**
   * The user's own price rows, in CNY per million tokens, keyed by model id.
   *
   * Empty by default: the built-in rows in `core/pricing.js` price the DeepSeek
   * official family, and everything else this machine runs is a relay or
   * subscription route whose price only the user knows. The table is stored as
   * data rather than compiled in so correcting a price also corrects the money
   * the plugin reports for calls that already happened.
   */
  prices: Object.freeze({}),
})

/** Accepted bounds per numeric field; the settings UI derives its inputs from these. */
export const CONFIG_BOUNDS = Object.freeze({
  pollIntervalSec: Object.freeze({ min: 5, max: 600 }),
  probeIntervalSec: Object.freeze({ min: 60, max: 3600 }),
  alertBalanceBelow: Object.freeze({ min: 0, max: 1000000 }),
  alertWindow5h: Object.freeze({ min: 0, max: 100 }),
  alertWindowWeek: Object.freeze({ min: 0, max: 100 }),
  alertWindowMonth: Object.freeze({ min: 0, max: 100 }),
})

/** Coerce an untrusted value into a finite integer inside `bounds`, else the fallback. */
function boundedInt(value, bounds, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const rounded = Math.round(value)
  if (rounded < bounds.min) return bounds.min
  if (rounded > bounds.max) return bounds.max
  return rounded
}

/**
 * Validate an untrusted configuration object, filling in defaults. Never
 * throws; every field is independently repaired.
 * @param {unknown} value - the untrusted config (a parsed file, or a request body).
 * @returns {import('../core/types.js').UsageConfig} a complete, in-bounds config.
 */
export function normalizeConfig(value) {
  const source = typeof value === 'object' && value !== null ? /** @type {Record<string, unknown>} */ (value) : {}
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : DEFAULT_CONFIG.enabled,
    pollIntervalSec: boundedInt(source.pollIntervalSec, CONFIG_BOUNDS.pollIntervalSec, DEFAULT_CONFIG.pollIntervalSec),
    probeEnabled: typeof source.probeEnabled === 'boolean' ? source.probeEnabled : DEFAULT_CONFIG.probeEnabled,
    probeIntervalSec: boundedInt(source.probeIntervalSec, CONFIG_BOUNDS.probeIntervalSec, DEFAULT_CONFIG.probeIntervalSec),
    alertEnabled: typeof source.alertEnabled === 'boolean' ? source.alertEnabled : DEFAULT_CONFIG.alertEnabled,
    alertBalanceBelow: boundedInt(source.alertBalanceBelow, CONFIG_BOUNDS.alertBalanceBelow, DEFAULT_CONFIG.alertBalanceBelow),
    alertWindow5h: boundedInt(source.alertWindow5h, CONFIG_BOUNDS.alertWindow5h, DEFAULT_CONFIG.alertWindow5h),
    alertWindowWeek: boundedInt(source.alertWindowWeek, CONFIG_BOUNDS.alertWindowWeek, DEFAULT_CONFIG.alertWindowWeek),
    alertWindowMonth: boundedInt(source.alertWindowMonth, CONFIG_BOUNDS.alertWindowMonth, DEFAULT_CONFIG.alertWindowMonth),
    prices: normalizePrices(source.prices),
  }
}

/**
 * Apply a partial update to a config, ignoring unknown keys and repairing
 * out-of-bounds values. Used by the settings route, which must never accept a
 * field the UI does not offer.
 * @param {import('../core/types.js').UsageConfig} current - the live config.
 * @param {unknown} patch - the untrusted partial update.
 * @returns {import('../core/types.js').UsageConfig} the updated config.
 */
export function patchConfig(current, patch) {
  if (typeof patch !== 'object' || patch === null) return current
  const source = /** @type {Record<string, unknown>} */ (patch)
  /** @type {Record<string, unknown>} */
  const next = {}
  if ('enabled' in source) next.enabled = source.enabled
  if ('pollIntervalSec' in source) next.pollIntervalSec = source.pollIntervalSec
  if ('probeEnabled' in source) next.probeEnabled = source.probeEnabled
  if ('probeIntervalSec' in source) next.probeIntervalSec = source.probeIntervalSec
  if ('alertEnabled' in source) next.alertEnabled = source.alertEnabled
  if ('alertBalanceBelow' in source) next.alertBalanceBelow = source.alertBalanceBelow
  if ('alertWindow5h' in source) next.alertWindow5h = source.alertWindow5h
  if ('alertWindowWeek' in source) next.alertWindowWeek = source.alertWindowWeek
  if ('alertWindowMonth' in source) next.alertWindowMonth = source.alertWindowMonth
  if ('prices' in source) next.prices = source.prices
  return normalizeConfig({ ...current, ...next })
}
