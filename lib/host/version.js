/**
 * The plugin's own version, read from the `package.json` sitting next to it.
 *
 * The client half cannot read a file, and hard-coding the version in the bundle
 * would add a second place to bump — the whole point of showing it is that after
 * an upgrade you can tell which build is live. The host reads the manifest once,
 * at first use, and hands the string to the client with the rest of the overview.
 *
 * The manifest is always adjacent: the plugin loader reads `dsh.client` out of it
 * to serve the bundle at all. The read is still guarded, because a version line
 * is never worth failing an overview over.
 */

import { readFileSync } from 'node:fs'

const FALLBACK = '0.0.0'

let cached

/**
 * @returns {string} - the version in the adjacent manifest, or `'0.0.0'`.
 */
export function pluginVersion() {
  if (cached !== undefined) return cached
  try {
    const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))
    cached = typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : FALLBACK
  } catch {
    cached = FALLBACK
  }
  return cached
}
