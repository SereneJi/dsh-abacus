/**
 * Tests for the session-log reader.
 *
 * DSH writes each session as a stream of concatenated zstd frames, one JSON
 * event per frame. Reading them back is the whole point of this module, so the
 * tests build that exact shape — several independently compressed frames in one
 * file — rather than a single compressed blob, which would decode with a plain
 * one-shot call and prove nothing.
 *
 * Run with: node --test test/
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'

const {
  LOG_NAME,
  eventsOfText,
  framesToText,
  readSessionLog,
  sessionIdOf,
  sessionLogPaths,
  settlementKeys,
  withoutReplays,
} = await import('../lib/host/history.js')

/** One zstd frame per line, the way DSH appends them. */
function frames(...lines) {
  return Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(`${line}\n`))))
}

/** A temp directory that this test owns. */
function workdir() {
  return mkdtempSync(join(tmpdir(), 'dsh-usage-stat-history-'))
}

test('framesToText decodes every frame in a concatenated stream', () => {
  const buffer = frames('{"a":1}', '{"b":2}', '{"c":3}')
  assert.equal(framesToText(buffer), '{"a":1}\n{"b":2}\n{"c":3}\n')
})

test('framesToText survives a corrupt frame in the middle', () => {
  // A half-written tail is what a crash leaves behind. Losing the damaged frame
  // is fine; losing the frames around it is not.
  const good = frames('{"a":1}')
  const torn = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02])
  const tail = frames('{"c":3}')
  const text = framesToText(Buffer.concat([good, torn, tail]))
  assert.match(text, /\{"a":1\}/)
  assert.match(text, /\{"c":3\}/)
  assert.doesNotMatch(text, /b/)
})

test('framesToText returns an empty string for an empty buffer', () => {
  assert.equal(framesToText(Buffer.alloc(0)), '')
})

test('eventsOfText parses one event per line and drops the broken ones', () => {
  const events = eventsOfText('{"type":"session","id":"s1"}\nnot json\n\n{"type":"assistant/message"}\n')
  assert.deepEqual(events, [{ type: 'session', id: 's1' }, { type: 'assistant/message' }])
})

test('sessionIdOf reads the session event, and falls back to the directory name', () => {
  assert.equal(sessionIdOf([{ type: 'session', id: 'session-abc' }], join('/x/y', 'session-xyz', LOG_NAME)), 'session-abc')
  assert.equal(sessionIdOf([{ type: 'assistant/message' }], join('/x/y', 'session-xyz', LOG_NAME)), 'session-xyz')
  assert.equal(sessionIdOf([], LOG_NAME), '', 'a bare file name has no directory to borrow a name from')
})

test('sessionLogPaths walks nested session directories and prefers the newest', async () => {
  const root = workdir()
  mkdirSync(join(root, 'session-a'), { recursive: true })
  mkdirSync(join(root, 'session-b', 'nested'), { recursive: true })
  writeFileSync(join(root, 'session-a', LOG_NAME), frames('{"a":1}'))
  writeFileSync(join(root, 'session-b', 'nested', LOG_NAME), frames('{"b":2}'))
  writeFileSync(join(root, 'session-a', 'notes.txt'), 'ignore me')

  const paths = await sessionLogPaths(root)
  assert.equal(paths.length, 2, 'only the session logs are picked up')
  assert.ok(paths.every((path) => path.endsWith(LOG_NAME)))
  assert.deepEqual(paths, [...paths].sort().reverse(), 'newest paths come first')
})

test('sessionLogPaths answers an empty list for a missing root', async () => {
  assert.deepEqual(await sessionLogPaths(join(workdir(), 'nowhere')), [])
})

test('readSessionLog returns the session id and its events', async () => {
  const root = workdir()
  const dir = join(root, 'session-abc')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, LOG_NAME)
  writeFileSync(path, frames('{"type":"session","id":"session-abc"}', '{"type":"assistant/message","seq":2}'))

  const log = await readSessionLog(path)
  assert.equal(log.sessionId, 'session-abc')
  assert.equal(log.events.length, 2)
  assert.equal(log.events[1].seq, 2)
})

test('readSessionLog reports an unreadable file instead of throwing', async () => {
  const log = await readSessionLog(join(workdir(), 'gone', LOG_NAME))
  assert.deepEqual(log.events, [])
  assert.equal(typeof log.sessionId, 'string')
})

/** One settlement event, the shape the fold keys its replay guard on. */
function settlement(seq, time, turn, step) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn,
      step,
      usage: { inputTokens: 10, outputTokens: 2 },
      message: { source: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' } },
    },
  }
}

test('settlementKeys names a settlement by when it happened and what served it', () => {
  const keys = settlementKeys([
    settlement(1, 1000, 1, 1),
    settlement(2, 2000, 1, 2),
    // Not a settlement: a request header carries no usage.
    { type: 'request/header', seq: 3, time: 3000, data: {} },
    // A settlement with no usage cannot be compared, so it is not a key either.
    { type: 'assistant/message', seq: 4, time: 4000, data: { turn: 2, step: 1 } },
  ])
  assert.equal(keys.size, 2)
  // Two calls at the same step of different turns are two different calls, which
  // is why the turn and step are part of the identity and not just the clock.
  assert.notEqual([...keys][0], [...keys][1])
  // The same settlement read twice is the same key, which is what makes a copy
  // of a log recognisable.
  assert.deepEqual([...settlementKeys([settlement(9, 1000, 1, 1)])], [...keys].slice(0, 1))
})

test('withoutReplays drops a log whose settlements are all in a bigger log', () => {
  const parent = {
    sessionId: 'session-parent',
    events: [settlement(1, 1000, 1, 1), settlement(2, 2000, 1, 2), settlement(3, 3000, 2, 1)],
  }
  // A side conversation copies the parent's log and then writes its own header.
  // Its settlements are a subset, and folding it would count the parent twice.
  const copy = { sessionId: 'session-copy', events: [settlement(1, 1000, 1, 1), settlement(2, 2000, 1, 2)] }
  const other = { sessionId: 'session-other', events: [settlement(1, 500, 1, 1)] }

  const { kept, replays } = withoutReplays([parent, copy, other])
  assert.deepEqual(
    kept.map((log) => log.sessionId),
    ['session-parent', 'session-other'],
  )
  assert.deepEqual(
    replays.map((log) => log.sessionId),
    ['session-copy'],
  )
})

test('withoutReplays keeps a pair it cannot tell apart, and keeps a log with no calls', () => {
  // Identical settlement sets: guessing which one wrote first would throw away a
  // real session, so neither is dropped. The duplicate is the lesser evil.
  const one = { sessionId: 'session-a', events: [settlement(1, 1000, 1, 1)] }
  const two = { sessionId: 'session-b', events: [settlement(1, 1000, 1, 1)] }
  // A log with no settlements is not covered by anything: `[]` is a subset of
  // everything, so a careless containment test would drop every empty log.
  const empty = { sessionId: 'session-empty', events: [{ type: 'session', id: 'session-empty' }] }

  const { kept, replays } = withoutReplays([one, two, empty])
  assert.deepEqual(
    kept.map((log) => log.sessionId),
    ['session-a', 'session-b', 'session-empty'],
  )
  assert.deepEqual(replays, [])
})
