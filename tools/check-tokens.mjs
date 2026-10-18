#!/usr/bin/env node
/**
 * Design-token audit.
 *
 * This plugin's CSS deliberately owns no colours: every value comes from the
 * shell's `--dsw-*` design tokens, which is what keeps it looking native and
 * makes it follow the active theme (including third-party skins) for free.
 * The cost of that choice is a coupling: if a DSH upgrade renames or drops a
 * token, the declaration silently falls back to nothing and the card renders
 * unstyled.
 *
 * So this script closes the loop. It reads the tokens this plugin consumes
 * straight out of `lib/client.js`, collects the tokens the *running* shell
 * actually defines, and reports the difference. Run it after any DSH upgrade:
 *
 *     node tools/check-tokens.mjs
 *     node tools/check-tokens.mjs --base=http://127.0.0.1:19387 --verbose
 *
 * A `var(--token)` with no fallback is a hard requirement and fails the run.
 * A `var(--token, fallback)` is informational: the fallback is what renders if
 * the token disappears.
 */

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT = join(ROOT, 'lib', 'client.js')

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const hit = args.find((arg) => arg.startsWith(`--${name}=`))
  return hit === undefined ? fallback : hit.slice(name.length + 3)
}
const BASE = flag('base', process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387').replace(/\/+$/, '')
const VERBOSE = args.includes('--verbose')

/**
 * Every `--dsw-*` token a bundle's CSS consumes, split by hard requirement.
 *
 * `var(--token)` with no fallback is a hard requirement; `var(--token, x)` is
 * informational because the fallback is what renders if the token disappears.
 * Exported so the rule can be tested on a fixed string instead of only on
 * whatever `lib/client.js` happens to say today.
 * @param {string} source - a bundle's text.
 * @returns {{ required: Set<string>, optional: Set<string> }}
 */
export function consumedFrom(source) {
  const css = [...source.matchAll(/var\((--dsw-[a-z0-9-]+)\s*(,?)/g)]
  const required = new Set()
  const optional = new Set()
  for (const [, name, comma] of css) {
    if (comma === ',') optional.add(name)
    else required.add(name)
  }
  return { required, optional }
}

/**
 * Every `--dsw-*: value` declaration a served bundle contains, first owner wins.
 * @param {string} body - a served bundle's text.
 * @param {string} owner - the bundle id, recorded as the definition's source.
 * @returns {Map<string, string>} token name to owning bundle id.
 */
export function definedIn(body, owner) {
  const defined = new Map()
  for (const [, name] of body.matchAll(/(--dsw-[a-z0-9-]+)\s*:/g)) {
    if (!defined.has(name)) defined.set(name, owner)
  }
  return defined
}

/** Every `--dsw-*` token this plugin's CSS consumes, split by hard requirement. */
async function consumedTokens() {
  return consumedFrom(await readFile(CLIENT, 'utf8'))
}

/** Read one SSE `graph` frame; it is unauthenticated, unlike the GUI root. */
async function readGraph() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const res = await fetch(`${BASE}/plugins/events`, { signal: controller.signal })
    if (!res.ok) throw new Error(`GET /plugins/events -> ${res.status}`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (!buffer.includes('"graph"')) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
    }
    const line = buffer.split('\n').find((row) => row.startsWith('data:'))
    if (line === undefined) throw new Error('no data frame on /plugins/events')
    return JSON.parse(line.slice(5).trim()).graph.entries
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

/** Every `--dsw-*: value` declaration the served client bundles contain. */
async function definedTokens(entries) {
  const defined = new Map()
  for (const entry of entries) {
    let body
    try {
      const res = await fetch(`${BASE}/${entry.url}`)
      if (!res.ok) continue
      body = await res.text()
    } catch {
      continue
    }
    let found = 0
    const declared = definedIn(body, entry.id)
    for (const [name, owner] of declared) {
      found += 1
      if (!defined.has(name)) defined.set(name, owner)
    }
    if (VERBOSE && found > 0) console.log(`  ${entry.id}: ${found} declarations`)
  }
  return defined
}

/** Whether this file was run rather than imported. */
function isMain() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

async function main() {
  const { required, optional } = await consumedTokens()
  console.log(`consumes ${required.size} required + ${optional.size} optional --dsw-* tokens from lib/client.js`)

  const entries = await readGraph()
  console.log(`scanning ${entries.length} served client bundles at ${BASE} …`)
  const defined = await definedTokens(entries)
  console.log(`the running shell defines ${defined.size} distinct --dsw-* tokens\n`)

  const missingRequired = [...required].filter((name) => !defined.has(name)).sort()
  const missingOptional = [...optional].filter((name) => !defined.has(name)).sort()

  if (VERBOSE) {
    for (const name of [...required].sort()) console.log(`  ${defined.has(name) ? 'ok  ' : 'MISS'} ${name}  <- ${defined.get(name) ?? '-'}`)
    console.log('')
  }

  if (missingOptional.length > 0) {
    console.log(`optional, currently falling back (${missingOptional.length}):`)
    for (const name of missingOptional) console.log(`  ${name}`)
    console.log('')
  }

  if (missingRequired.length > 0) {
    console.error(`FAIL — ${missingRequired.length} required token(s) the shell does not define:`)
    for (const name of missingRequired) console.error(`  ${name}`)
    console.error('\nEither the token was renamed upstream (update lib/client.js) or this build is older than the plugin expects.')
    process.exitCode = 1
    return
  }

  console.log(`OK — all ${required.size} required tokens are defined by the running shell.`)
}

if (isMain()) await main()
