/**
 * Unit tests for the pure document fold.
 *
 * The replacement semantics are the load-bearing part of this plugin: a
 * retried step must count once, not twice, and a retry that follows
 * `llm/retry-started` must count as a fresh call. These tests pin both.
 *
 * Run with: node --test test/
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  applySample,
  createDocument,
  deserializeDocument,
  hasHourBuckets,
  hoursOfDay,
  isLedgerDateKey,
  ledgerDayKeys,
  localDateKey,
  mergeBucketMap,
  mergeTotalsMap,
  pruneDocument,
  SESSION_CAP,
  summarizeBuckets,
} from '../lib/core/document.js'
import { bucketsOf, isEmptySample, retryBoundaryOf, sampleFromEvent } from '../lib/core/samples.js'
import { totalTokens } from '../lib/core/totals.js'

/** A sample at a fixed instant, so the day bucket is deterministic. */
function sample(overrides = {}) {
  const atMs = overrides.atMs ?? new Date('2026-10-18T10:00:00').getTime()
  const usage = { ...bucketsOf({ inputTokens: 100, outputTokens: 10 }), ...(overrides.usage ?? {}) }
  return {
    atMs,
    dayKey: localDateKey(atMs),
    provider: overrides.provider ?? 'opencode-go',
    model: overrides.model ?? 'deepseek-v4.1-flash',
    usage,
    turn: overrides.turn ?? 1,
    step: overrides.step ?? 1,
    sessionId: overrides.sessionId,
  }
}

test('a fresh sample creates a day bucket, a model row and a session row', () => {
  const doc = createDocument()
  const first = sample({ sessionId: 's1' })
  assert.equal(applySample(doc, first, undefined), true)

  const day = doc.days[first.dayKey]['opencode-go']['deepseek-v4.1-flash']
  assert.equal(day.inputTokens, 100)
  assert.equal(day.outputTokens, 10)
  assert.equal(day.calls, 1)
  assert.equal(totalTokens(day), 110)

  assert.equal(doc.sessions.s1.totals.calls, 1)
  assert.equal(totalTokens(doc.sessions.s1.totals), 110)
  assert.equal(doc.sessions.s1.provider, 'opencode-go')
})

test('a sample for a different step adds rather than replaces', () => {
  const doc = createDocument()
  applySample(doc, sample({ sessionId: 's1', step: 1 }), undefined)
  // The caller passes `previous` only when the coordinates match — that
  // decision belongs to the service (see test/service.test.mjs), and the fold
  // trusts it. Here the second step arrives with no previous sample.
  applySample(doc, sample({ sessionId: 's1', step: 2 }), undefined)
  assert.equal(doc.sessions.s1.totals.calls, 2)
  assert.equal(totalTokens(doc.sessions.s1.totals), 220)
})

test('a replacement for the same step swaps rather than adds', () => {
  const doc = createDocument()
  const first = sample({ sessionId: 's1' })
  applySample(doc, first, undefined)
  const second = sample({ sessionId: 's1', usage: { inputTokens: 400, outputTokens: 40 } })
  assert.equal(applySample(doc, second, doc.samples.s1), true)

  // 400 + 40, not (100 + 10) + (400 + 40).
  assert.equal(totalTokens(doc.sessions.s1.totals), 440)
  assert.equal(doc.sessions.s1.totals.calls, 1)
  assert.equal(totalTokens(doc.days[second.dayKey]['opencode-go']['deepseek-v4.1-flash']), 440)
})

test('an identical replacement is a no-op', () => {
  const doc = createDocument()
  const first = sample({ sessionId: 's1' })
  applySample(doc, first, undefined)
  const before = JSON.stringify(doc)
  assert.equal(applySample(doc, sample({ sessionId: 's1' }), doc.samples.s1), false)
  assert.equal(JSON.stringify(doc), before)
})

test('a retry boundary drops the slot so the retried attempt adds', () => {
  const doc = createDocument()
  const first = sample({ sessionId: 's1', turn: 2, step: 5 })
  applySample(doc, first, undefined)

  // What the service does on llm/retry-started for the same (turn, step).
  const boundary = retryBoundaryOf({ type: 'llm/retry-started', data: { turn: 2, step: 5 } })
  assert.deepEqual(boundary, { turn: 2, step: 5 })
  delete doc.samples.s1

  applySample(doc, sample({ sessionId: 's1', turn: 2, step: 5 }), undefined)
  assert.equal(doc.sessions.s1.totals.calls, 2)
  assert.equal(totalTokens(doc.sessions.s1.totals), 220)
})

test('a replacement that changes model subtracts from the old model row', () => {
  const doc = createDocument()
  const first = sample({ sessionId: 's1', model: 'model-a' })
  applySample(doc, first, undefined)
  const second = sample({ sessionId: 's1', model: 'model-b' })
  applySample(doc, second, doc.samples.s1)

  const day = doc.days[second.dayKey]['opencode-go']
  assert.equal(day['model-a'], undefined, 'the superseded model row is swept')
  assert.equal(totalTokens(day['model-b']), 110)
  assert.equal(doc.sessions.s1.model, 'model-b')
})

test('a replacement that crosses midnight moves the usage to the new day', () => {
  const doc = createDocument()
  const before = sample({ sessionId: 's1', atMs: new Date('2026-10-18T23:59:00').getTime() })
  applySample(doc, before, undefined)
  const after = sample({ sessionId: 's1', atMs: new Date('2026-10-19T00:01:00').getTime() })
  applySample(doc, after, doc.samples.s1)

  // The superseded day must be swept entirely, not left holding a phantom row.
  assert.deepEqual(doc.days['2026-10-18'], undefined)
  assert.equal(totalTokens(doc.days['2026-10-19']['opencode-go']['deepseek-v4.1-flash']), 110)
  assert.equal(totalTokens(doc.sessions.s1.totals), 110)
  assert.equal(doc.sessions.s1.totals.calls, 1)
})

test('a session row keeps its own per-vendor, per-model breakdown', () => {
  const doc = createDocument()
  applySample(doc, sample({ sessionId: 's1', provider: 'opencode-go', model: 'model-a', usage: { inputTokens: 900, outputTokens: 0 } }), undefined)
  applySample(doc, sample({ sessionId: 's1', turn: 2, step: 2, provider: 'deepseek', model: 'model-b', usage: { inputTokens: 100, outputTokens: 0 } }), undefined)

  // The composer panel asks the session for its breakdown, so the session row
  // must carry one rather than only a grand total.
  const row = doc.sessions.s1
  assert.equal(totalTokens(row.providers['opencode-go']['model-a']), 900)
  assert.equal(totalTokens(row.providers['deepseek']['model-b']), 100)
  assert.equal(totalTokens(row.totals), 1_000)
})

test('a session replacement moves usage between vendors without double counting', () => {
  const doc = createDocument()
  const first = sample({ sessionId: 's1', provider: 'opencode-go', model: 'model-a', usage: { inputTokens: 900, outputTokens: 0 } })
  applySample(doc, first, undefined)
  // Same (turn, step), different route: the old bucket must be subtracted from
  // the session's own breakdown too, not just from the day.
  const second = sample({ sessionId: 's1', provider: 'deepseek', model: 'model-b', usage: { inputTokens: 100, outputTokens: 0 } })
  applySample(doc, second, doc.samples.s1)

  const row = doc.sessions.s1
  assert.equal(row.providers['opencode-go'], undefined, 'the superseded vendor row is swept')
  assert.equal(totalTokens(row.providers['deepseek']['model-b']), 100)
  assert.equal(totalTokens(row.totals), 100)
})

test('a session replacement that changes model sweeps the old model row too', () => {
  const doc = createDocument()
  const first = sample({ sessionId: 's1', model: 'model-a' })
  applySample(doc, first, undefined)
  const second = sample({ sessionId: 's1', model: 'model-b' })
  applySample(doc, second, doc.samples.s1)

  // The session breakdown has to sweep model rows on the same terms the day
  // map does, or the panel would list a model this conversation no longer used.
  const row = doc.sessions.s1
  assert.equal(row.providers['opencode-go']['model-a'], undefined)
  assert.equal(totalTokens(row.providers['opencode-go']['model-b']), 110)
  assert.equal(totalTokens(row.totals), 110)
})

test('prototype-plumbing bucket keys are refused', () => {
  const doc = createDocument()
  assert.equal(applySample(doc, sample({ provider: '__proto__' }), undefined), false)
  assert.equal(applySample(doc, sample({ model: 'constructor' }), undefined), false)
  assert.deepEqual(doc.days, {})
})

test('summarizeBuckets orders providers and models by weight', () => {
  const doc = createDocument()
  applySample(doc, sample({ provider: 'a', model: 'small', usage: { inputTokens: 10 } }), undefined)
  applySample(doc, sample({ provider: 'a', model: 'big', usage: { inputTokens: 900 } }), undefined)
  applySample(doc, sample({ provider: 'b', model: 'mid', usage: { inputTokens: 500 } }), undefined)

  const summary = summarizeBuckets([doc.days[Object.keys(doc.days)[0]]])
  assert.deepEqual(summary.providers.map((row) => row.provider), ['a', 'b'])
  assert.deepEqual(summary.providers[0].models.map((row) => row.model), ['big', 'small'])
  assert.equal(totalTokens(summary.totals), 1440)
})

test('pruneDocument keeps every day and only trims the session rows', () => {
  const doc = createDocument()
  applySample(doc, sample({ atMs: new Date('2026-01-01T10:00:00').getTime(), sessionId: 'old' }), undefined)
  applySample(doc, sample({ atMs: new Date('2026-10-18T10:00:00').getTime(), sessionId: 'new' }), undefined)
  assert.deepEqual(ledgerDayKeys(doc), ['2026-01-01', '2026-10-18'])

  const pruned = pruneDocument(doc)
  // Days are deliberately unbounded: one bucket per day is about a kilobyte,
  // so a year of history is smaller than a screenshot, and a cutoff would only
  // throw away the answer to "what did I use last spring".
  assert.deepEqual(ledgerDayKeys(doc), ['2026-01-01', '2026-10-18'])
  assert.equal(pruned.sessions, 0)
  // Session rows are bounded instead, by SESSION_CAP rather than by days.
  assert.notEqual(doc.sessions.old, undefined)
  assert.notEqual(doc.sessions.new, undefined)
  assert.equal(doc.samples.new.step, 1)
})

test('pruneDocument drops the oldest session rows once the cap is reached', () => {
  const doc = createDocument()
  for (let index = 0; index < SESSION_CAP + 3; index += 1) {
    doc.sessions[`s${index}`] = {
      totals: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 },
      updatedAt: index,
      lastSeq: 0,
      providers: {},
    }
    doc.samples[`s${index}`] = { atMs: 0, dayKey: '2026-10-18', provider: 'p', model: 'm', usage: {}, turn: 1, step: 1 }
  }
  const pruned = pruneDocument(doc)
  assert.equal(pruned.sessions, 3)
  assert.equal(Object.keys(doc.sessions).length, SESSION_CAP)
  // The three oldest by `updatedAt` are the ones that go, and their samples go
  // with them so the document cannot grow through orphans.
  assert.equal(doc.sessions.s0, undefined)
  assert.equal(doc.samples.s0, undefined)
  assert.notEqual(doc.sessions[`s${SESSION_CAP + 2}`], undefined)
})

test('isLedgerDateKey rejects impossible and rolled-over dates', () => {
  assert.equal(isLedgerDateKey('2026-10-18'), true)
  assert.equal(isLedgerDateKey('2026-02-30'), false)
  assert.equal(isLedgerDateKey('9999-99-99'), false)
  assert.equal(isLedgerDateKey('2026-10-18T00:00:00Z'), false)
})

test('deserializeDocument survives garbage and never pollutes prototypes', () => {
  const doc = deserializeDocument({
    days: {
      '2026-10-18': { 'opencode-go': { 'deepseek-v4.1-flash': { inputTokens: 5, outputTokens: 1, calls: 1 } } },
      'not-a-date': { x: { y: { inputTokens: 1 } } },
    },
    sessions: { s1: { totals: { inputTokens: 5, calls: 1 }, updatedAt: 7, lastSeq: 3 } },
    samples: { s1: { atMs: 1_700_000_000_000, dayKey: '2026-10-18', provider: 'p', model: 'm', usage: { inputTokens: 5, calls: 1 }, turn: 1, step: 2 } },
  })
  assert.deepEqual(ledgerDayKeys(doc), ['2026-10-18'])
  assert.equal(doc.sessions.s1.lastSeq, 3)
  assert.equal(doc.samples.s1.step, 2)
  assert.equal({}.inputTokens, undefined)

  // A slot with no readable instant is dropped rather than kept at 0: the next
  // replacement would subtract it from the epoch-0 hour while the day bucket kept
  // it, and the day would stop being the sum of its hours with no way back.
  const noInstant = deserializeDocument({
    samples: { s1: { dayKey: '2026-10-18', provider: 'p', model: 'm', usage: { inputTokens: 5, calls: 1 }, turn: 1, step: 2 } },
  })
  assert.deepEqual(noInstant.samples, {})

  // Numbers that are not numbers become 0 rather than NaN.
  const messy = deserializeDocument({ days: { '2026-10-18': { p: { m: { inputTokens: 'lots', calls: null } } } } })
  assert.equal(messy.days['2026-10-18'].p.m.inputTokens, 0)

  assert.deepEqual(deserializeDocument(null).days, {})
  assert.deepEqual(deserializeDocument('nope').days, {})
})

test('sampleFromEvent prefers the per-call message source over the session route', () => {
  const event = {
    type: 'assistant/message',
    seq: 12,
    time: new Date('2026-10-18T10:00:00').getTime(),
    data: {
      turn: 3,
      step: 4,
      usage: { inputTokens: 7, outputTokens: 2, cacheReadTokens: 100, cacheWriteTokens: 0 },
      message: { source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' } },
    },
  }
  const built = sampleFromEvent(event, { provider: 'ignored', model: 'ignored' }, 0)
  assert.equal(built.provider, 'deepseek-account')
  assert.equal(built.model, 'deepseek-flash')
  assert.equal(built.usage.cacheReadTokens, 100)
  assert.equal(built.usage.calls, 1)
  assert.deepEqual([built.turn, built.step], [3, 4])

  // No source on the event: the session's remembered route is the fallback.
  const fallback = sampleFromEvent({ type: 'assistant/message', data: { usage: { inputTokens: 1, outputTokens: 1 } } }, { provider: 'p', model: 'm' }, 1234)
  assert.equal(fallback.provider, 'p')
  assert.equal(fallback.model, 'm')
  assert.equal(fallback.atMs, 1234)

  // No route at all: nothing to attribute the call to.
  assert.equal(sampleFromEvent({ type: 'assistant/message', data: { usage: { inputTokens: 1, outputTokens: 1 } } }, undefined, 0), undefined)
  // Not a settlement event.
  assert.equal(sampleFromEvent({ type: 'turn/start', data: {} }, { provider: 'p', model: 'm' }, 0), undefined)
})

test('a usage chunk inside a retained stream is read for assistant/attempt', () => {
  const event = {
    type: 'assistant/attempt',
    data: {
      turn: 1,
      step: 1,
      stream: [
        { type: 'chunk', chunk: { type: 'text', text: 'hi' } },
        { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 4 } } },
      ],
    },
  }
  const built = sampleFromEvent(event, { provider: 'p', model: 'm' }, 0)
  assert.equal(built.usage.inputTokens, 3)
  assert.equal(built.usage.outputTokens, 4)
})

test('isEmptySample flags a zero-token settlement', () => {
  assert.equal(isEmptySample({ usage: bucketsOf({ inputTokens: 0, outputTokens: 0 }) }), true)
  assert.equal(isEmptySample({ usage: bucketsOf({ inputTokens: 0, outputTokens: 1 }) }), false)
})

test('the day bucket always equals the sum of that day\u2019s hour buckets', () => {
  // The invariant the two maps are held to. They are written by one
  // `applySample`, so the only way to break it is a replacement that moves a
  // sample between hours.
  const doc = createDocument()
  const morning = sample({ atMs: new Date('2026-10-18T09:15:00').getTime(), sessionId: 's1' })
  const evening = sample({ atMs: new Date('2026-10-18T21:45:00').getTime(), sessionId: 's1', step: 2 })
  applySample(doc, morning, undefined)
  applySample(doc, evening, undefined)
  // A retry of the evening call, settling in the next hour with other numbers.
  const retried = sample({
    atMs: new Date('2026-10-18T22:05:00').getTime(),
    sessionId: 's1',
    step: 2,
    usage: { inputTokens: 40, outputTokens: 4 },
  })
  applySample(doc, retried, evening)

  const day = doc.days['2026-10-18']['opencode-go']['deepseek-v4.1-flash']
  const hours = hoursOfDay(doc, '2026-10-18')
  const summed = hours.reduce((acc, row) => acc + row.buckets['opencode-go']['deepseek-v4.1-flash'].inputTokens, 0)
  assert.equal(day.inputTokens, summed)
  assert.equal(day.calls, hours.reduce((acc, row) => acc + row.buckets['opencode-go']['deepseek-v4.1-flash'].calls, 0))
  // The retry moved the call rather than copying it: the hour it left is gone.
  assert.deepEqual(hours.map((row) => row.hour), [9, 22])
})

test('hoursOfDay lists only the hours that recorded something', () => {
  const doc = createDocument()
  assert.equal(hasHourBuckets(doc), false)
  applySample(doc, sample({ atMs: new Date('2026-10-18T07:00:00').getTime(), sessionId: 's1' }), undefined)
  applySample(doc, sample({ atMs: new Date('2026-10-19T07:00:00').getTime(), sessionId: 's1', step: 2 }), undefined)

  assert.equal(hasHourBuckets(doc), true)
  assert.deepEqual(hoursOfDay(doc, '2026-10-18').map((row) => row.hour), [7])
  // A day that recorded nothing is an empty list, never a day of zeroes: the
  // chart has to be able to tell "no record" from "nothing spent".
  assert.deepEqual(hoursOfDay(doc, '2026-10-17'), [])
})

test('mergeBucketMap adds rows without inventing an hour bucket', () => {
  const source = createDocument()
  applySample(source, sample({ atMs: new Date('2026-10-18T10:00:00').getTime(), sessionId: 's1' }), undefined)

  const loaded = createDocument()
  mergeBucketMap(loaded.days, source.days)
  mergeBucketMap(loaded.hours, source.hours)
  assert.equal(loaded.days['2026-10-18']['opencode-go']['deepseek-v4.1-flash'].inputTokens, 100)
  assert.deepEqual(hoursOfDay(loaded, '2026-10-18').map((row) => row.hour), [10])

  // Merging the day map alone leaves the hour map alone. That is the whole
  // reason the load path merges them separately instead of replaying the file
  // through the fold, which would key an hour bucket off a made-up timestamp.
  const dayOnly = createDocument()
  mergeBucketMap(dayOnly.days, source.days)
  assert.equal(hasHourBuckets(dayOnly), false)

  // It adds rather than replaces, which is why the target has to be the live
  // (empty at load) document rather than a second read of the same file.
  mergeBucketMap(loaded.days, source.days)
  assert.equal(loaded.days['2026-10-18']['opencode-go']['deepseek-v4.1-flash'].inputTokens, 200)
})

test('applySample can fold into the hour map alone, for the one-time rebuild', () => {
  const doc = createDocument()
  const first = sample({ atMs: new Date('2026-10-18T10:00:00').getTime(), sessionId: 's1' })
  assert.equal(applySample(doc, first, undefined, { days: false, hours: true, sessions: false }), true)

  assert.deepEqual(hoursOfDay(doc, '2026-10-18').map((row) => row.hour), [10])
  // Everything it was told to leave alone is still untouched.
  assert.deepEqual(doc.days, {})
  assert.deepEqual(doc.sessions, {})
  assert.deepEqual(doc.samples, {})
})

test('mergeTotalsMap adds one day\'s rows into another without touching a prototype', () => {
  // What a multi-day window needs before it can be converted to money: the
  // `provider -> model -> totals` maps of several days summed into one.
  const target = { 'opencode-go': { 'deepseek-flash': bucketsOf({ inputTokens: 100, outputTokens: 10 }) } }
  mergeTotalsMap(target, {
    'opencode-go': { 'deepseek-flash': bucketsOf({ inputTokens: 1, outputTokens: 2 }), 'gpt-5.6-luna': bucketsOf({ inputTokens: 5 }) },
    'deepseek': { 'deepseek-flash': bucketsOf({ inputTokens: 7 }) },
  })

  assert.equal(target['opencode-go']['deepseek-flash'].inputTokens, 101)
  assert.equal(target['opencode-go']['deepseek-flash'].outputTokens, 12)
  assert.equal(target['opencode-go']['gpt-5.6-luna'].inputTokens, 5)
  assert.equal(target['deepseek']['deepseek-flash'].inputTokens, 7)
  // The guard matters here: without it this row would replace the map's
  // prototype instead of adding a provider.
  mergeTotalsMap(target, JSON.parse('{"__proto__": {"polluted": {"inputTokens": 1}}}'))
  assert.equal(Object.getPrototypeOf(target), Object.prototype)
  assert.equal(target.polluted, undefined)
  // Nothing to merge is not an error.
  mergeTotalsMap(target, undefined)
  assert.equal(target['opencode-go']['deepseek-flash'].inputTokens, 101)
})