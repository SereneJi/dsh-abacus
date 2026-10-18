#!/usr/bin/env node
/**
 * Verify that the *running* host is serving this plugin's current client half.
 *
 * The client bundle is hot-swapped: the host serves `plugins/??<pkg>/client.js`
 * under a content revision, and the browser only picks up a change when that
 * revision moves. So "I edited the file" and "the page runs the edit" are two
 * different facts, and only the second one is observable from a bug report.
 *
 * This asks the live module graph for the plugin's row, fetches the bundle the
 * browser would fetch, and asserts on markers that only exist in the current
 * source. It is a smoke check, not a test — it needs a running GUI.
 *
 * Usage:
 *   node tools/verify-served.mjs [--base=http://127.0.0.1:19387]
 *
 * The base defaults to $DSH_WEB_URL, then to the desktop default.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PKG = 'dsh-usage-stat'
const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT_PATH = join(HERE, '..', 'lib', 'client.js')

/**
 * Markers that must survive into the served bundle. Each one is a string this
 * plugin's source contains and a stale build would not; keep them few and
 * meaningful, because a marker that stops being interesting is a false alarm
 * generator.
 */
export const MARKERS = [
  ['the sidebar column is matched by class, not by a dead data attribute', 'sidebarCol'],
  ['the vendor tabs render their fact cards', 'vendor-card'],
  ['the plan tab renders a bar per rolling window', 'plan-window'],
  ['the daily chart renders columns', 'chart-col'],
  ['the composer pill opens a per-conversation panel', 'session-panel'],
  ['the conversation panel is styled like the shell’s context meter', 'dus-meter-segment'],
  ['a provider running low is marked with a dot', 'alert-dot'],
  ['the reminder thresholds are configurable', 'alertWindowWeek'],
  ['the account tab merges balances and plans per provider', 'account-card'],
  ['providers that cannot be queried fold away at the bottom', 'unavailable-row'],
  ['settings own a tab of their own', 'SettingsTab'],
  ['the chart spans the whole picked window', 'CHART_MAX_DAYS'],
  ['the settings page carries a heading of its own', 'dus-head-title'],
  ['the unconfigured-provider hint stops at a handful of names', 'catalogMore'],
  ['the settings form is built from titled panels', 'dus-panel-title'],
  ['the save action is the dialog’s filled primary button', 'dus-button-primary'],
  ['the settings form keeps the dialog row metrics', 'dus-form-row'],
  ['the plan windows of one provider share one grid', 'dus-windows'],
  ['each sidebar provider carries its own full-width bar', 'dus-share'],
  ['the reminder amount carries a unit mark', 'alert-unit'],
  ['the summary strip gives every figure an equal column', 'dus-metric + .dus-metric'],
  ['the model rows share one fixed name column', '--dus-model-name'],
  ['the daily chart names the peak it scales to', 'peakOf'],
  ['the settings page shows which version is running', 'dus-version'],
  ['the account tab says where a missing key goes', 'account-howto'],
  ['the settings page reports the state of the history scan', 'history-state'],
  ['the history scan can be run again on demand', 'backfill-button'],
  ['the daily chart labels the middle of its window', 'axisTicks'],
]

/** Markers that must NOT appear in the served bundle. */
export const FORBIDDEN = [
  ['the dead [data-pane="sidebar"] selector', 'data-pane'],
  ['the retired trend-window config field', 'trendDays'],
  ['the foot card settings link, removed because it read as a second account button', 'foot-card-open'],
  ['the retired Token bank tab', 'tabBank'],
  ['the removed settings-jump helper that scraped the shell’s nav', 'openSettingsSection'],
  ['the retention knob, removed because a limit only ever threw history away', 'retainDays'],
  ['the ledger size cap, removed for the same reason', 'ledgerMaxKb'],
  ['the split balance and plan tabs, merged into one account tab', 'BalanceTab'],
  ['the other half of the split, merged into one account tab', 'PlansTab'],
  ['the implementation-voice hint that talked about refreshing the host', '向宿主刷新'],
  ['the implementation-voice hint that talked about what is "checked"', '不检查这一项'],
  ['the uncapped unconfigured-provider hint', '还能查询：'],
  ['the replaced settings group heading', 'dus-group-title'],
  ['the replaced settings hint line, folded into the row hint', 'dus-hint'],
  ['the inline sidebar share stub, replaced by a full-width bar', 'dus-bar'],
  ['the brand colour used as ink on a brand fill, which vanished on a stock theme', 'border-color:transparent;color:var(--dsw-alias-brand-text'],
  ['the sidebar overflow line that pointed at a settings door the card does not have', '可在设置中查看'],
]

const base = (
  process.argv.find((arg) => arg.startsWith('--base='))?.slice('--base='.length) ||
  process.env.DSH_WEB_URL ||
  'http://127.0.0.1:19387'
).replace(/\/$/, '')

/**
 * Read the plugin's row out of the live module graph.
 *
 * `/plugins/events` is the one route that needs no browser cookie: it is an SSE
 * stream that pushes a `graph` frame on connect, so the row is read and the
 * stream aborted immediately.
 *
 * Never call `process.exit()` while that stream is open — Node trips a libuv
 * assertion (`UV_HANDLE_CLOSING`) on the way out. Set `process.exitCode`.
 * @returns {Promise<{url: string, rev?: string}|null>} the graph row, when present.
 */
async function readGraphRow() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 5000)
  try {
    const response = await fetch(`${base}/plugins/events`, { signal: controller.signal })
    if (!response.ok) return null
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (!buffer.includes('"graph"')) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
    }
    const line = buffer.split('\n').find((part) => part.startsWith('data:'))
    if (line === undefined) return null
    return JSON.parse(line.slice('data:'.length).trim()).graph?.entries?.find((entry) => entry.id === PKG) ?? null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

/**
 * The host appends a terminator and a `//# sourceMappingURL=…` line to every
 * served bundle, so the artifact is the source plus exactly that suffix. Strip
 * it before comparing, otherwise every run reports a spurious mismatch.
 * @param {string} body - the served bundle.
 * @returns {string} the body as it exists on disk.
 */
export function withoutHostSuffix(body) {
  return body
    .replace(/\n\/\/# sourceMappingURL=[^\n]*\n?$/, '\n')
    .replace(/\n;\n?$/, '\n')
}

/**
 * Compare a served bundle against the file on disk.
 *
 * Split out from the CLI so the three assertions can be tested without a
 * running host: they are the checks, and a check that only ever runs against a
 * live server is a check nobody has ever seen fail.
 * @param {string} servedRaw - the body the host returned, suffix and all.
 * @param {string} local - `lib/client.js` as it exists on disk.
 * @returns {{ problems: string[], notes: string[] }} what went wrong, and what was verified.
 */
export function auditServed(servedRaw, local) {
  const served = withoutHostSuffix(servedRaw)
  const problems = []
  const notes = []
  for (const [what, marker] of MARKERS) {
    if (served.includes(marker)) notes.push(`carries ${JSON.stringify(marker)} — ${what}`)
    else problems.push(`served bundle is missing ${JSON.stringify(marker)} — ${what}`)
  }
  for (const [what, marker] of FORBIDDEN) {
    if (served.includes(marker)) problems.push(`served bundle still carries ${JSON.stringify(marker)} — ${what}`)
    else notes.push(`free of ${JSON.stringify(marker)} — ${what}`)
  }
  // The exact comparison is the cheapest tell that the host served a stale
  // artifact even when every marker happens to survive a marker-preserving edit.
  if (served === local) notes.push(`matches lib/client.js byte for byte (${served.length} bytes)`)
  else problems.push(`served bundle differs from lib/client.js (${served.length} vs ${local.length} bytes) — the page is running a stale build (reload, or check the HMR watcher)`)
  return { problems, notes }
}

/** Whether this file was run rather than imported. */
function isMain() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

async function main() {
  const row = await readGraphRow()
  if (!row) {
    console.error(`could not read a "${PKG}" row from the module graph at ${base}`)
    console.error('is the desktop app running, and is the plugin enabled?')
    process.exitCode = 1
    return
  }
  console.log(`graph row: ${row.id} rev=${row.rev ?? '(none)'} url=${row.url}`)

  const servedRaw = await (await fetch(`${base}/${row.url.replace(/^\//, '')}`)).text()
  const { problems, notes } = auditServed(servedRaw, readFileSync(CLIENT_PATH, 'utf8'))

  for (const note of notes) console.log(`  ok    served bundle ${note}`)
  for (const problem of problems) console.error(`  FAIL  ${problem}`)

  if (problems.length > 0) {
    console.error(`\n${problems.length} check(s) failed.`)
    process.exitCode = 1
  } else {
    console.log('\nOK — the running host serves the current client half.')
  }
}

if (isMain()) await main()
