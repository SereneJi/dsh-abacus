/**
 * Turning DSH session events into the one sample shape the document folds.
 *
 * A *sample* is the token usage of a single settled model attempt, stamped
 * with everything needed to fold it into (and later subtract it from) the
 * right bucket:
 *
 * ```js
 * { atMs, dayKey, provider, model, usage, turn, step }
 * ```
 *
 * Attribution comes from the event itself wherever possible. `assistant/message`
 * carries `data.message.source` (`{ kind: 'model', provider, model, ... }`), which
 * is *per call* — strictly better than remembering the session's last
 * `request/header`, because a session can switch model between steps. The
 * session route memory is only the fallback for events that omit the source.
 *
 * @module dsh-abacus/core/samples
 */

import { localDateKey } from './document.js'

/**
 * One settled model attempt, ready to fold.
 * @typedef {object} Sample
 * @property {number} atMs - epoch ms the event was recorded at.
 * @property {string} dayKey - `atMs` as a local-date key.
 * @property {string} provider - the provider route key the attempt ran on.
 * @property {string} model - the model id the attempt ran on, or `'unknown'`.
 * @property {import('./types.js').TokenTotals} usage - the attempt's buckets, `calls: 1`.
 * @property {number} turn - the turn the attempt belongs to.
 * @property {number} step - the step the attempt belongs to.
 * @property {string} sessionId - the session the attempt belongs to; empty to skip the session fold.
 */

/** Coerce an untrusted value into a finite number. */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * The last raw `usage` chunk of a compact Assistant stream.
 *
 * A settlement's stream is a list of records; provider usage arrives as
 * `{ type: 'chunk', chunk: { type: 'usage', usage } }` and is not packed, so a
 * backwards scan for the first one is enough. Mirrors DSH's own
 * `lastAssistantStreamChunk` (usage precedes finish, so the last one wins).
 * @param {unknown} stream - the compact stream records.
 * @returns {Record<string, unknown>|undefined} the usage payload, if the stream carried one.
 */
export function lastUsageChunk(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index]
    if (typeof record !== 'object' || record === null) continue
    if (record.type !== 'chunk') continue
    const chunk = record.chunk
    if (typeof chunk !== 'object' || chunk === null || chunk.type !== 'usage') continue
    const usage = chunk.usage
    return typeof usage === 'object' && usage !== null ? usage : undefined
  }
  return undefined
}

/**
 * The provider-reported usage of one session event, if it carries any.
 *
 * Both settlement types are accepted, exactly as the DSH `tokenUsage`
 * projection does: `assistant/message` normally carries `data.usage` directly,
 * and a failed or cancelled `assistant/attempt` may still carry a usage chunk
 * inside its retained stream.
 * @param {{ type?: string, data?: any }} event - the session event.
 * @returns {Record<string, unknown>|undefined} the usage payload.
 */
export function usageOf(event) {
  if (typeof event !== 'object' || event === null) return undefined
  const type = event.type
  if (type !== 'assistant/message' && type !== 'assistant/attempt') return undefined
  const data = event.data
  if (typeof data !== 'object' || data === null) return undefined
  if (type === 'assistant/message' && typeof data.usage === 'object' && data.usage !== null) return data.usage
  return lastUsageChunk(data.stream)
}

/**
 * Convert a provider usage payload into the ledger's bucket shape. Missing
 * optional buckets become 0; `calls` is 1 because a sample *is* one call.
 * @param {Record<string, unknown>} usage - the provider payload.
 * @returns {import('./types.js').TokenTotals} the buckets.
 */
export function bucketsOf(usage) {
  return {
    inputTokens: num(usage.inputTokens) ?? 0,
    outputTokens: num(usage.outputTokens) ?? 0,
    cacheReadTokens: num(usage.cacheReadTokens) ?? 0,
    cacheWriteTokens: num(usage.cacheWriteTokens) ?? 0,
    reasoningTokens: num(usage.reasoningTokens) ?? 0,
    calls: 1,
  }
}

/**
 * The per-call route attribution carried by a settlement message.
 * @param {{ data?: any }} event - the session event.
 * @returns {{ provider: string, model: string }|undefined} the route, when the message names one.
 */
export function routeOf(event) {
  const source = event?.data?.message?.source
  if (typeof source !== 'object' || source === null) return undefined
  const provider = source.provider
  if (typeof provider !== 'string' || provider === '') return undefined
  const model = typeof source.model === 'string' ? source.model : ''
  return { provider, model }
}

/**
 * The `(turn, step)` coordinates a settlement belongs to, used to decide
 * whether a later sample *replaces* an earlier one or adds to it.
 * @param {{ data?: any }} event - the session event.
 * @returns {{ turn: number, step: number }|undefined} the coordinates, when the event carries both.
 */
export function coordinatesOf(event) {
  const turn = num(event?.data?.turn)
  const step = num(event?.data?.step)
  if (turn === undefined || step === undefined) return undefined
  return { turn, step }
}

/**
 * Build a foldable sample from a session event.
 * @param {{ type?: string, data?: any, time?: unknown }} event - the session event.
 * @param {{ provider: string, model: string }|undefined} fallbackRoute - the session's remembered route, when the event names none.
 * @param {number} now - epoch ms to stamp the sample with when the event carries no time.
 * @param {string} sessionId - the session the event belongs to.
 * @returns {Sample|undefined} the sample, or undefined when the event reports no usage or no route.
 */
export function sampleFromEvent(event, fallbackRoute, now, sessionId) {
  const usage = usageOf(event)
  if (usage === undefined) return undefined
  const route = routeOf(event) ?? fallbackRoute
  if (route === undefined || route.provider === '') return undefined
  const atMs = num(event.time) ?? now
  const coordinates = coordinatesOf(event) ?? { turn: -1, step: -1 }
  return {
    atMs,
    dayKey: localDateKey(atMs),
    provider: route.provider,
    model: route.model !== '' ? route.model : 'unknown',
    usage: bucketsOf(usage),
    turn: coordinates.turn,
    step: coordinates.step,
    sessionId: typeof sessionId === 'string' ? sessionId : '',
  }
}

/**
 * Whether an event closes the replacement slot for a retried step, so the
 * retried attempt counts as a fresh call rather than replacing the attempt it
 * supersedes. Mirrors the DSH `tokenUsage` projection's `llm/retry-started`
 * handling.
 * @param {{ type?: string, data?: any }} event - the session event.
 * @returns {{ turn: number, step: number }|undefined} the coordinates the retry restarts, when it is a retry boundary.
 */
export function retryBoundaryOf(event) {
  if (event?.type !== 'llm/retry-started') return undefined
  const turn = num(event.data?.turn)
  const step = num(event.data?.step)
  if (turn === undefined || step === undefined) return undefined
  return { turn, step }
}

/**
 * Whether a sample reports nothing at all. Such a sample is dropped rather
 * than folded: a zero row would make an empty day look recorded.
 * @param {Sample} sample - the sample.
 * @returns {boolean} true when the sample carries no tokens.
 */
export function isEmptySample(sample) {
  const usage = sample.usage
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens <= 0
}
