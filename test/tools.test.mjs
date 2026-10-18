/**
 * Tests for the scripts in `tools/`.
 *
 * These are the checks that guard the plugin's own checks: the token audit, the
 * served-bundle comparison, the preview bench's extraction rules, the version
 * bumper and the rollback reporter. They are pure-function tests on purpose —
 * the scripts' interesting half is the part that decides, not the part that
 * talks to git or a running host, and that half was previously reachable only
 * by running the script against whatever happened to be installed.
 *
 * The one integration check (the rollback dry run against this repository) is
 * skipped rather than failed when git or a pipe is unavailable, because a
 * sandbox that forbids spawning must not be reported as a broken tool.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { nextVersion, spliceBadge, spliceChangelog, today } from '../tools/bump.mjs'
import { consumedFrom, definedIn } from '../tools/check-tokens.mjs'
import { RAIL_ROWS, attributesOf, pluginCssFrom, serialize, styleText, tokensOf } from '../tools/preview.mjs'
import { confirmedFrom, newestBaseline, report, tagFrom } from '../tools/rollback.mjs'
import { auditServed, FORBIDDEN, MARKERS, withoutHostSuffix } from '../tools/verify-served.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

//#region ------------------------------------------------------------- versioning

test('nextVersion moves the requested digit and drops a prerelease', () => {
  assert.equal(nextVersion('1.2.3', 'major'), '2.0.0')
  assert.equal(nextVersion('1.2.3', 'minor'), '1.3.0')
  assert.equal(nextVersion('1.2.3', 'patch'), '1.2.4')
  assert.equal(nextVersion('0.7.2', 'minor'), '0.8.0')
  assert.equal(nextVersion('1.2.3-rc.4', 'patch'), '1.2.4')
  assert.equal(nextVersion('9.9.9', 'major'), '10.0.0')
})

test('today formats a local date, not a UTC one', () => {
  assert.equal(today(new Date(2026, 9, 18, 23, 30)), '2026-10-18')
  assert.equal(today(new Date(2026, 0, 1, 0, 5)), '2026-01-01')
})

test('spliceChangelog opens a section under the preamble and keeps the rest', () => {
  const before = ['# Changelog', '', 'All notable changes.', '', '## 0.7.2 — 2026-10-18', '', '### Changed', '', '- older work', ''].join('\n')
  const after = spliceChangelog(before, '0.8.0', '2026-10-19')
  assert.match(after, /^# Changelog\n\nAll notable changes\.\n\n## 0\.8\.0 — 2026-10-19\n/)
  assert.match(after, /### Added\n\n- \n\n### Changed\n\n- \n\n### Fixed\n\n- \n/)
  assert.match(after, /## 0\.7\.2 — 2026-10-18\n\n### Changed\n\n- older work/)
  // The preamble keeps exactly one blank line before the new heading.
  assert.doesNotMatch(after, /\n\n\n## 0\.8\.0/)
})

test('spliceBadge moves the version badge and leaves prose versions alone', () => {
  const before = [
    '# dsh-usage-stat',
    '',
    '<img src="https://img.shields.io/badge/version-0.7.2-4c6ef5?style=flat-square" alt="Version">',
    '',
    'It was rebuilt in 0.7.2 and has not moved since.',
    '',
  ].join('\n')
  const after = spliceBadge(before, '0.8.0')
  assert.match(after, /badge\/version-0\.8\.0-4c6ef5/)
  // Only the badge moves: a sentence about what a past version changed must
  // keep naming that version.
  assert.match(after, /rebuilt in 0\.7\.2 and has not moved since\./)
  // A README without a badge is not an error, it is just left alone.
  assert.equal(spliceBadge('# nothing to see\n', '0.8.0'), '# nothing to see\n')
})

//#region --------------------------------------------------------- served bundle

test('withoutHostSuffix strips the host’s source-map tail and lone semicolon', () => {
  const body = 'const a = 1;\n;\n//# sourceMappingURL=??dsh-usage-stat/client.js.map&rev=abc\n'
  assert.equal(withoutHostSuffix(body), 'const a = 1;\n')
})

test('auditServed passes a bundle that carries every marker and nothing forbidden', () => {
  const body = `${MARKERS.map(([, marker]) => marker).join('\n')}\n`
  const { problems, notes } = auditServed(body, body)
  assert.deepEqual(problems, [])
  assert.ok(notes.some((note) => note.includes('byte for byte')))
})

test('auditServed names a missing marker', () => {
  const { problems } = auditServed('nothing here', 'nothing here')
  assert.ok(problems.some((problem) => problem.includes('missing') && problem.includes(MARKERS[0][1])))
})

test('auditServed names a marker that should have been removed', () => {
  const forbidden = FORBIDDEN[0][1]
  const { problems } = auditServed(`x ${forbidden} y`, `x ${forbidden} y`)
  assert.ok(problems.some((problem) => problem.includes('still carries') && problem.includes(forbidden)))
})

test('auditServed notices a served bundle that is not the file on disk', () => {
  const body = MARKERS.map(([, marker]) => marker).join('\n')
  const { problems } = auditServed(body, `${body}\n// a line the server never got`)
  assert.ok(problems.some((problem) => problem.includes('differs from lib/client.js')))
})

//#region ---------------------------------------------------------------- preview

test('pluginCssFrom lifts the stylesheet out of the bundle and refuses to guess', () => {
  assert.equal(pluginCssFrom('const x = 1\nconst CSS = `.a{color:red}`\nconst y = 2'), '.a{color:red}')
  assert.throws(() => pluginCssFrom('const x = 1'), /no longer declares/)
  assert.throws(() => pluginCssFrom('const CSS = `unterminated'), /unterminated/)
})

test('tokensOf keeps the first declaration, which is the light theme', () => {
  const source = '--dsw-alias-bg-layer-1: #ffffff; body[data-ds-dark-theme]{--dsw-alias-bg-layer-1: #000000;} --dsw-radius-md: 12px'
  const found = tokensOf(source)
  assert.equal(found.get('--dsw-alias-bg-layer-1'), '#ffffff')
  assert.equal(found.get('--dsw-radius-md'), '12px')
})

test('tokensOf ignores names that are not tokens and values that are empty', () => {
  const found = tokensOf('--dsw-alias-: ; --not-a-token: 1; --dsw-alias-label-primary:')
  assert.equal(found.size, 0)
})

test('styleText camel-cases names and only adds px to unitless-able numbers', () => {
  assert.equal(styleText({ width: '11%', marginTop: 4, opacity: 0.5 }), 'width:11%;margin-top:4px;opacity:0.5')
  assert.equal(styleText({ height: 3, lineHeight: 2 }), 'height:3px;line-height:2')
  assert.equal(styleText({ color: '', background: null }), '')
})

test('attributesOf writes aria booleans as strings and other booleans bare', () => {
  assert.equal(attributesOf({ 'aria-selected': true, checked: true, disabled: true }), ' aria-selected="true" checked disabled')
  assert.equal(attributesOf({ 'aria-selected': false, checked: false }), '')
  assert.equal(attributesOf({ className: 'dus-panel', onClick: () => {} }), ' class="dus-panel"')
  assert.equal(attributesOf({ children: ['x'], key: 'k' }), '')
  assert.equal(attributesOf({ value: 60, title: 'a"b' }), ' value="60" title="a&quot;b"')
})

test('serialize writes elements, text and void tags without inventing children', () => {
  const tree = {
    type: 'div',
    props: { className: 'card' },
    children: [
      { type: 'span', props: {}, children: ['hi'] },
      { type: 'input', props: { value: 3 }, children: [] },
      null,
      false,
      7,
    ],
  }
  assert.equal(serialize(tree), '<div class="card"><span>hi</span><input value="3">7</div>')
  assert.equal(serialize(null), '')
  assert.equal(serialize(['a', 'b']), 'ab')
})

test('the preview sidebar fills in invented session titles, never real ones', () => {
  // These strings are rasterised into preview/foot*.png, which are committed and
  // published. A failure here means someone edited the filler: make sure the
  // replacement is still invented before updating this list.
  assert.deepEqual(RAIL_ROWS, ['新会话', '帮我整理这批照片', '写一个周报模板', '这段报错是什么意思', '优化一下这段查询'])
  assert.equal(new Set(RAIL_ROWS).size, RAIL_ROWS.length)
})

//#region ------------------------------------------------------------ token audit

test('consumedFrom separates hard requirements from fallbacks', () => {
  const { required, optional } = consumedFrom('a{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1,#fff)}')
  assert.deepEqual([...required], ['--dsw-alias-label-primary'])
  assert.deepEqual([...optional], ['--dsw-alias-bg-layer-1'])
})

test('consumedFrom deduplicates and survives a token with no closing paren', () => {
  const { required, optional } = consumedFrom('var(--dsw-a) var(--dsw-a) var(--dsw-b')
  assert.deepEqual([...required], ['--dsw-a', '--dsw-b'])
  assert.equal(optional.size, 0)
})

test('definedIn keeps the first bundle that declared a token', () => {
  const defined = definedIn('--dsw-a: 1; --dsw-a: 2; --dsw-b: 3', 'theme')
  assert.equal(defined.get('--dsw-a'), 'theme')
  assert.equal(defined.size, 2)
})

//#region --------------------------------------------------------------- rollback

test('tagFrom takes --tag= and otherwise falls back', () => {
  assert.equal(tagFrom(['--tag=baseline-0.7.0']), 'baseline-0.7.0')
  assert.equal(tagFrom(['--yes']), 'baseline-0.6.2')
  assert.equal(tagFrom([], 'baseline-0.7.2'), 'baseline-0.7.2')
  assert.equal(confirmedFrom(['--tag=x', '--yes']), true)
  assert.equal(confirmedFrom(['--tag=x']), false)
})

test('newestBaseline compares versions as numbers and ignores other tags', () => {
  assert.equal(newestBaseline(['baseline-0.9.0', 'baseline-0.10.0', 'v1.0.0', 'baseline-0.7.2']), 'baseline-0.10.0')
  assert.equal(newestBaseline(['baseline-0.7.0', 'baseline-0.7.1']), 'baseline-0.7.1')
  assert.equal(newestBaseline(['v1.0.0', 'nonsense']), undefined)
})

test('report says what a dry run would do, and what a restore did', () => {
  const stat = 'lib/client.js | 144 +++++'
  const dry = report(stat, 'baseline-0.7.2', false).join('\n')
  assert.match(dry, /Restoring baseline-0\.7\.2 undoes these changes/)
  assert.match(dry, /lib\/client\.js \| 144/)
  assert.match(dry, /Dry run\. Re-run with --yes/)
  assert.doesNotMatch(dry, /Restored baseline/)

  const done = report(stat, 'baseline-0.7.2', true).join('\n')
  assert.match(done, /Restored baseline-0\.7\.2/)
  assert.match(done, /git checkout HEAD -- \./)
  assert.doesNotMatch(done, /Dry run/)

  assert.deepEqual(report('', 'baseline-0.7.2', true), ['Already identical to baseline-0.7.2. Nothing to restore.'])
})

test('the rollback dry run reports against this repository without touching it', () => {
  const run = spawnSync(process.execPath, ['tools/rollback.mjs'], { cwd: ROOT, encoding: 'utf8' })
  if (run.error !== undefined || run.status === null) {
    // No usable process spawn (a confined sandbox) — nothing to assert here.
    return
  }
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  if (/not a git repository|No such tag/.test(output)) return
  assert.equal(run.status, 0)
  assert.match(output, /Restoring baseline-|Already identical to baseline-/)
  assert.match(output, /Dry run|Already identical/)
})
