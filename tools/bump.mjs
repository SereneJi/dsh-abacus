#!/usr/bin/env node
/**
 * Move the plugin to its next version.
 *
 * The version lives in `package.json` — the host reads it from there at runtime
 * (`lib/host/version.js`) and the settings page shows what it finds. What this
 * script adds is the rest of a release, which no single file holds: the changelog
 * heading, the version badge both READMEs wear, and a reminder of the steps that
 * are easy to forget.
 *
 *   node tools/bump.mjs patch          # 0.7.2 -> 0.7.3
 *   node tools/bump.mjs minor          # 0.7.2 -> 0.8.0
 *   node tools/bump.mjs major          # 0.7.2 -> 1.0.0
 *   node tools/bump.mjs 1.0.0-rc.1     # an explicit version
 *   node tools/bump.mjs minor --dry-run
 *
 * It writes `package.json` and inserts an empty changelog section; it does not
 * commit, tag, or publish. Filling the section in is the point of writing one.
 *
 * @module dsh-abacus/tools/bump
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = join(ROOT, 'package.json')
const CHANGELOG = join(ROOT, 'CHANGELOG.md')
/** The READMEs wear the version in a shields.io badge; a release moves it too. */
const BADGED = [join(ROOT, 'README.md'), join(ROOT, 'README.en.md')]

/** `major` / `minor` / `patch` / `1.2.3`, or nothing. */
const RELEASES = new Set(['major', 'minor', 'patch'])
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
/**
 * The version inside a shields.io version badge, colour included. Anchored on
 * the badge's own URL and stopped by the query string, so it cannot touch a
 * version mentioned in prose — a README that talks about what changed in 0.6.2
 * must keep saying 0.6.2.
 *
 * The whole `0.8.0-4c6ef5` tail is replaced rather than just the semver: a
 * prerelease (`1.0.0-rc.1`) and a colour (`-4c6ef5`) are the same shape, so
 * there is no way to peel one off the other. The script owns the badge.
 */
const BADGE = /(img\.shields\.io\/badge\/version-)[^?"\s]*/
const BADGE_COLOR = '4c6ef5'

/**
 * The version after a release kind.
 * @param {string} current - the current version.
 * @param {string} kind - `major`, `minor` or `patch`.
 * @returns {string} the next version.
 */
export function nextVersion(current, kind) {
  const [major, minor, patch] = current.split('-')[0].split('.').map(Number)
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

/** Today in the changelog's own format. */
export function today(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

/**
 * A changelog with an empty section for the new version spliced in under the
 * preamble, above the newest existing section.
 * @param {string} changelog - the current changelog.
 * @param {string} version - the version to open a section for.
 * @param {string} date - the section's date.
 * @returns {string} the new changelog.
 */
export function spliceChangelog(changelog, version, date) {
  const heading = `## ${version} — ${date}`
  const split = changelog.indexOf('\n## ')
  const preamble = (split === -1 ? changelog : changelog.slice(0, split)).trimEnd()
  const rest = split === -1 ? '' : changelog.slice(split + 1)
  return `${preamble}\n\n${heading}\n\n### Added\n\n- \n\n### Changed\n\n- \n\n### Fixed\n\n- \n\n${rest}`
}

/** Whether this file was run rather than imported. */
function isMain() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

/**
 * A README whose version badge carries the new version. A README without one
 * comes back unchanged, so adding or dropping the badge is never a crash.
 * @param {string} markdown - the README.
 * @param {string} version - the version to put in the badge.
 * @returns {string} the README.
 */
export function spliceBadge(markdown, version) {
  return markdown.replace(BADGE, `$1${version}-${BADGE_COLOR}`)
}

function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const target = args.find((arg) => !arg.startsWith('--'))

  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  const current = manifest.version

  if (target === undefined) {
    console.error(`usage: node tools/bump.mjs <major|minor|patch|X.Y.Z> [--dry-run]
current version: ${current}`)
    process.exit(2)
  }
  if (!RELEASES.has(target) && !SEMVER.test(target)) {
    console.error(`"${target}" is not a release kind or a version. Use major, minor, patch, or something like 1.2.3.`)
    process.exit(2)
  }

  const version = RELEASES.has(target) ? nextVersion(current, target) : target
  if (version === current) {
    console.error(`the plugin is already at ${current}.`)
    process.exit(1)
  }

  // `package.json` keeps its key order and its two-space indent: the diff of a
  // release should be the number, not the whole file.
  const updated = readFileSync(MANIFEST, 'utf8').replace(/"version": "[^"]*"/, `"version": "${version}"`)
  const changelog = readFileSync(CHANGELOG, 'utf8')
  if (changelog.includes(`## ${version} `)) {
    console.error(`${CHANGELOG} already has a section for ${version}.`)
    process.exit(1)
  }
  const filled = spliceChangelog(changelog, version, today())
  const readmes = BADGED.map((path) => ({ path, body: spliceBadge(readFileSync(path, 'utf8'), version) }))

  if (dryRun) {
    console.log(`${current} -> ${version} (dry run, nothing written)`)
    process.exit(0)
  }

  writeFileSync(MANIFEST, updated)
  writeFileSync(CHANGELOG, filled)
  for (const readme of readmes) writeFileSync(readme.path, readme.body)

  console.log(`${current} -> ${version}

Wrote:
  package.json   the new version (the host reads it at runtime, and the settings page shows it)
  CHANGELOG.md   an empty ## ${version} — ${today()} section
  README.md      the version badge
  README.en.md   the version badge

Still to do:
  1. Fill in the changelog section. An empty one is worse than none.
  2. npm test && npm run check-tokens && npm run verify-served
  3. If the design moved, npm run preview and look at the pictures.
  4. git commit, then: git tag baseline-${version}
     The tag is what makes this version revertible on its own — see
     tools/rollback.mjs. Baseline tags stay local; only main is pushed.`)
}

if (isMain()) main()
