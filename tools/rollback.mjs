#!/usr/bin/env node
/**
 * Restore this package to a tagged design, in one command.
 *
 * The 0.7.0 settings redesign was tagged before it started, because a design is
 * the one kind of change a user cannot evaluate until it is in front of them —
 * and "I do not like it, put it back" must not depend on remembering a git
 * incantation. This wraps that incantation, refuses to guess, and reports what it
 * touched.
 *
 *   node tools/rollback.mjs                 # show what would change
 *   node tools/rollback.mjs --yes           # restore the default tag
 *   node tools/rollback.mjs --tag=v0.6.2 --yes
 *
 * It restores tracked files from the tag. Files the tag never had (this script,
 * `tools/preview.mjs`, `test/harness.mjs`, `preview/`) are left alone and simply
 * become unused; delete them if you want the tree to match the tag exactly.
 *
 * The client half hot-swaps, so a restore lands on the next page load. Anything
 * on the host half needs a dsh restart.
 */

import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_TAG = 'baseline-0.6.2'
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * The tag to restore: `--tag=<name>` if given, else `fallback`.
 * @param {string[]} argv - the process arguments.
 * @param {string} [fallback] - the tag to use when none was named.
 * @returns {string}
 */
export function tagFrom(argv, fallback = DEFAULT_TAG) {
  return argv.find((arg) => arg.startsWith('--tag='))?.slice('--tag='.length) || fallback
}

/**
 * The newest `baseline-*` tag, so the default undoes the last redesign rather
 * than the first one. Compared as numbers, because `baseline-0.10.0` is newer
 * than `baseline-0.9.0` and sorting the strings would say otherwise.
 * @param {string[]} tags - tag names.
 * @returns {string|undefined}
 */
export function newestBaseline(tags) {
  const versioned = tags
    .filter((name) => /^baseline-\d+\.\d+\.\d+$/.test(name))
    .map((name) => ({ name, parts: name.slice('baseline-'.length).split('.').map(Number) }))
  versioned.sort((a, b) => b.parts[0] - a.parts[0] || b.parts[1] - a.parts[1] || b.parts[2] - a.parts[2])
  return versioned[0]?.name
}

/**
 * Whether the user asked for the restore rather than the report.
 * @param {string[]} argv - the process arguments.
 * @returns {boolean}
 */
export function confirmedFrom(argv) {
  return argv.includes('--yes')
}

/**
 * What to print, given the diff between the working tree and the tag.
 *
 * Pure so the wording can be tested without a repository: the whole point of
 * this script is the sentence that tells a person what is about to happen.
 * @param {string} stat - `git diff --stat <tag>` output, already trimmed.
 * @param {string} tag - the tag being restored.
 * @param {boolean} confirmed - whether `--yes` was passed.
 * @returns {string[]} lines to print.
 */
export function report(stat, tag, confirmed) {
  if (stat === '') return [`Already identical to ${tag}. Nothing to restore.`]
  const lines = [`Restoring ${tag} undoes these changes:\n\n${stat}\n`]
  if (!confirmed) {
    lines.push('Dry run. Re-run with --yes to restore these files.')
    lines.push(`(nothing else is touched: files ${tag} never had are left in place)`)
    return lines
  }
  lines.push(`Restored ${tag}. The client half hot-swaps — reload the page.`)
  lines.push('If the host half changed too, restart dsh.')
  lines.push(`To go back to the redesign: git checkout HEAD -- .`)
  return lines
}

/** Run git in the package, returning stdout; throws with git's own message. */
function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function tagExists(name) {
  try {
    git(['rev-parse', '--verify', `refs/tags/${name}`])
    return true
  } catch {
    return false
  }
}

/** Whether this file was run rather than imported. */
function isMain() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

function main() {
  let tags = []
  try {
    tags = git(['tag', '--list']).split('\n').map((line) => line.trim()).filter(Boolean)
  } catch {
    tags = []
  }

  const tag = tagFrom(process.argv.slice(2), newestBaseline(tags) ?? DEFAULT_TAG)
  const confirmed = confirmedFrom(process.argv.slice(2))

  if (!tagExists(tag)) {
    console.error(`No such tag: ${tag}`)
    if (tags.length === 0) console.error('\nThis directory is not a git repository, so there is nothing to restore from.')
    else console.error(`\nTags in this repository:\n${tags.join('\n')}`)
    process.exitCode = 1
    return
  }

  const stat = git(['diff', '--stat', tag, '--', '.']).trim()
  for (const line of report(stat, tag, confirmed)) console.log(line)

  if (stat === '' || !confirmed) return

  git(['checkout', tag, '--', '.'])
}

if (isMain()) main()
