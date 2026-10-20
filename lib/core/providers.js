/**
 * Display names for the provider routes this plugin can meet.
 *
 * The LLM runtime is asked first (see `UsageService#listProviderRoutes`), so
 * this table is only a fallback for routes the runtime does not describe —
 * and for the settings header, which must print something legible even when
 * the runtime is not mounted. Unknown routes fall back to their own key, which
 * is honest rather than wrong.
 *
 * Adding a route here is cosmetic only: usage is recorded under whatever key
 * the runtime reports, whether or not this table knows it.
 *
 * @module dsh-abacus/core/providers
 */

/** Route key → display name. */
const DISPLAY_NAMES = Object.freeze({
  'opencode-go': 'OpenCode Go',
  'opencode-zen': 'OpenCode Zen',
  deepseek: 'DeepSeek',
  'deepseek-account': 'DeepSeek Account',
  'deepseek-official': 'DeepSeek 官方',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'openai-codex': 'OpenAI Codex',
  kimi: 'Kimi',
  'kimi-coding': 'Kimi For Coding',
  glm: 'GLM',
  zhipu: '智谱 GLM',
  minimax: 'MiniMax',
  mimo: 'MiMo',
  moonshot: 'Moonshot',
  qwen: '通义千问',
  gemini: 'Gemini',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
})

/**
 * A legible display name for a provider route key.
 * @param {string} provider - the route key.
 * @returns {string} the display name, or the key itself when unknown.
 */
export function providerDisplayName(provider) {
  return DISPLAY_NAMES[provider] ?? provider
}

/**
 * Pick the best available name for a route.
 *
 * The LLM runtime usually reports the route key as its `name` (the runtime
 * lists `opencode-go` as "opencode-go"), so a runtime name that merely repeats
 * the key is not a display name and the fallback table should win. Any name
 * the runtime genuinely differentiates is preferred over the table, because
 * the runtime knows about routes this table never heard of.
 *
 * @param {unknown} name - the runtime's name for the route, if any.
 * @param {string} provider - the route key.
 * @returns {string} the name to render.
 */
export function resolveDisplayName(name, provider) {
  if (typeof name === 'string' && name.trim() !== '' && name !== provider) return name
  return providerDisplayName(provider)
}
