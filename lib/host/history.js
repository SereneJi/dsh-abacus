/**
 * Reading the usage out of DSH's own session logs.
 *
 * The ledger only knows what the plugin was running to see: install it today and
 * yesterday is blank. DSH, however, already keeps every session on disk under
 * `$DSH_HOME/sessions/**\/session.v4.jsonl.zstd`, and those records carry the very
 * same `assistant/message` events — envelope, `usage` and `message.source`
 * included — that the live fold consumes. So the past can be replayed through
 * the same code path instead of guessed at from a second, weaker source.
 *
 * Two things make that replay safe rather than merely convenient:
 *
 * - Every event carries its own `seq`, and the fold already drops an event whose
 *   sequence is not past the row's stored one. Replaying a log therefore adds
 *   only what the ledger has not seen, whichever order the two arrive in. An
 *   event with no `seq` cannot be deduplicated at all, so it is skipped here.
 * - The day key comes from the event's own `time`, so a replayed settlement
 *   lands on the day it actually happened rather than on the day of the scan.
 *
 * The file is a CONCATENATION of zstd frames, one per append. Node's zstd
 * decoder reads only the first frame (`zstdDecompressSync`) and a stream stops
 * at the frame boundary with `ZSTD_error_prefix_unknown`, so the frames are
 * located by their magic number and decoded one at a time.
 *
 * @module dsh-usage-stat/host/history
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** The file name DSH writes a session's event log to. */
export const LOG_NAME = 'session.v4.jsonl.zstd'

/** Every zstd frame starts with these four bytes (little-endian `0xFD2FB528`). */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** A frame is never shorter than its magic number. */
const MAGIC_WIDTH = 4

/** `zstdDecompressSync` arrived in Node 22.15; older runtimes simply get no history. */
const CAN_DECODE = typeof zstdDecompressSync === 'function'

/**
 * Decode every zstd frame in a session log.
 *
 * Frames are found by scanning for the magic number, and a candidate slice is
 * accepted only when it decodes: `zstdDecompressSync` insists on an exact frame,
 * so a false positive (the four bytes occurring inside compressed data) fails.
 * A failure is retried once against the following boundary, because a false
 * positive makes the slice one frame too short rather than the frame invalid.
 * Frame starts already consumed by a decoded frame are skipped, which is what
 * keeps a false positive from re-reading data that was just decoded.
 * @param {Buffer} buffer - the raw file.
 * @returns {string} - the concatenated plain text, frames in order.
 */
export function framesToText(buffer) {
  if (!CAN_DECODE || buffer.length === 0) return ''
  const starts = []
  for (let at = buffer.indexOf(ZSTD_MAGIC); at !== -1; at = buffer.indexOf(ZSTD_MAGIC, at + MAGIC_WIDTH)) {
    starts.push(at)
  }
  if (starts.length === 0) return ''
  let text = ''
  let consumed = starts[0]
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index]
    if (from < consumed) continue
    // A frame is cut at the next magic number, which is right unless that magic
    // number was a false positive inside this frame's compressed data: the slice
    // is then one frame too short and does not decode. One extra hop recovers
    // that case. Slices are only ever widened, never shortened, so a real frame
    // boundary is never swallowed into the frame before it.
    let frame
    for (let hop = 1; hop <= 2; hop += 1) {
      const end = index + hop < starts.length ? starts[index + hop] : buffer.length
      try {
        frame = { text: zstdDecompressSync(buffer.subarray(from, end)).toString('utf8'), end }
        break
      } catch {
        // Not a frame boundary: try the one after it.
      }
      if (end === buffer.length) break
    }
    if (frame === undefined) continue
    text += frame.text
    consumed = frame.end
  }
  return text
}

/**
 * Parse a session log's text into events.
 *
 * A line that will not parse is dropped rather than failing the file: a log
 * being appended to can end mid-line, and one bad line is not a reason to lose
 * a session's history.
 * @param {string} text - the decoded text.
 * @returns {object[]} - the parsed events, in file order.
 */
export function eventsOfText(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      const event = JSON.parse(line)
      if (event !== null && typeof event === 'object') events.push(event)
    } catch {
      // A partially written trailing line.
    }
  }
  return events
}

/**
 * One settlement's identity, or `''` when the event settles nothing.
 *
 * The message id is what makes this precise: it is unique per message, it
 * survives into a copied log unchanged, and two different calls cannot share
 * one. Measured over the whole log set, the only ids that repeat are the ones a
 * copy repeats — nothing else collides.
 *
 * Events without an id fall back to what the call was and when it happened,
 * prefixed so the two kinds of key can never be confused. That fallback is good
 * enough to recognise a whole-log copy, but not to tell two unrelated sessions
 * apart, because a session's own sequence restarts at 1 — so nothing
 * de-duplicates across logs on it.
 * @param {object} event - one parsed session event.
 * @returns {string} - the key, or `''`.
 */
export function settlementKeyOf(event) {
  if (event.type !== 'assistant/message') return ''
  const usage = event.data?.usage
  if (usage === null || typeof usage !== 'object') return ''
  const id = event.data?.message?.id
  if (typeof id === 'string' && id !== '') return `id:${id}`
  const source = event.data?.message?.source ?? {}
  return `at:${event.time}\u0000${event.data?.turn}\u0000${event.data?.step}\u0000${source.provider}\u0000${source.model}`
}

/**
 * The settlements a log holds, as comparable identities.
 *
 * Two logs written by the same session at different times share no key. A log
 * COPIED from another shares every key, which is what makes a copy recognisable
 * without trusting a header field: `parentSession` and `isSeeded` are set on
 * every subagent session, and a subagent's own calls are real usage.
 * @param {object[]} events - the parsed events.
 * @returns {Set<string>} - one key per settlement.
 */
export function settlementKeys(events) {
  const keys = new Set()
  for (const event of events) {
    const key = settlementKeyOf(event)
    if (key !== '') keys.add(key)
  }
  return keys
}

/**
 * Split logs into the ones worth folding and the ones that only repeat another.
 *
 * DSH can write a session whose whole event log is a replay of a parent session
 * — opening a side conversation does exactly that — and the fold's replay guard
 * is keyed on the session id, so folding such a log counts the parent's calls a
 * second time. The log adds nothing: every settlement in it is already in the
 * log it was copied from.
 *
 * The containment has to be strict. Two logs with identical settlement sets
 * cannot be told apart, and guessing which wrote first would be worse than the
 * duplicate: it would throw away a real session. Such a pair is kept whole.
 *
 * @param {Array<{ sessionId: string, events: object[] }>} logs - the logs read from disk.
 * @returns {{ kept: object[], replays: object[] }} - the logs to fold, and the copies.
 */
export function withoutReplays(logs) {
  const keyed = logs.map((log) => ({ ...log, keys: settlementKeys(log.events) }))
  const kept = []
  const replays = []
  for (const log of keyed) {
    const covered =
      log.keys.size > 0 &&
      keyed.some(
        (other) => other !== log && other.keys.size > log.keys.size && isSubsetOf(log.keys, other.keys),
      )
    if (covered) replays.push(log)
    else kept.push(log)
  }
  return { kept, replays }
}

/**
 * Whether every member of one set is in another.
 * @param {Set<string>} inner - the candidate subset.
 * @param {Set<string>} outer - the candidate superset.
 * @returns {boolean} - true when nothing in `inner` is missing from `outer`.
 */
function isSubsetOf(inner, outer) {
  for (const key of inner) {
    if (!outer.has(key)) return false
  }
  return true
}

/**
 * The session id a log belongs to.
 *
 * The header DSH writes first names it. The containing directory is named after
 * the session too, so it is the fallback when the header is unreadable.
 * @param {object[]} events - the parsed events.
 * @param {string} path - the log's path.
 * @returns {string} - the session id, or `''`.
 */
export function sessionIdOf(events, path) {
  for (const event of events) {
    if (event.type === 'session' && typeof event.id === 'string' && event.id !== '') return event.id
  }
  const parts = String(path).split(/[\\/]/)
  for (let index = parts.length - 2; index >= 0; index -= 1) {
    if (parts[index] !== '') return parts[index]
  }
  return ''
}

/**
 * Every session log under a root, newest file first.
 *
 * Newest first because a session that just ended is the one most likely to hold
 * usage the ledger missed, so a scan cut short has still covered the useful end.
 * @param {string} root - the sessions directory.
 * @returns {Promise<string[]>} - the log paths, newest first.
 */
export async function sessionLogPaths(root) {
  const found = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(path)
      } else if (entry.isFile() && entry.name === LOG_NAME) {
        found.push(path)
      }
    }
  }
  found.sort((a, b) => b.localeCompare(a))
  return found
}

/**
 * Read one session log into events.
 * @param {string} path - the log's path.
 * @returns {Promise<{ sessionId: string, events: object[] }>} - the log, or an empty one.
 */
export async function readSessionLog(path) {
  let buffer
  try {
    buffer = await readFile(path)
  } catch {
    return { sessionId: '', events: [] }
  }
  const events = eventsOfText(framesToText(buffer))
  return { sessionId: sessionIdOf(events, path), events }
}
