/**
 * The persisted usage document and every pure operation over it.
 *
 * The document is the only host-side state that survives a restart:
 *
 * ```json
 * {
 *   "version": 1,
 *   "days":     { "2026-10-18": { "opencode-go": { "deepseek-v4.1-flash": { ...totals } } } },
 *   "hours":    { "2026-10-18T14": { "opencode-go": { "deepseek-v4.1-flash": { ...totals } } } },
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
 * `hours` is that same fold one level finer, so a single day can be charted
 * across the clock instead of drawn as one bar. It is written by the *same*
 * `applySample` call as `days`, never by a second pass over the events: two
 * passes over one stream is how a ledger starts disagreeing with itself. The
 * price is that a day and its hours have to stay in step, so
 * `test/document.test.mjs` asserts the invariant directly — a day's totals are
 * the sum of its hours. A file written before hours existed has no `hours` key,
 * which reads as "not recorded at that resolution" rather than as zero usage;
 * `UsageService` rebuilds it once from the session logs and records that it did
 * in `hoursBuiltAt`.
 *
 * `replayGuardAt` records the one time the ledger was rebuilt because a session
 * log turned out to repeat another session's calls — see `withoutReplays` in
 * `lib/host/history.js`. The rebuild exists to clear copies that were folded
 * before that check existed; without the bookmark every later scan would rebuild
 * again.
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
 * Local-hour key (`YYYY-MM-DDTHH`) for an epoch-ms timestamp, in the same local
 * zone as {@link localDateKey} so an hour key always starts with the day key it
 * belongs to.
 * @param {number} ms - epoch milliseconds.
 * @returns {string} the local-hour key.
 */
export function localHourKey(ms) {
  const hour = String(new Date(ms).getHours()).padStart(2, '0')
  return `${localDateKey(ms)}T${hour}`
}

/**
 * Whether `key` is a real local-hour key. Round-tripped for the same reason as
 * {@link isLedgerDateKey}: `2026-10-18T25` has the right shape and is not an
 * hour, and a bucket that can never be picked is worse than no bucket.
 * @param {string} key - the candidate key.
 * @returns {boolean} true when the key is a real `YYYY-MM-DDTHH` local hour.
 */
export function isLedgerHourKey(key) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(key)) return false
  const atMs = new Date(`${key}:00:00`).getTime()
  return Number.isFinite(atMs) && localHourKey(atMs) === key
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
  return { version: DOCUMENT_VERSION, days: {}, hours: {}, sessions: {}, samples: {} }
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
 * Add or subtract one sample from the hour buckets — the same arithmetic as
 * {@link adjustDay}, one level finer.
 *
 * The hour is derived from the sample's own timestamp rather than stored on it,
 * because `dayKey` is derived from that same timestamp: a sample record can
 * therefore never name a day and an hour that disagree. A retry that crosses an
 * hour boundary is subtracted from the hour it was actually added to, which is
 * the whole reason the timestamp travels with the sample.
 * @param {object} doc - the document to mutate.
 * @param {number} atMs - the sample's epoch-ms timestamp.
 * @param {string} provider - the provider route key.
 * @param {string} model - the model id.
 * @param {Readonly<import('./types.js').TokenTotals>} usage - the buckets.
 * @param {number} sign - 1 to add, -1 to subtract.
 */
function adjustHour(doc, atMs, provider, model, usage, sign) {
  const hourKey = localHourKey(atMs)
  const hour = doc.hours[hourKey] ?? {}
  adjustBuckets(hour, provider, model, usage, sign)
  doc.hours[hourKey] = hour
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
 * Add every row of one `bucketKey -> provider -> model` map into another, in
 * place. This is how the persisted ledger is merged back in on load.
 *
 * The load path deliberately does *not* replay the file through
 * {@link applySample}: that fold also writes the hour buckets, and a day bucket
 * carries no time of day, so replaying it would invent an hour bucket at
 * whatever synthetic timestamp the merge made up. Days and hours are merged
 * into their own maps from their own rows instead — which is also why the file
 * has to be written with both.
 * @param {Record<string, Record<string, Record<string, import('./types.js').TokenTotals>>>} target - the map to add into.
 * @param {Record<string, Record<string, Record<string, import('./types.js').TokenTotals>>>} source - the map to add.
 */
export function mergeBucketMap(target, source) {
  for (const [key, buckets] of Object.entries(source)) {
    const into = target[key] ?? {}
    for (const [provider, models] of Object.entries(buckets)) {
      for (const [model, usage] of Object.entries(models)) {
        adjustBuckets(into, provider, model, usage, 1)
      }
    }
    target[key] = into
  }
}

/**
 * Add one `provider -> model -> totals` map into another, in place.
 *
 * The sibling of {@link mergeBucketMap} one level down: that one merges a whole
 * `day -> provider -> model` ledger, this one merges the rows of one day, which
 * is what a window spanning several days needs before it can be converted to
 * money. Keys are guarded the way {@link summarizeBuckets} guards them, so a
 * provider id cannot land on an object's prototype.
 * @param {Record<string, Record<string, import('./types.js').TokenTotals>>} target - the map to add into.
 * @param {Record<string, Record<string, import('./types.js').TokenTotals>>} source - the map to add.
 */
export function mergeTotalsMap(target, source) {
  if (typeof source !== 'object' || source === null) return
  for (const [provider, models] of Object.entries(source)) {
    if (!isSafeBucketKey(provider) || typeof models !== 'object' || models === null) continue
    for (const [model, usage] of Object.entries(models)) {
      if (!isSafeBucketKey(model) || typeof usage !== 'object' || usage === null) continue
      adjustBuckets(target, provider, model, usage, 1)
    }
  }
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
 * Drop every empty model and provider row from one `bucketKey -> provider ->
 * model -> totals` map, then every bucket that lost all of its providers. Used
 * for the day buckets and the hour buckets so both are swept identically.
 * @param {Record<string, Record<string, Record<string, import('./types.js').TokenTotals>>>} map - the bucket map to sweep.
 */
function sweepBucketMap(map) {
  for (const [key, buckets] of Object.entries(map)) {
    for (const [provider, models] of Object.entries(buckets)) {
      for (const [model, totals] of Object.entries(models)) {
        if (!hasUsage(totals)) delete models[model]
      }
      if (Object.keys(models).length === 0) delete buckets[provider]
    }
    if (Object.keys(buckets).length === 0) delete map[key]
  }
}

/**
 * Drop every row that nets out to nothing: model rows with no tokens and no
 * calls, providers whose model rows all went, day and hour buckets whose
 * providers all went, and session rows with no usage. A zero row is not
 * harmless — it would make an empty day look "recorded" in the day picker and
 * print a 0-token session.
 * @param {object} doc - the document to sweep.
 */
function sweepEmpty(doc) {
  sweepBucketMap(doc.days)
  sweepBucketMap(doc.hours)
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
 * @param {{ days?: boolean, hours?: boolean, sessions?: boolean }} [maps] - which maps to write; all of them by default.
 * @returns {boolean} true when the document changed.
 */
export function applySample(doc, sample, previous, maps) {
  const { atMs, provider, model, usage, sessionId } = sample
  if (!isSafeBucketKey(provider) || !isSafeBucketKey(model)) return false
  if (!hasUsage(usage)) return false
  // A sample identical to the one it replaces changes nothing; skipping the
  // subtract/add pair also keeps `updatedAt` from churning on every replay.
  // The hour is part of "identical" because the hour map is keyed by it: a retry
  // that crosses an hour boundary has to move its bucket even when the token
  // counts came back the same. It is derived from `atMs`, which is the stored
  // truth the fold itself uses, rather than carried as a second field that could
  // disagree with it.
  if (previous !== undefined
    && previous.dayKey === sample.dayKey
    && localHourKey(previous.atMs) === localHourKey(sample.atMs)
    && previous.provider === provider
    && previous.model === model
    && totalsEqual(previous.usage, usage)) {
    return false
  }

  // The one-time hour rebuild replays the session logs into a cleared hour map
  // with the day and session maps switched off: the ledger it is filling
  // already holds those, and folding them again would double every call it was
  // built from. See `UsageService#scanLogs`.
  const days = maps?.days !== false
  const hours = maps?.hours !== false
  const sessions = maps?.sessions !== false

  if (previous !== undefined) {
    if (days) adjustDay(doc, previous.dayKey, previous.provider, previous.model, previous.usage, -1)
    if (hours) adjustHour(doc, previous.atMs, previous.provider, previous.model, previous.usage, -1)
    if (sessions && typeof sessionId === 'string' && sessionId !== '') {
      adjustSession(doc, sessionId, previous.usage, -1, previous)
    }
  }
  if (days) adjustDay(doc, sample.dayKey, provider, model, usage, 1)
  if (hours) adjustHour(doc, atMs, provider, model, usage, 1)
  if (sessions && typeof sessionId === 'string' && sessionId !== '') {
    adjustSession(doc, sessionId, usage, 1, sample)
    doc.samples[sessionId] = sample
  }
  if (days || sessions) sweepEmpty(doc)
  else sweepBucketMap(doc.hours)
  return true
}

/**
 * Aggregate whole bucket maps (each `provider -> model -> totals`) into the
 * per-provider, per-model summary one day, one hour or one range renders:
 * disjoint bucket sums per provider, model rows heaviest first, and the grand
 * total. Pure — reads its inputs and allocates fresh buckets.
 *
 * Named for the shape rather than for days because the hour chart merges the
 * same way; "summarize one or more of these maps" is the whole contract.
 *
 * @param {Array<Record<string, Record<string, import('./types.js').TokenTotals>>>} buckets - the bucket maps to merge.
 * @returns {{ totals: import('./types.js').TokenTotals, providers: import('./types.js').ProviderSummary[] }} the summary.
 */
export function summarizeBuckets(buckets) {
  /** @type {Map<string, Map<string, import('./types.js').TokenTotals>>} */
  const merged = new Map()
  for (const bucketMap of buckets) {
    if (typeof bucketMap !== 'object' || bucketMap === null) continue
    for (const [provider, models] of Object.entries(bucketMap)) {
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
 * The hour buckets of one local date, ascending by clock hour, as the maps the
 * summarizer takes. Empty hours are absent rather than zero — the chart draws a
 * gap where nothing was recorded, which is the honest reading of "no data".
 * @param {object} doc - the document.
 * @param {string} dateKey - the local-date key.
 * @returns {Array<{ hour: number, buckets: Record<string, Record<string, import('./types.js').TokenTotals>> }>} that day's hours.
 */
export function hoursOfDay(doc, dateKey) {
  const prefix = `${dateKey}T`
  const keys = Object.keys(doc.hours)
    .filter((key) => key.startsWith(prefix) && isLedgerHourKey(key))
    .sort()
  return keys.map((key) => ({ hour: Number(key.slice(prefix.length)), buckets: doc.hours[key] }))
}

/**
 * Whether the document holds hour-resolution buckets at all. A ledger written
 * before hours existed has none, and "no hours recorded" must not be drawn as
 * "nothing was spent that day".
 * @param {object} doc - the document.
 * @returns {boolean} true when at least one hour bucket exists.
 */
export function hasHourBuckets(doc) {
  return Object.keys(doc.hours).some(isLedgerHourKey)
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
          // The model name is a bucket key too, and it is the one level a stored
          // file could still smuggle a prototype member through: without this
          // guard a `__proto__` row is silently dropped further down instead of
          // being rejected here, where the rest of the file is screened.
          if (!isSafeBucketKey(model)) continue
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

  const hours = source.hours
  if (typeof hours === 'object' && hours !== null) {
    for (const [hourKey, providers] of Object.entries(hours)) {
      if (!isLedgerHourKey(hourKey) || typeof providers !== 'object' || providers === null) continue
      const revived = reviveBuckets(providers)
      if (Object.keys(revived).length > 0) doc.hours[hourKey] = revived
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
      // An unreadable instant would otherwise become 0, and the next replacement
      // for this slot would subtract the old sample from the epoch-0 hour while
      // the day bucket kept it — a ledger where a day no longer equals the sum of
      // its hours, with nothing left to say which call to undo. Dropping the slot
      // costs one replacement; a corrupt hour costs the invariant.
      const atMs = num(record.atMs)
      if (!(atMs > 0)) continue
      doc.samples[sessionId] = {
        atMs,
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

  const hoursBuiltAt = num(source.hoursBuiltAt)
  if (hoursBuiltAt > 0) doc.hoursBuiltAt = hoursBuiltAt

  // When the ledger was last rebuilt because a log turned out to repeat another
  // session's calls. Kept so a later scan does not rebuild a second time: the
  // rebuild is only there to clear copies folded before that check existed.
  const replayGuardAt = num(source.replayGuardAt)
  if (replayGuardAt > 0) doc.replayGuardAt = replayGuardAt

  return doc
}
