/**
 * `$DSH_HOME` resolution for this plugin's host half: the environment
 * override wins, the platform home fallback follows. Kept local (rather than
 * imported from another plugin) because this package must stay installable on
 * its own.
 *
 * @module dsh-usage-stat/dsh-home
 */

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { isAbsolute as posixIsAbsolute, join as posixJoin } from 'node:path/posix'

/**
 * Expand a leading `~` (or `~user`) in a path, platform-style.
 * @param {string} path - the path to expand.
 * @param {string} home - the platform home directory.
 * @returns {string} the expanded path.
 */
export function expandHome(path, home = homedir()) {
  const isPosix = home.startsWith('/')
  const j = isPosix ? posixJoin : join
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return j(home, path.slice(2))
  return path
}

/**
 * Resolve the DSH home directory.
 * @param {NodeJS.ProcessEnv} env - environment to read `DSH_HOME` from.
 * @param {string} home - platform home directory fallback (test seam).
 * @returns {string} the absolute DSH home path.
 */
export function resolveDshHome(env = process.env, home = homedir()) {
  const isPosix = home.startsWith('/')
  const j = isPosix ? posixJoin : join
  const isAbs = isPosix ? posixIsAbsolute : isAbsolute
  const raw = env.DSH_HOME
  if (raw !== undefined && raw.trim() !== '') {
    const expanded = expandHome(raw.trim(), home)
    return isAbs(expanded) ? expanded : j(process.cwd(), expanded)
  }
  return j(home, '.dsh')
}

/** Resolve the DSH home directory from the live environment. */
export function dshHome() {
  return resolveDshHome()
}
