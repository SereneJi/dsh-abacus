/**
 * Credential discovery for provider probes.
 *
 * Balance and plan endpoints need the same key the LLM runtime uses, and this
 * plugin must not invent its own secret store. It therefore asks the harness
 * `credentials` service — the same one the runtime asks — and this module is
 * the only place that knows how.
 *
 * Two lookups, in order:
 *
 * 1. **A record** at `<owner>/<id>`. For a provider route the owner is
 *    `llm-pi-ai` and the id is the route key, which is how the runtime stores
 *    per-route keys. An `api-key` record carries `key`; a `grant` record
 *    carries an OAuth payload whose `access` token is what some vendors
 *    (Codex) accept, alongside an optional `chatgpt_account_id`.
 * 2. **A reference name** from the route's own configuration: the `apiKeyEnv`
 *    the user set for the route, or DeepSeek's `DEEPSEEK_API_KEY` default.
 *    `resolve()` then walks the environment snapshot, the managed store and
 *    the `.env` layers.
 *
 * The service's branded `CredentialRef`/`CredentialKey` types are compile-time
 * only — `brandString(value)` returns the value — so this module passes plain
 * strings and needs no `@deepseek-ai/*` import. That is what keeps the host
 * half build-free.
 *
 * Everything here is best-effort: a missing service, an unreadable namespace
 * or a malformed reference reads as "no credential" rather than throwing into
 * the probe loop.
 *
 * @module dsh-abacus/host/credentials
 */

/** A reference name is what the environment layer can hold. */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A record key segment: lowercase, dashes, no dots. */
const KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/

/** The owner namespace the LLM runtime files its per-route records under. */
export const PI_AI_OWNER = 'llm-pi-ai'

/**
 * Whether a string can be used as a credential reference name.
 * @param {unknown} name - candidate.
 * @returns {boolean} whether it is addressable.
 */
export function isRefName(name) {
  return typeof name === 'string' && REF_PATTERN.test(name)
}

/**
 * Whether a string can be used as a record key segment.
 * @param {unknown} segment - candidate.
 * @returns {boolean} whether it is addressable.
 */
export function isKeySegment(segment) {
  return typeof segment === 'string' && KEY_SEGMENT_PATTERN.test(segment)
}

/**
 * The harness credentials service, when this deployment has one.
 * @param {object} ctx - the plugin context.
 * @returns {object|undefined} the service.
 */
export function credentialsOf(ctx) {
  try {
    const service = typeof ctx?.get === 'function' ? ctx.get('credentials') : undefined
    return service !== undefined && service !== null ? service : undefined
  } catch {
    return undefined
  }
}

/**
 * Replace live observable wrappers with their current values.
 *
 * Config namespaces are handed out as reactive accessors in some harness
 * versions; a probe wants the plain object underneath.
 *
 * @param {unknown} value - a value from the settings service.
 * @returns {unknown} the same value, unwrapped.
 */
function unwrapVolatiles(value) {
  if (value === null || typeof value !== 'object') return value
  const getter = value.get
  if (typeof getter === 'function') return unwrapVolatiles(getter.call(value))
  if (Array.isArray(value)) return value.map(unwrapVolatiles)
  const result = {}
  for (const [key, entry] of Object.entries(value)) result[key] = unwrapVolatiles(entry)
  return result
}

/**
 * Read another plugin's resolved configuration namespace.
 *
 * Tries the settings service first (both the older `get()` and the newer
 * `describe()`), then the live loader entries, which is where a namespace
 * registered by a bundle patch is visible even when the settings service does
 * not know it. An unknown namespace reads as `undefined`.
 *
 * @param {object} ctx - the plugin context.
 * @param {string} namespace - the namespace id.
 * @returns {unknown} the resolved value, if any.
 */
export function readNamespace(ctx, namespace) {
  try {
    const settings = typeof ctx?.get === 'function' ? ctx.get('settings') : undefined
    if (settings !== undefined && settings !== null) {
      if (typeof settings.get === 'function') {
        const value = settings.get(namespace)
        if (value !== undefined) return unwrapVolatiles(value)
      }
      if (typeof settings.describe === 'function') {
        const descriptors = settings.describe({ redactSecrets: false })
        if (Array.isArray(descriptors)) {
          const match = descriptors.find((entry) => entry?.ns === namespace)
          if (match !== undefined && match.value !== undefined) return unwrapVolatiles(match.value)
        }
      }
    }
  } catch {
    /* fall through to the loader */
  }

  try {
    const entries = ctx?.root?.loader?.entries?.() ?? ctx?.loader?.entries?.()
    if (entries === undefined) return undefined
    for (const entry of entries) {
      const id = entry?.options?.id
      const name = entry?.options?.name
      if (id !== namespace && name !== namespace) continue
      const config = entry?.fiber?.config
      if (config !== undefined) return unwrapVolatiles(config)
    }
  } catch {
    /* an unreadable loader is the same as an unconfigured namespace */
  }
  return undefined
}

/**
 * The `llm-pi-ai` profile for one provider route.
 * @param {object} ctx - the plugin context.
 * @param {string} route - the route key.
 * @returns {{apiKeyEnv?: string, baseURL?: string}} the profile, if configured.
 */
export function piAiProfile(ctx, route) {
  const section = readNamespace(ctx, PI_AI_OWNER)
  const providers = section?.providers
  if (providers === null || typeof providers !== 'object') return {}
  const profile = providers[route]
  return profile !== null && typeof profile === 'object' ? profile : {}
}

/**
 * The DeepSeek route's configured base URL, when it has one.
 * @param {object} ctx - the plugin context.
 * @returns {string|undefined} the base URL.
 */
export function deepseekBaseUrl(ctx) {
  const section = readNamespace(ctx, 'llm-deepseek')
  const value = section?.baseURL
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The reference name a route's key is stored under.
 * @param {object} ctx - the plugin context.
 * @param {string} route - the route key.
 * @returns {string|undefined} the environment variable name.
 */
export function apiKeyEnvFor(ctx, route) {
  const fromProfile = piAiProfile(ctx, route).apiKeyEnv
  if (isRefName(fromProfile)) return fromProfile
  const deepseek = readNamespace(ctx, 'llm-deepseek')
  if (isDeepSeekRoute(route)) {
    const configured = deepseek?.apiKeyEnv
    return isRefName(configured) ? configured : 'DEEPSEEK_API_KEY'
  }
  return undefined
}

/**
 * Whether a route key names the official DeepSeek provider.
 * @param {string} route - the route key.
 * @returns {boolean} whether it is DeepSeek.
 */
export function isDeepSeekRoute(route) {
  return route === 'deepseek' || route === 'deepseek-official'
}

/**
 * Resolve the credential a provider probe should use.
 *
 * @param {object} ctx - the plugin context.
 * @param {string} route - the provider route key.
 * @returns {Promise<{kind: 'api-key'|'oauth'|'none', key?: string, accountId?: string, source?: string}>} the credential.
 */
export async function resolveCredential(ctx, route) {
  const credentials = credentialsOf(ctx)
  if (credentials === undefined) return { kind: 'none' }

  if (isKeySegment(route) && typeof credentials.readRecord === 'function') {
    let record
    try {
      record = await credentials.readRecord(`${PI_AI_OWNER}/${route}`)
    } catch {
      record = undefined
    }
    if (record?.kind === 'api-key') {
      if (typeof record.key === 'string' && record.key !== '') {
        return { kind: 'api-key', key: record.key, source: 'record' }
      }
    } else if (record?.kind === 'grant') {
      const access = record.payload?.access
      if (typeof access === 'string' && access !== '') {
        const accountId = record.payload?.chatgpt_account_id
        return {
          kind: 'oauth',
          key: access,
          accountId: typeof accountId === 'string' ? accountId : undefined,
          source: 'record',
        }
      }
    }
  }

  const envName = apiKeyEnvFor(ctx, route)
  if (envName !== undefined && typeof credentials.resolve === 'function') {
    try {
      const resolved = await credentials.resolve(envName)
      const value = resolved?.value
      if (typeof value === 'string' && value !== '') {
        return { kind: 'api-key', key: value, source: resolved?.source ?? envName }
      }
    } catch {
      /* an unreadable reference is the same as an unset one */
    }
  }
  return { kind: 'none' }
}
