/**
 * The low-quota reminder: which vendor facts sit below the user's thresholds.
 *
 * This module is pure on purpose. The numbers it judges arrive from third-party
 * endpoints, are cached for minutes, and may be stale or absent, so the one
 * question worth asking — "is this fact below the line the user drew?" — is
 * answered here, away from the network, the clock and the wire. Everything that
 * could make the answer interesting (a missing window, a null percentage, a
 * balance the provider sent as a string) is handled explicitly, and a fact that
 * cannot be judged is simply not judged: a reminder is a claim about a number,
 * so there is nothing to say when there is no number.
 *
 * Two shapes of threshold, because the two facts are not the same kind of thing:
 *
 * - A **plan window** reports how much of a quota is *spent*, so the user thinks
 *   in what is *left*. `alertWindow*` is therefore a percentage of quota
 *   remaining, and a window whose remaining share drops below it fires.
 * - A **balance** is already an amount, so `alertBalanceBelow` compares against
 *   it directly, in whatever currency the provider reported. There is no
 *   cross-currency conversion here, and there will not be one: a converted
 *   number would be an estimate, and this plugin never estimates money.
 *
 * A threshold of `0` means off. That is the shipped default for all of them, so
 * a fresh install shows no dots at all until the user asks for one.
 *
 * @module dsh-usage-stat/core/alerts
 */

/** The plan windows a threshold can be set for, in picker order. */
export const ALERT_WINDOWS = Object.freeze(['5h', 'week', 'month'])

/** The config field holding each window's threshold. */
const WINDOW_FIELDS = Object.freeze({
  '5h': 'alertWindow5h',
  week: 'alertWindowWeek',
  month: 'alertWindowMonth',
})

/** A threshold is only a threshold when it is a positive finite number. */
function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** An amount, whether the provider sent a number or a numeric string. */
function amountOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * Read the thresholds out of a plugin config.
 * @param {object|undefined} config - the config (or anything shaped like one).
 * @returns {{enabled: boolean, balance: number, windows: Record<string, number>}} the thresholds.
 */
export function thresholdsOf(config) {
  const source = typeof config === 'object' && config !== null ? config : {}
  /** @type {Record<string, number>} */
  const windows = {}
  for (const key of ALERT_WINDOWS) windows[key] = positive(source[WINDOW_FIELDS[key]])
  return {
    enabled: source.alertEnabled !== false,
    balance: positive(source.alertBalanceBelow),
    windows,
  }
}

/** Whether any threshold is actually set. */
function armed(thresholds) {
  if (thresholds?.enabled === false) return false
  if (positive(thresholds?.balance) > 0) return true
  return ALERT_WINDOWS.some((key) => positive(thresholds?.windows?.[key]) > 0)
}

/** The plan window a snapshot reports under `key`, when it reports one. */
function planWindow(snapshot, key) {
  const windows = snapshot?.plan?.windows
  if (!Array.isArray(windows)) return undefined
  return windows.find((entry) => entry?.key === key)
}

/**
 * Which of one provider's facts are below the thresholds.
 * @param {object} snapshot - a probe snapshot.
 * @param {{balance: number, windows: Record<string, number>}} thresholds - the thresholds.
 * @returns {object[]} one entry per fact that is below its line.
 */
export function alertsForSnapshot(snapshot, thresholds) {
  /** @type {object[]} */
  const hits = []
  if (snapshot === null || typeof snapshot !== 'object') return hits

  const balanceLine = positive(thresholds?.balance)
  if (balanceLine > 0) {
    const amount = amountOf(snapshot.balance?.totalBalance)
    if (amount !== undefined && amount < balanceLine) {
      hits.push({
        kind: 'balance',
        currency: typeof snapshot.balance?.currency === 'string' ? snapshot.balance.currency : '',
        amount,
        threshold: balanceLine,
      })
    }
  }

  for (const key of ALERT_WINDOWS) {
    const line = positive(thresholds?.windows?.[key])
    if (line <= 0) continue
    const window = planWindow(snapshot, key)
    const percent = typeof window?.percent === 'number' && Number.isFinite(window.percent)
      ? window.percent
      : undefined
    // A window with no percentage cannot be judged, so it is not a reminder.
    if (percent === undefined) continue
    const remaining = Math.max(0, 100 - percent)
    if (remaining < line) hits.push({ kind: 'window', window: key, percent, remaining, threshold: line })
  }

  return hits
}

/**
 * Every reminder across a roster of provider snapshots.
 *
 * Returns an empty list — not an error — when no threshold is set, so the
 * caller can put the result straight on the wire and the client can render
 * "nothing to remind about" without a special case.
 *
 * @param {Iterable<object>} snapshots - the probe snapshots.
 * @param {{enabled?: boolean, balance?: number, windows?: Record<string, number>}} thresholds - from {@link thresholdsOf}.
 * @returns {object[]} the reminders, each naming its provider.
 */
export function alertsOf(snapshots, thresholds) {
  if (!armed(thresholds)) return []
  /** @type {object[]} */
  const out = []
  for (const snapshot of snapshots ?? []) {
    for (const hit of alertsForSnapshot(snapshot, thresholds)) {
      out.push({
        provider: snapshot.provider,
        displayName: snapshot.displayName ?? snapshot.provider,
        ...hit,
      })
    }
  }
  return out
}
