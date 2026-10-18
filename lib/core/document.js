/**
 * The persisted usage document and every pure operation over it.
 *
 * The document is the only host-side state that survives a restart:
 *
 * ```json
 * {
 *   "version": 1,
 *   "days":     { "2026-10-18": { "opencode-go": { "deepseek-v4.1-flash": { ...totals } } } },
 *   "sessions": { "<sessionId>": { "totals": {...}, "updatedAt": 1, "lastSeq": 42, "provider": "...", "model": "..." } },
 *   "samples":  { "<sessionId>": { "turn": 3, "step": 7, "dayKey": "...", "provider": "...", "model": "...", "usage": {...} } }
 * }
 * ```
 *
 * `days` answers "what did I spend, per provider and model, on a given day";
 * `sessions` answers "how many tokens has this conversation burned". Both are
 * folded from the same event stream by {@link applySample}, so the two views
 * can never disagree about one call.
 *
 * ## Why folding is a *replacement*, not a sum
 *
 * A model attempt can settle more than once for the same `(turn, step)`: a
 * stream error followed by a retry produces a second sample for the step the
 * first one already reported, and the retry may report *different* token
 * counts. Summing every `assistant/message` therefore double counts retried
 * steps — the DSH session projection `tokenUsage` solves this by remembering
 * the last sample per session and subtracting it when the same step reports
 * again, and clearing that memory when `llm/retry-started` closes the slot so
 * the retried attempt counts as a fresh call. This module implements the same
 * fold, but instead of one flat total it maintains per-day, per-provider and
 * per-model buckets, which means the *previous* sample has to be subtracted
 * from exactly the bucket it was added to. That is why the sample record
 * carries its own `dayKey`, `provider` and `model`: a retry that crosses
 * midnight, or switches model, must not corrupt either bucket.
 *
 * Everything here is pure and synchronous: the service owns the file, this
 * module owns the shape.
 *
 * @module dsh-usage-stat/core/document
 */

import { addTotals, emptyTotals, hasUsage, totalTokens } from './totals.js'

/** Current on-disk format version. Bump only alongside a reader migration. */
export const DOCUMENT_VERSION = 1

/** How many model rows one summarized provider keeps (the rest still count in its totals). */
export const SUMMARY_MODEL_CAP = 12

/**
 * How many session rows the document retains. Sessions are keyed by id and
 * never expire on their own, so this cap is the only thing keeping the file
 * from growing one row per conversation forever; the least recently updated
 * rows fall off first.
 *
 * It is deliberately far above any realistic count — a row is a few hundred
 * bytes, so the cap only ever fires on a document that has been running for
 * years, and never on a normal install.
 */
export const SESSION_CAP = 5000

/**
 * Local-date key (`YYYY-MM-DD`) for an epoch-ms timestamp. Local, not UTC:
 * the user's "today" is the calendar day they are living in.
 * @param {number} ms - epoch milliseconds.
 * @returns {string} the local-date key.
 */
export function localDateKey(ms) {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Whether `key` is a real local-date key. The shape check is round-tripped:
 * `9999-99-99` parses to NaN and `2026-02-30` rolls over into March, so a
 * shape-only test would admit buckets that can never be pruned or picked.
 * @param {string} key - the candidate key.
 * @returns {boolean} true when the key is a real `YYYY-MM-DD` local date.
 */
export function isLedgerDateKey(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return false
  const atMs = new Date(`${key}T12:00:00`).getTime()
  return Number.isFinite(atMs) && localDateKey(atMs) === key
}

/**
 * Bucket keys arrive from untrusted directions (the persisted file, provider
 * and model ids out of session events). A key that collides with
 * `Object.prototype` plumbing would pollute every object in the host process,
 * so such keys are dropped at the fold and at the parse.
 * @param {string} key - the candidate bucket key.
 * @returns {boolean} true when the key is safe to use as a plain-object key.
 */
function isSafeBucketKey(key) {
  return key !== '__proto__' && key !== 'constructor' && key !== 'prototype'
}

/** A fresh, empty document. */
export function createDocument() {
  return { version: DOCUMENT_VERSION, days: {}, sessions: {}, samples: {} }
}

/**
 * The bookmark that says the session logs have been replayed into this ledger.
 *
 * It is not usage, but it has to live in the document: replaying the logs is a
 * one-time job, and without a record of it every Host start would re-read every
 * log on disk. A missing or malformed bookmark simply means "not yet", which is
 * the safe direction — the replay itself is idempotent.
 * @param {unknown} value - the untrusted bookmark.
 * @returns {{ atMs: number, files: number, events: number }|undefined} - the bookmark, or `undefined`.
 */
function reviveHistory(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const record = /** @type {Record<string, unknown>} */ (value)
  const atMs = num(record.atMs)
  if (atMs === undefined) return undefined
  return { atMs, files: num(record.files) ?? 0, events: num(record.events) ?? 0 }
}

/** Whether two totals carry identical buckets. */
function totalsEqual(left, right) {
  return left.inputTokens === right.inputTokens
    && left.outputTokens === right.outputTokens
    && left.cacheReadTokens === right.cacheReadTokens
    && left.cacheWriteTokens === right.cacheWriteTokens
    && left.reasoningTokens === right.reasoningTokens
    && left.calls === right.calls
}

/**
 * Add (`sign` 1) or subtract (`sign` -1) one sample from the day buckets.
 * Empty rows are left in place; {@link sweepEmpty} removes them once the whole
 * replacement pair has been applied, so a replacement that momentarily zeroes
 * a row does not churn the document.
 * @param {object} doc - the document to mutate.
 * @param {string} dayKey - the sample's local-date key.
 * @param {string} provider - the provider route key.
 * @param {string} model - the model id.
 * @param {Readonly<import('./types.js').TokenTotals>} usage - the buckets.
 * @param {number} sign - 1 to add, -1 to subtract.
 */
function adjustDay(doc, dayKey, provider, model, usage, sign) {
  const day = doc.days[dayKey] ?? {}
  adjustBuckets(day, provider, model, usage, sign)
  doc.days[dayKey] = day
}

/**
 * Add or subtract one sample from a `provider -> model -> totals` map. Shared
 * by the day buckets and a session's own buckets so both are folded by exactly
 * the same arithmetic — a session breakdown that disagreed with the day
 * breakdown would be a bug nobody could explain.
 * @param {Record<string, Record<string, import('./types.js').TokenTotals>>} buckets - the map to mutate.
 * @param {string} provider - the provider route key.
 * @param {string} model - the model id.
 * @param {Readonly<import('./types.js').TokenTotals>} usage - the buckets.
 * @param {number} sign - 1 to add, -1 to subtract.
 */
function adjustBuckets(buckets, provider, model, usage, sign) {
  const models = buckets[provider] ?? {}
  const totals = models[model] ?? emptyTotals()
  addTotals(totals, scale(usage, sign))
  models[model] = totals
  buckets[provider] = models
}

/**
 * Add or subtract one sample from a session row, creating the row on the way
 * in. The row's `provider`/`model` always describe the newest sample, while
 * `providers` keeps the whole `provider -> model -> totals` breakdown so the
 * composer badge can open a per-vendor, per-model panel for the conversation
 * itself.
 * @param {object} doc - the document to mutate.
 * @param {string} sessionId - the session id.
 * @param {Readonly<import('./types.js').TokenTotals>} usage - the buckets.
 * @param {number} sign - 1 to add, -1 to subtract.
 * @param {{ atMs: number, provider: string, model: string }} sample - the sample's attribution.
 */
function adjustSession(doc, sessionId, usage, sign, sample) {
  const row = doc.sessions[sessionId] ?? { totals: emptyTotals(), updatedAt: sample.atMs, providers: {} }
  addTotals(row.totals, scale(usage, sign))
  const providers = row.providers ?? {}
  adjustBuckets(providers, sample.provider, sample.model, usage, sign)
  row.providers = providers
  if (sign > 0) {
    row.updatedAt = sample.atMs
    row.provider = sample.provider
    row.model = sample.model
  }
  doc.sessions[sessionId] = row
}

/** A copy of `usage` multiplied by `sign`; `calls` is a count, so it scales too. */
function scale(usage, sign) {
  return {
    inputTokens: usage.inputTokens * sign,
    outputTokens: usage.outputTokens * sign,
    cacheReadTokens: usage.cacheReadTokens * sign,
    cacheWriteTokens: usage.cacheWriteTokens * sign,
    reasoningTokens: usage.reasoningTokens * sign,
    calls: usage.calls * sign,
  }
}

/**
 * Drop every row that nets out to nothing: model rows with no tokens and no
 * calls, providers whose model rows all went, days whose providers all went,
 * and session rows with no usage. A zero row is not harmless — it would make
 * an empty day look "recorded" in the day picker and print a 0-token session.
 * @param {object} doc - the document to sweep.
 */
function sweepEmpty(doc) {
  for (const [dayKey, day] of Object.entries(doc.days)) {
    for (const [provider, models] of Object.entries(day)) {
      for (const [model, totals] of Object.entries(models)) {
        if (!hasUsage(totals)) delete models[model]
      }
      if (Object.keys(models).length === 0) delete day[provider]
    }
    if (Object.keys(day).length === 0) delete doc.days[dayKey]
  }
  for (const [sessionId, row] of Object.entries(doc.sessions)) {
    for (const [provider, models] of Object.entries(row.providers ?? {})) {
      for (const [model, totals] of Object.entries(models)) {
        if (!hasUsage(totals)) delete models[model]
      }
      if (Object.keys(models).length === 0) delete row.providers[provider]
    }
    if (!hasUsage(row.totals)) {
      delete doc.sessions[sessionId]
      delete doc.samples[sessionId]
    }
  }
}

/**
 * Fold one model-call sample into the document in place, replacing the
 * previous sample of the same session when there was one.
 *
 * The caller decides *when* a sample is a replacement: `previous` must be the
 * sample this one supersedes, i.e. the stored sample for the same `(turn, step)`
 * of the same session. A settlement for a new step must be folded with no
 * `previous` at all, or its tokens would be subtracted from an unrelated call.
 * `UsageService#onSessionEvent` owns that decision.
 *
 * @param {object} doc - the document to mutate.
 * @param {import('./samples.js').Sample} sample - the sample to fold in.
 * @param {import('./samples.js').Sample} [previous] - the sample this one replaces, if any.
 * @returns {boolean} true when the document changed.
 */
export function applySample(doc, sample, previous) {
  const { atMs, provider, model, usage, sessionId } = sample
  if (!isSafeBucketKey(provider) || !isSafeBucketKey(model)) return false
  if (!hasUsage(usage)) return false
  // A sample identical to the one it replaces changes nothing; skipping the
  // subtract/add pair also keeps `updatedAt` from churning on every replay.
  if (previous !== undefined
    && previous.dayKey === sample.dayKey
    && previous.provider === provider
    && previous.model === model
    && totalsEqual(previous.usage, usage)) {
    return false
  }

  if (previous !== undefined) {
    adjustDay(doc, previous.dayKey, previous.provider, previous.model, previous.usage, -1)
    if (typeof sessionId === 'string' && sessionId !== '') adjustSession(doc, sessionId, previous.usage, -1, previous)
  }
  adjustDay(doc, sample.dayKey, provider, model, usage, 1)
  if (typeof sessionId === 'string' && sessionId !== '') {
    adjustSession(doc, sessionId, usage, 1, sample)
    doc.samples[sessionId] = sample
  }
  sweepEmpty(doc)
  return true
}

/**
 * Aggregate whole per-day maps (each `provider -> model -> totals`) into the
 * per-provider, per-model summary one day or one range renders: disjoint
 * bucket sums per provider, model rows heaviest first, and the grand total.
 * Pure — reads its inputs and allocates fresh buckets.
 *
 * @param {Array<Record<string, Record<string, import('./types.js').TokenTotals>>>} days - the day maps to merge.
 * @returns {{ totals: import('./types.js').TokenTotals, providers: import('./types.js').ProviderSummary[] }} the summary.
 */
export function summarizeDays(days) {
  /** @type {Map<string, Map<string, import('./types.js').TokenTotals>>} */
  const merged = new Map()
  for (const day of days) {
    if (typeof day !== 'object' || day === null) continue
    for (const [provider, models] of Object.entries(day)) {
      if (!isSafeBucketKey(provider) || typeof models !== 'object' || models === null) continue
      let modelMap = merged.get(provider)
      if (modelMap === undefined) {
        modelMap = new Map()
        merged.set(provider, modelMap)
      }
      for (const [model, totals] of Object.entries(models)) {
        if (!isSafeBucketKey(model) || typeof totals !== 'object' || totals === null) continue
        const bucket = modelMap.get(model) ?? emptyTotals()
        addTotals(bucket, totals)
        modelMap.set(model, bucket)
      }
    }
  }
  /** @type {import('./types.js').ProviderSummary[]} */
  const providers = []
  const totals = emptyTotals()
  for (const [provider, modelMap] of merged) {
    const providerTotals = emptyTotals()
    const modelRows = [...modelMap].map(([model, modelTotals]) => ({ model, totals: modelTotals }))
    for (const row of modelRows) addTotals(providerTotals, row.totals)
    modelRows.sort((a, b) => totalTokens(b.totals) - totalTokens(a.totals))
    providers.push({ provider, displayName: provider, totals: providerTotals, models: modelRows.slice(0, SUMMARY_MODEL_CAP) })
  }
  providers.sort((a, b) => totalTokens(b.totals) - totalTokens(a.totals))
  for (const row of providers) addTotals(totals, row.totals)
  return { totals, providers }
}

/**
 * Every local-date key in the document that recorded usage, ascending.
 * @param {object} doc - the document.
 * @returns {string[]} the sorted date keys.
 */
export function ledgerDayKeys(doc) {
  return Object.keys(doc.days).filter(isLedgerDateKey).sort()
}

/**
 * Trim the session map to its cap, in place.
 *
 * There is deliberately no time and no size limit on the daily ledger. A day
 * bucket is a handful of numbers per provider and per model — measured at about
 * a kilobyte per day on a busy install — so "keep everything" costs a few
 * hundred kilobytes a year and buys the one thing a usage history is for:
 * being able to look back. Bounding it was a knob that only ever lost data.
 *
 * The session map is different: it grows with the number of conversations
 * rather than with time, so it keeps a cap. {@link SESSION_CAP} is high enough
 * that a normal install never reaches it.
 *
 * @param {object} doc - the document to prune.
 * @returns {{ sessions: number }} how many session rows were dropped.
 */
export function pruneDocument(doc) {
  const rows = Object.entries(doc.sessions)
  let sessions = 0
  if (rows.length > SESSION_CAP) {
    rows.sort((a, b) => (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0))
    for (const [id] of rows.slice(SESSION_CAP)) {
      delete doc.sessions[id]
      delete doc.samples[id]
      sessions += 1
    }
  }
  return { sessions }
}

/** Coerce an untrusted value into a finite number, or 0. */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/**
 * Revive one untrusted `provider -> model -> totals` map. Malformed rows are
 * skipped rather than fatal, exactly like the day buckets.
 * @param {unknown} value - the untrusted map.
 * @returns {Record<string, Record<string, import('./types.js').TokenTotals>>} the revived map (possibly empty).
 */
function reviveBuckets(value) {
  /** @type {Record<string, Record<string, import('./types.js').TokenTotals>>} */
  const buckets = {}
  if (typeof value !== 'object' || value === null) return buckets
  for (const [provider, models] of Object.entries(value)) {
    if (!isSafeBucketKey(provider) || typeof models !== 'object' || models === null) continue
    for (const [model, totals] of Object.entries(models)) {
      if (!isSafeBucketKey(model)) continue
      const revived = reviveTotals(totals)
      if (revived === undefined) continue
      const modelMap = buckets[provider] ?? {}
      modelMap[model] = revived
      buckets[provider] = modelMap
    }
  }
  return buckets
}

/**
 * Revive one untrusted totals object. Unknown fields are dropped and
 * non-finite numbers become 0, so a hand-edited file can never inject NaN
 * into every subsequent sum.
 * @param {unknown} value - the untrusted bucket.
 * @returns {import('./types.js').TokenTotals|undefined} the revived bucket, or undefined when `value` is not an object.
 */
export function reviveTotals(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const source = /** @type {Record<string, unknown>} */ (value)
  return {
    inputTokens: num(source.inputTokens),
    outputTokens: num(source.outputTokens),
    cacheReadTokens: num(source.cacheReadTokens),
    cacheWriteTokens: num(source.cacheWriteTokens),
    reasoningTokens: num(source.reasoningTokens),
    calls: num(source.calls),
  }
}

/**
 * Parse a document from untrusted JSON. Never throws: an unrecognized shape
 * yields an empty document and individual malformed rows are skipped, so a
 * corrupt file costs the user their history but never their harness.
 * @param {unknown} value - the parsed JSON.
 * @returns {object} a fresh document.
 */
export function deserializeDocument(value) {
  const doc = createDocument()
  if (typeof value !== 'object' || value === null) return doc
  const source = /** @type {Record<string, unknown>} */ (value)

  const days = source.days
  if (typeof days === 'object' && days !== null) {
    for (const [dateKey, providers] of Object.entries(days)) {
      if (!isLedgerDateKey(dateKey) || typeof providers !== 'object' || providers === null) continue
      for (const [provider, models] of Object.entries(providers)) {
        if (!isSafeBucketKey(provider) || typeof models !== 'object' || models === null) continue
        for (const [model, totals] of Object.entries(models)) {
          const revived = reviveTotals(totals)
          if (revived === undefined) continue
          const day = doc.days[dateKey] ?? {}
          const modelMap = day[provider] ?? {}
          modelMap[model] = revived
          day[provider] = modelMap
          doc.days[dateKey] = day
        }
      }
    }
  }

  const sessions = source.sessions
  if (typeof sessions === 'object' && sessions !== null) {
    for (const [sessionId, row] of Object.entries(sessions)) {
      if (!isSafeBucketKey(sessionId) || typeof row !== 'object' || row === null) continue
      const record = /** @type {Record<string, unknown>} */ (row)
      const totals = reviveTotals(record.totals)
      if (totals === undefined) continue
      doc.sessions[sessionId] = {
        totals,
        updatedAt: num(record.updatedAt),
        providers: reviveBuckets(record.providers),
        ...(typeof record.lastSeq === 'number' && Number.isFinite(record.lastSeq) ? { lastSeq: record.lastSeq } : {}),
        ...(typeof record.provider === 'string' && isSafeBucketKey(record.provider) ? { provider: record.provider } : {}),
        ...(typeof record.model === 'string' && isSafeBucketKey(record.model) ? { model: record.model } : {}),
      }
    }
  }

  const samples = source.samples
  if (typeof samples === 'object' && samples !== null) {
    for (const [sessionId, row] of Object.entries(samples)) {
      if (!isSafeBucketKey(sessionId) || typeof row !== 'object' || row === null) continue
      const record = /** @type {Record<string, unknown>} */ (row)
      const usage = reviveTotals(record.usage)
      if (usage === undefined) continue
      if (typeof record.dayKey !== 'string' || !isLedgerDateKey(record.dayKey)) continue
      if (typeof record.provider !== 'string' || !isSafeBucketKey(record.provider)) continue
      if (typeof record.model !== 'string' || !isSafeBucketKey(record.model)) continue
      doc.samples[sessionId] = {
        atMs: num(record.atMs),
        dayKey: record.dayKey,
        provider: record.provider,
        model: record.model,
        usage,
        turn: num(record.turn),
        step: num(record.step),
      }
    }
  }

  const history = reviveHistory(source.history)
  if (history !== undefined) doc.history = history

  return doc
}
