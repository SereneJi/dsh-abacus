/**
 * Small HTTP helpers for the host routes: a bounded JSON body reader and a
 * JSON writer. Kept local so the package has no shared-source dependency.
 *
 * @module dsh-usage-stat/host/http
 */

/** Default cap for {@link readJsonBody}: 64 KiB. */
const DEFAULT_BODY_MAX_BYTES = 64 * 1024

/**
 * Read a request body as JSON, or null when the body is empty, invalid, or
 * past the cap. Overflow destroys the request instead of draining the
 * remainder, so callers must not keep reading it afterwards.
 *
 * A client that aborts mid-body — a closed tab, or the client's own 20 s
 * request timeout — makes the async iteration reject. That is a dropped
 * request, not a server fault, so it is reported as a null body and the route
 * answers its own deliberate 400 instead of the web server logging a warning
 * for every aborted poll during a shutdown.
 * @param {import('node:http').IncomingMessage} req - the request.
 * @param {{ maxBytes?: number, objectOnly?: boolean }} [options] - reader options.
 * @returns {Promise<unknown|null>} the parsed body, or null.
 */
export async function readJsonBody(req, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_BODY_MAX_BYTES
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      const buffer = /** @type {Buffer} */ (chunk)
      size += buffer.length
      if (size > maxBytes) {
        req.destroy()
        return null
      }
      chunks.push(buffer)
    }
  } catch {
    return null
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try {
    const parsed = JSON.parse(text)
    if (options.objectOnly === true && !isJsonObject(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Whether a value is a JSON object (not null, not an array).
 * @param {unknown} value - the candidate.
 * @returns {boolean} true for a plain JSON object.
 */
export function isJsonObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Response headers every route shares. */
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} res - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - the JSON-serializable body.
 * @param {Record<string, string>} [headers] - extra or overriding headers.
 */
export function writeJson(res, status, body, headers = {}) {
  res.writeHead(status, { ...JSON_HEADERS, ...headers })
  res.end(JSON.stringify(body))
}
