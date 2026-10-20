/**
 * Trust fence for this plugin's host routes.
 *
 * The routes serve the user's own usage history. Nothing secret crosses them —
 * no API key, no credential, no prompt text — but the *pattern* of what the
 * user has been doing is personal, and the DSH web server applies no access
 * policy of its own, so the fence lives here.
 *
 * Two allow paths, matching the fence the other DSH route families use:
 * loopback (the desktop GUI, always allowed) and a live paired-device cookie
 * when a pairing service is loaded. Without that service the fence stays
 * loopback-only, so an unpaired LAN browser keeps its 403.
 *
 * @module dsh-abacus/host/access
 */

/** IPv4 127/8 predicate (four decimal octets, first == 127). */
export function isIPv4Loopback(v4) {
  const parts = v4.split('.')
  return parts.length === 4
    && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * Whether a socket remote address names the loopback range.
 * @param {string|undefined} address - `socket.remoteAddress`.
 * @returns {boolean} true for `127/8`, `::1`, and IPv4-mapped `::ffff:127/8`.
 */
export function isLoopbackAddress(address) {
  if (address === undefined) return false
  const normalized = address.toLowerCase()
  if (normalized === '::1') return true
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice('::ffff:'.length))
  return isIPv4Loopback(normalized)
}

/**
 * Whether a hostname names the loopback authority.
 * @param {string} hostname - a URL hostname.
 * @returns {boolean} true for `localhost`, `[::1]`, and `127/8`.
 */
export function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  return isIPv4Loopback(hostname)
}

/**
 * Request-level loopback test: a loopback socket address AND a loopback `Host`
 * header, plus browser same-origin markers. The socket address is
 * authoritative; `X-Forwarded-For` is never trusted.
 * @param {import('node:http').IncomingMessage} request - the incoming request.
 * @returns {boolean} true when the request provably came from this machine.
 */
export function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request.socket?.remoteAddress)) return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Structural pairing lookup — this plugin never depends on the pairing plugin. */
function pairingOf(ctx) {
  const fromGet = typeof ctx?.get === 'function' ? ctx.get('remoteWebUiPairing', false) : undefined
  if (fromGet !== undefined && fromGet !== null && typeof fromGet.isPairedDevice === 'function') return fromGet
  const direct = ctx?.remoteWebUiPairing
  return direct !== undefined && direct !== null && typeof direct.isPairedDevice === 'function' ? direct : undefined
}

/**
 * Whether this request may read the usage routes.
 * @param {object} ctx - host context; may expose `remoteWebUiPairing`.
 * @param {import('node:http').IncomingMessage} request - the incoming request.
 * @returns {boolean} true for loopback, or a live paired-device cookie.
 */
export function isUsageRequestAllowed(ctx, request) {
  if (isLoopbackRequest(request)) return true
  const pairing = pairingOf(ctx)
  if (pairing === undefined) return false
  try {
    return pairing.isPairedDevice(request) === true
  } catch {
    return false
  }
}
