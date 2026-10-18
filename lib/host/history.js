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
 * so a false positive (the four bytes occurring inside compressed data) fails
 * and the next candidate is tried. Frame starts already consumed by a decoded
 * frame are skipped, which is what keeps a false positive from re-reading data
 * that was just decoded.
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
    const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
    try {
      text += zstdDecompressSync(buffer.subarray(from, end)).toString('utf8')
      consumed = end
    } catch {
      // Not a frame boundary, or a truncated tail frame. Either way there is
      // nothing to add, and the next candidate may still be a real frame.
    }
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
