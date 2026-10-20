/**
 * Unit tests for the low-quota reminder thresholds.
 *
 * Two rules carry the whole feature and both are easy to get wrong:
 *
 *   1. Zero means "off", not "warn about everything". A threshold of 0 is the
 *      default, so a plugin that treated it as armed would paint a red dot on
 *      every provider the moment it was installed.
 *   2. The comparison is strictly "below". A plan sitting exactly on the
 *      threshold the user typed is not below it, and a balance equal to the
 *      number the user typed is not below it either.
 *
 * Run with: node --test test/
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ALERT_WINDOWS, alertsForSnapshot, alertsOf, thresholdsOf } from '../lib/core/alerts.js'

/** A snapshot shaped the way `ProbeService` builds them. */
function snapshot(overrides = {}) {
  return { provider: 'opencode-go', displayName: 'OpenCode Go', ...overrides }
}

/** A plan with one window of the given key at the given spent percent. */
function plan(key, percent) {
  return { plan: { windows: [{ key, percent }] } }
}

test('no configuration at all means no reminder is armed', () => {
  for (const config of [undefined, null, {}, { alertEnabled: true }]) {
    const thresholds = thresholdsOf(config)
    assert.equal(thresholds.enabled, true)
    assert.equal(thresholds.balance, 0)
    assert.deepEqual(thresholds.windows, { '5h': 0, week: 0, month: 0 })
    assert.deepEqual(alertsOf([snapshot(plan('week', 99))], thresholds), [])
  }
})

test('a threshold is read from the config and keeps its kind', () => {
  const thresholds = thresholdsOf({
    alertBalanceBelow: 10,
    alertWindow5h: 20,
    alertWindowWeek: 30,
    alertWindowMonth: 40,
  })
  assert.equal(thresholds.balance, 10)
  assert.deepEqual(thresholds.windows, { '5h': 20, week: 30, month: 40 })
})

test('junk thresholds are read as off rather than as a warning', () => {
  const thresholds = thresholdsOf({
    alertBalanceBelow: 'abc',
    alertWindow5h: -5,
    alertWindowWeek: Number.NaN,
    alertWindowMonth: Number.POSITIVE_INFINITY,
  })
  assert.equal(thresholds.balance, 0)
  assert.deepEqual(thresholds.windows, { '5h': 0, week: 0, month: 0 })
})

test('disabling the reminder wins over every threshold that is set', () => {
  const thresholds = thresholdsOf({ alertEnabled: false, alertBalanceBelow: 999, alertWindow5h: 99 })
  assert.equal(thresholds.enabled, false)
  assert.deepEqual(alertsOf([snapshot({ balance: { currency: 'CNY', totalBalance: '1.00' }, ...plan('5h', 99) })], thresholds), [])
})

test('a balance strictly below the threshold is a reminder', () => {
  const thresholds = thresholdsOf({ alertBalanceBelow: 10 })
  const hits = alertsOf([snapshot({ balance: { currency: 'CNY', totalBalance: '3.20' } })], thresholds)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].kind, 'balance')
  assert.equal(hits[0].provider, 'opencode-go')
  assert.equal(hits[0].displayName, 'OpenCode Go')
  assert.equal(hits[0].currency, 'CNY')
  assert.equal(hits[0].amount, 3.2)
  assert.equal(hits[0].threshold, 10)
})

test('a balance exactly on the threshold, or above it, is not', () => {
  const thresholds = thresholdsOf({ alertBalanceBelow: 10 })
  assert.deepEqual(alertsOf([snapshot({ balance: { currency: 'CNY', totalBalance: 10 } })], thresholds), [])
  assert.deepEqual(alertsOf([snapshot({ balance: { currency: 'CNY', totalBalance: 10.01 } })], thresholds), [])
})

test('a missing or unreadable balance never invents a reminder', () => {
  const thresholds = thresholdsOf({ alertBalanceBelow: 10 })
  assert.deepEqual(alertsOf([snapshot()], thresholds), [])
  assert.deepEqual(alertsOf([snapshot({ balance: { currency: 'CNY' } })], thresholds), [])
  assert.deepEqual(alertsOf([snapshot({ balance: { currency: 'CNY', totalBalance: '--' } })], thresholds), [])
})

test('a window with less left than the threshold is a reminder', () => {
  const thresholds = thresholdsOf({ alertWindowWeek: 10 })
  const hits = alertsOf([snapshot(plan('week', 95))], thresholds)
  assert.equal(hits.length, 1)
  assert.equal(hits[0].kind, 'window')
  assert.equal(hits[0].window, 'week')
  assert.equal(hits[0].percent, 95)
  assert.equal(hits[0].remaining, 5)
  assert.equal(hits[0].threshold, 10)
})

test('the window comparison is on what is left, and it is strict', () => {
  const thresholds = thresholdsOf({ alertWindowWeek: 10 })
  // 90% spent leaves exactly 10%, which is not *below* 10.
  assert.deepEqual(alertsOf([snapshot(plan('week', 90))], thresholds), [])
  // 90.5% spent leaves 9.5%, which is.
  assert.equal(alertsOf([snapshot(plan('week', 90.5))], thresholds).length, 1)
  // A fresh window is never a reminder.
  assert.deepEqual(alertsOf([snapshot(plan('week', 0))], thresholds), [])
})

test('an unreadable window percent is skipped rather than guessed', () => {
  const thresholds = thresholdsOf({ alertWindowWeek: 10 })
  for (const percent of [undefined, null, '95', Number.NaN]) {
    assert.deepEqual(alertsOf([snapshot({ plan: { windows: [{ key: 'week', percent }] } })], thresholds), [])
  }
  assert.deepEqual(alertsOf([snapshot({ plan: { windows: [] } })], thresholds), [])
  assert.deepEqual(alertsOf([snapshot({ plan: {} })], thresholds), [])
})

test('every window a provider reports is judged on its own threshold', () => {
  const thresholds = thresholdsOf({ alertWindow5h: 20, alertWindowWeek: 10, alertWindowMonth: 5 })
  const hits = alertsOf(
    [snapshot({ plan: { windows: [{ key: '5h', percent: 85 }, { key: 'week', percent: 95 }, { key: 'month', percent: 90 }] } })],
    thresholds,
  )
  assert.deepEqual(hits.map((hit) => [hit.window, hit.remaining, hit.threshold]), [
    ['5h', 15, 20],
    ['week', 5, 10],
    // 10% left is not below the 5% threshold.
  ])
})

test('alerts from several providers each name their own provider', () => {
  const thresholds = thresholdsOf({ alertWindowWeek: 10, alertBalanceBelow: 1 })
  const hits = alertsOf(
    [
      snapshot({ provider: 'opencode-go', displayName: 'OpenCode Go', ...plan('week', 95) }),
      snapshot({ provider: 'deepseek-official', displayName: 'DeepSeek', balance: { currency: 'CNY', totalBalance: 0.5 } }),
      snapshot({ provider: 'openrouter' }),
    ],
    thresholds,
  )
  assert.deepEqual(hits.map((hit) => hit.provider), ['opencode-go', 'deepseek-official'])
  // A snapshot with no display name falls back to the route key rather than
  // rendering an empty label.
  assert.deepEqual(alertsOf([snapshot({ provider: 'zai', displayName: undefined, ...plan('week', 99) })], thresholds).map((hit) => hit.displayName), ['zai'])
})

test('a snapshot that is not an object cannot crash the sweep', () => {
  const thresholds = thresholdsOf({ alertWindowWeek: 10 })
  for (const bad of [undefined, null, 7, 'x', []]) {
    assert.deepEqual(alertsForSnapshot(bad, thresholds), [])
  }
  assert.deepEqual(alertsOf([undefined, null, snapshot(plan('week', 99))], thresholds).length, 1)
})

test('the three window keys are the only ones judged', () => {
  assert.deepEqual(ALERT_WINDOWS, ['5h', 'week', 'month'])
  const thresholds = thresholdsOf({ alertWindowWeek: 10 })
  // A window the plugin does not model has no threshold to compare against.
  assert.deepEqual(alertsOf([snapshot(plan('day', 99))], thresholds), [])
})
