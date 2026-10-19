/**
 * Renders the plugin's real components into a static page for visual review.
 *
 * The plugin's surfaces live inside the DSH window, which cannot be screenshotted
 * from here, so this tool rebuilds the smallest thing that answers the question
 * "does this look right": the shell's own `--dsw-*` theme tokens (read from the
 * running instance, cached to `preview/tokens.css` so the tool works offline),
 * the plugin's own stylesheet, and the actual component output serialised to
 * HTML by the same fake React the tests use.
 *
 * Usage:
 *   node tools/preview.mjs            # write preview/*.html and screenshot each
 *   node tools/preview.mjs --no-shot  # write the HTML only
 *
 * The markup is the real thing — a component change shows up here without any
 * mock markup to keep in sync. Only the dialog chrome around it (the panel and
 * the left navigation) is drawn by this file, and it is labelled as such.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CLIENT_PATH, createPage, createReact, fakeRequire, loadBundle, tick } from '../test/harness.mjs'

const BASE = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387'
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUT_DIR = fileURLToPath(new URL('../preview/', import.meta.url))
const TOKEN_CACHE = fileURLToPath(new URL('../preview/tokens.css', import.meta.url))
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const SHOOT = !process.argv.includes('--no-shot')

/**
 * `--client=<path>` renders some other copy of the bundle, which is how the
 * before/after pair is produced: `git show baseline-0.6.2:lib/client.js` into a
 * temp file, then preview it with `--tag=before`. `--tag=<name>` prefixes the
 * output files so a run never overwrites the current design's images.
 */
const CLIENT_ARG = process.argv.find((arg) => arg.startsWith('--client='))
const SOURCE_PATH = CLIENT_ARG === undefined ? CLIENT_PATH : resolve(CLIENT_ARG.slice('--client='.length))
const TAG_ARG = process.argv.find((arg) => arg.startsWith('--tag='))
const TAG = TAG_ARG === undefined ? '' : `${TAG_ARG.slice('--tag='.length)}-`

/**
 * `--cache-write=<tokens>` seeds the window with cache writes. Only Anthropic
 * style providers bill them, so the ordinary fixture reports none and the tile
 * is hidden — which makes "what does it look like when there are writes" a
 * question the bench cannot otherwise answer.
 */
const CACHE_WRITE_ARG = process.argv.find((arg) => arg.startsWith('--cache-write='))
const CACHE_WRITE = CACHE_WRITE_ARG === undefined ? 0 : Number(CACHE_WRITE_ARG.slice('--cache-write='.length)) || 0

//#region ----------------------------------------------------------- plugin CSS

/** The plugin's stylesheet, lifted out of the bundle's `const CSS = \`…\``. */
function pluginCss() {
  return pluginCssFrom(readFileSync(SOURCE_PATH, 'utf8'))
}

/**
 * Lift the stylesheet out of a copy of the bundle.
 *
 * Exported because it is the one part of this bench with a rule worth testing:
 * the stylesheet is a template literal inside a script, so "find the first
 * backtick after the marker" is the whole extraction.
 * @param {string} source - the bundle's text.
 * @returns {string} the stylesheet.
 */
export function pluginCssFrom(source) {
  const marker = 'const CSS = `'
  const start = source.indexOf(marker)
  if (start < 0) throw new Error('lib/client.js no longer declares `const CSS = `…``')
  const from = start + marker.length
  const end = source.indexOf('`', from)
  if (end < 0) throw new Error('the plugin stylesheet template literal is unterminated')
  return source.slice(from, end)
}

//#endregion

//#region --------------------------------------------------------- theme tokens

/**
 * Every `--dsw-*: value` pair declared by one served bundle.
 *
 * First declaration wins: the theme bundle lists the light palette first and
 * re-declares every token under `body[data-ds-dark-theme]`, so keeping the last
 * one would render the preview in the dark theme the app is not using.
 */
export function tokensOf(source) {
  const found = new Map()
  let cursor = 0
  for (;;) {
    const at = source.indexOf('--dsw-', cursor)
    if (at < 0) break
    const colon = source.indexOf(':', at)
    if (colon < 0) break
    const name = source.slice(at, colon).trim()
    if (!/^--dsw-[a-z0-9-]+$/.test(name)) {
      cursor = at + 6
      continue
    }
    let end = colon + 1
    while (end < source.length && source[end] !== ';' && source[end] !== '}') end += 1
    const value = source.slice(colon + 1, end).trim()
    if (value !== '' && !found.has(name)) found.set(name, value)
    cursor = end
  }
  return found
}

async function readGraph() {
  const controller = new AbortController()
  try {
    const response = await fetch(`${BASE}/plugins/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    })
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (!line.startsWith('data:')) continue
        const payload = JSON.parse(line.slice(5).trim())
        if (payload.graph !== undefined) return payload.graph
      }
    }
    return null
  } finally {
    controller.abort()
  }
}

/** The theme tokens, from the running shell when reachable, else from cache. */
async function themeTokens() {
  try {
    const graph = await readGraph()
    const entry = graph?.entries.find((row) => row.id.includes('dsh-client-ui-theme'))
    if (entry === undefined) throw new Error('no theme bundle in the module graph')
    const body = await (await fetch(`${BASE}/${entry.url}`)).text()
    const tokens = tokensOf(body)
    if (tokens.size < 100) throw new Error(`the theme bundle only declared ${tokens.size} tokens`)
    const css = `:root{\n${[...tokens].map(([name, value]) => `  ${name}: ${value};`).join('\n')}\n}\n`
    writeFileSync(TOKEN_CACHE, css, 'utf8')
    return { css, source: `the running shell (${tokens.size} tokens)` }
  } catch (error) {
    if (!existsSync(TOKEN_CACHE)) throw error
    return { css: readFileSync(TOKEN_CACHE, 'utf8'), source: 'preview/tokens.css (cached)' }
  }
}

//#endregion

//#region ------------------------------------------------------------- rendering

const VOID_TAGS = new Set(['input', 'br', 'hr', 'img', 'meta', 'link'])
const UNITLESS = new Set(['opacity', 'zIndex', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink', 'order'])

function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

export function styleText(style) {
  return Object.entries(style)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}:${typeof value === 'number' && !UNITLESS.has(key) ? `${value}px` : value}`)
    .join(';')
}

export function attributesOf(props) {
  const parts = []
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children' || key === 'key') continue
    if (key.startsWith('on')) continue
    if (key === 'className') {
      if (value) parts.push(`class="${escapeHtml(value)}"`)
      continue
    }
    if (key === 'style') {
      const text = styleText(value ?? {})
      if (text !== '') parts.push(`style="${escapeHtml(text)}"`)
      continue
    }
    if (value === null || value === undefined || value === false) continue
    if (value === true) {
      // React writes `aria-*` booleans as the string "true", and the stylesheet
      // selects on that exact value; a bare attribute would be "" and silently
      // lose the style. Other boolean attributes (checked, disabled) stay bare.
      parts.push(key.startsWith('aria-') ? `${key}="true"` : key)
      continue
    }
    parts.push(`${key}="${escapeHtml(value)}"`)
  }
  return parts.length === 0 ? '' : ` ${parts.join(' ')}`
}

/** Serialise a rendered tree to HTML. Strings are text, everything else a tag. */
export function serialize(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (Array.isArray(node)) return node.map(serialize).join('')
  const tag = typeof node.type === 'string' ? node.type : 'div'
  const open = `<${tag}${attributesOf(node.props ?? {})}>`
  if (VOID_TAGS.has(tag)) return open
  return `${open}${node.children.map(serialize).join('')}</${tag}>`
}

/** Click a tab by its visible label, the way a person would. */
async function clickTab(react, Component, props, label) {
  const { tree } = react.render(Component, props)
  const find = (node) => {
    if (node === null || node === undefined || typeof node === 'string') return null
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = find(child)
        if (hit !== null) return hit
      }
      return null
    }
    if (typeof node.type === 'string' && node.children.length > 0 && node.children.every((child) => typeof child === 'string') && node.children.join('') === label) return node
    for (const child of node.children) {
      const hit = find(child)
      if (hit !== null) return hit
    }
    return null
  }
  const button = find(tree)?.props?.onClick
  if (typeof button !== 'function') throw new Error(`no clickable tab labelled ${label}`)
  button()
  // A tab whose data arrives over the network needs a few settle cycles before
  // the tree shows anything but its loading line. Render, drain the microtask
  // queue, and render again until the text stops changing.
  let previous = ''
  let current = ''
  for (let round = 0; round < 6; round += 1) {
    current = textOfTree(react.render(Component, props).tree)
    if (round > 0 && current === previous) break
    previous = current
    await tick()
  }
  return react.render(Component, props).tree
}

/** The concatenated text of a rendered tree, used to detect settling. */
function textOfTree(node) {
  if (node === null || node === undefined || node === true || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOfTree).join('')
  return (node.children ?? []).map(textOfTree).join('')
}

//#endregion

//#region -------------------------------------------------------------- fixtures

function totals(overrides = {}) {
  return { inputTokens: 1_284_000, outputTokens: 96_400, cacheReadTokens: 31_900_000, cacheWriteTokens: CACHE_WRITE, calls: 412, ...overrides }
}

/**
 * One day of the chart fixture, sized off its call count so the bars actually
 * show a shape. Giving every day the same totals drew seven identical columns,
 * which is exactly what the chart exists to distinguish.
 * @param {string} date - the ledger day key.
 * @param {number} calls - that day's call count.
 */
function day(date, calls) {
  const share = calls / 412
  return {
    date,
    totals: {
      inputTokens: Math.round(1_284_000 * share),
      outputTokens: Math.round(96_400 * share),
      cacheReadTokens: Math.round(31_900_000 * share),
      cacheWriteTokens: Math.round(CACHE_WRITE * share),
      calls,
    },
  }
}

/**
 * A fixed instant, and the version the plugin actually is.
 *
 * The fixtures used to carry a live clock reading, so every re-run rewrote all five
 * screenshots with a new clock reading and the committed images differed from
 * each other for no reason. They also carried a hardcoded version, which left the
 * published settings page advertising 0.8.0 long after that stopped being true.
 */
const FIXED_NOW = new Date('2026-10-18T09:41:00+08:00').getTime()
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

const OVERVIEW = {
  updatedAt: FIXED_NOW,
  version: PACKAGE_VERSION,
  config: {
    enabled: true,
    pollIntervalSec: 60,
    probeEnabled: true,
    probeIntervalSec: 300,
    alertEnabled: true,
    alertBalanceBelow: 1,
    alertWindow5h: 10,
    alertWindowWeek: 5,
    alertWindowMonth: 2,
    prices: {
      'mimo-v2.6-flash': { input: 0.5, output: 1.5, cacheRead: 0.1, cacheWrite: 0.5 },
    },
  },
  // What the editor names under the table, so the render shows both halves of
  // the rule: the rows the user wrote, and the rows they did not have to.
  builtinPrices: {
    'deepseek-flash': { input: 1, output: 4, cacheRead: 0.02, cacheWrite: 0, offPeak: true },
    'deepseek-v4-pro': { input: 4.5, output: 13.5, cacheRead: 0.15, cacheWrite: 0, offPeak: true },
  },
  current: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', displayName: 'OpenCode Go' },
  providers: [
    { provider: 'opencode-go', displayName: 'OpenCode Go', totals: totals({ inputTokens: 1_100_000 }), models: [{ model: 'deepseek-v4.1-flash', totals: totals({ inputTokens: 1_100_000 }) }] },
    { provider: 'deepseek-official', displayName: 'DeepSeek Account', totals: totals({ inputTokens: 184_000, calls: 96 }), models: [{ model: 'deepseek-flash', totals: totals({ inputTokens: 184_000, calls: 96 }) }] },
  ],
  usage: {
    today: {
      date: '2026-10-18',
      totals: totals(),
      providers: [
        { provider: 'opencode-go', displayName: 'OpenCode Go', totals: totals({ inputTokens: 1_100_000 }), models: [{ model: 'deepseek-v4.1-flash', totals: totals({ inputTokens: 1_100_000 }) }] },
        { provider: 'deepseek-official', displayName: 'DeepSeek Account', totals: totals({ inputTokens: 184_000, calls: 96 }), models: [{ model: 'deepseek-flash', totals: totals({ inputTokens: 184_000, calls: 96 }) }] },
      ],
    },
    availableDays: ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'],
  },
  alerts: [{ provider: 'opencode-go', displayName: 'OpenCode Go', kind: 'window', window: 'week', percent: 95, remaining: 5, threshold: 5 }],
  history: { atMs: FIXED_NOW - 3600_000, files: 3, events: 41 },
}

/**
 * A cost view in the shape the host sends: one provider priced by the built-in
 * table, one priced by a line the user added, and one the table cannot price at
 * all. Those are the three cases the tab has to tell apart, and the third one is
 * why the total is not simply "everything multiplied out".
 */
const COST = {
  currency: 'CNY',
  total: 46.82,
  tokens: 33_280_000,
  pricedTokens: 32_280_000,
  unpricedTokens: 1_000_000,
  unpricedCount: 1,
  unpriced: [{ model: 'gpt-5.6-luna', tokens: 1_000_000 }],
  providers: [
    {
      provider: 'opencode-go',
      displayName: 'OpenCode Go',
      cost: 44.9,
      tokens: 32_100_000,
      pricedTokens: 32_100_000,
      unpricedTokens: 0,
      models: [{ model: 'deepseek-v4.1-flash', cost: 44.9, tokens: 32_100_000, calls: 1_812, priced: true }],
    },
    {
      provider: 'deepseek-official',
      displayName: 'DeepSeek Account',
      cost: 1.92,
      tokens: 180_000,
      pricedTokens: 180_000,
      unpricedTokens: 0,
      models: [{ model: 'deepseek-flash', cost: 1.92, tokens: 180_000, calls: 96, priced: true }],
    },
    {
      provider: 'openrouter',
      displayName: 'OpenRouter',
      cost: 0,
      tokens: 1_000_000,
      pricedTokens: 0,
      unpricedTokens: 1_000_000,
      models: [{ model: 'gpt-5.6-luna', cost: 0, tokens: 1_000_000, calls: 24, priced: false }],
    },
  ],
}

const RANGE = {
  from: '2026-10-12',
  to: '2026-10-18',
  totals: totals({ calls: 2_318 }),
  providers: OVERVIEW.providers,
  cost: COST,
  days: [
    day('2026-10-12', 240),
    day('2026-10-13', 388),
    day('2026-10-14', 176),
    day('2026-10-15', 402),
    day('2026-10-16', 331),
    day('2026-10-17', 469),
    day('2026-10-18', 412),
    // Each day carries its own money too, so the cost tab can chart the window
    // day by day. Derived from the same call count as the tokens, so the money
    // bars and the token bars tell the same story.
  ].map((row) => ({ ...row, cost: { currency: 'CNY', total: Math.round(4682 * (row.totals.calls / 412)) / 100 } })),
}

const FACTS = {
  updatedAt: FIXED_NOW,
  probing: false,
  intervalSec: 300,
  providers: [
    {
      provider: 'opencode-go',
      displayName: 'OpenCode Go',
      credential: 'api-key',
      balanceSupported: false,
      balanceError: 'unsupported',
      planSupported: true,
      plan: { planName: 'Pro', windows: [{ key: '5h', percent: 11, resetsAt: '2026-10-17T20:17:33.000Z' }, { key: 'week', percent: 41, resetsAt: '2026-10-19T00:00:00.000Z' }] },
      updatedAt: FIXED_NOW,
    },
    {
      provider: 'deepseek-official',
      displayName: 'DeepSeek Account',
      credential: 'api-key',
      balanceSupported: true,
      balance: { currency: 'CNY', totalBalance: '12.34' },
      planSupported: false,
      planError: 'unsupported',
      updatedAt: FIXED_NOW,
    },
    { provider: 'openrouter', displayName: 'OpenRouter', credential: 'none', balanceSupported: true, balanceError: 'no-credential', planSupported: false, planError: 'unsupported', updatedAt: FIXED_NOW },
  ],
  catalog: { probeable: ['kimi-coding', 'minimax', 'minimax-cn', 'moonshotai', 'moonshotai-cn', 'siliconflow', 'zai', 'zenmux'] },
}

/** Answer the routes the components ask for, so the tabs render with data. */
function routedFetch() {
  return async (url) => {
    const path = String(url).split('?')[0]
    const body = path.endsWith('overview')
      ? { ok: true, overview: OVERVIEW }
      : path.endsWith('range')
        ? { ok: true, range: RANGE }
        : path.endsWith('providers')
          ? { ok: true, providers: FACTS }
          : path.endsWith('session')
            ? { ok: true, session: { sessionId: 'preview', totals: totals(), updatedAt: FIXED_NOW, providers: OVERVIEW.providers } }
            : {}
    return { ok: true, status: 200, json: async () => body }
  }
}

//#endregion

//#region ----------------------------------------------------------------- page

/** The dialog chrome around the section: drawn here, clearly marked as a mock. */
function shell(inner) {
  const nav = ['账号与余额', '通用设置', '模型', '内置插件', 'Agent 预设', '插件市场', '皮肤', '用量统计']
  return `<div class="preview-panel" data-preview-chrome="mock">
  <nav class="preview-nav" aria-hidden="true">
    <div class="preview-nav-title">设置</div>
    ${nav.map((label) => `<div class="preview-nav-row${label === '用量统计' ? ' is-current' : ''}">${label}</div>`).join('\n    ')}
  </nav>
  <div class="preview-content">
${inner}
  </div>
</div>`
}

function documentFor(title, tokens, css, inner) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-usage-stat preview — ${escapeHtml(title)}</title>
<style>
/* 1. the shell's theme tokens, ${tokens.source} */
${tokens.css}
/* 2. mock dialog chrome (not part of the plugin) */
html,body{margin:0}
body{background:var(--dsw-alias-bg-layer-1,#eef0f3);color:var(--dsw-alias-label-primary,#111);font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);display:flex;justify-content:center;padding:24px;box-sizing:border-box}
.preview-panel{box-sizing:border-box;display:flex;gap:0;width:800px;max-width:100%;border-radius:var(--dsw-radius-panel,16px);background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:var(--dsw-elevation-prominent,0 12px 40px rgba(0,0,0,.18));overflow:hidden}
.preview-nav{box-sizing:border-box;flex:none;width:188px;padding:22px 12px 22px;display:flex;flex-direction:column;gap:4px}
.preview-nav-title{font-size:16px;font-weight:500;line-height:24px;padding:0 12px 10px}
.preview-nav-row{font-size:14px;line-height:22px;padding:8px 12px;border-radius:var(--dsw-radius-sm,8px);color:var(--dsw-alias-label-secondary,#555)}
.preview-nav-row.is-current{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-primary,#111)}
.preview-content{box-sizing:border-box;flex:1;min-width:0;padding:28px}
/* 3. the plugin's own stylesheet, verbatim from lib/client.js */
${css}
</style>
${MEASURE}
</head>
<body>
${shell(inner)}
</body>
</html>
`
}

/**
 * Records the laid-out height of the page on `<html>` so `shoot` can size the
 * window to the content.
 *
 * Every shot used to be taken in one 860x1120 window, which meant the sidebar
 * card — a 248px column — sat in a mostly-empty canvas, and so did any tab
 * shorter than the dialog. The images were then used in the README, where all
 * that blank space reads as an enormous gap between one picture and the next.
 * The page knows its own height; asking it is cheaper than guessing.
 */
const MEASURE = `<script>addEventListener('load',()=>{document.documentElement.dataset.previewHeight=String(Math.ceil(document.documentElement.scrollHeight))})</script>`

/** The content height of a rendered page, measured in a deliberately short window. */
function contentHeight(htmlPath, width) {
  const dom = execFileSync(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${width},200`,
    '--virtual-time-budget=3000',
    '--dump-dom',
    `file:///${htmlPath.replaceAll('\\', '/')}`,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const measured = Number(/data-preview-height="(\d+)"/.exec(dom)?.[1])
  return Number.isFinite(measured) && measured > 0 ? measured : 0
}

/**
 * Screenshot a rendered page, sized to its content.
 *
 * `width` is the CSS pixel window width; the height comes from the page itself,
 * with `fallback` used when the measurement does not come back.
 */
function shoot(name, htmlPath, width, fallback) {
  if (!SHOOT) return
  if (!existsSync(CHROME)) {
    console.log(`   (no Chrome at ${CHROME}; skipped the screenshot)`)
    return
  }
  const measured = contentHeight(htmlPath, width)
  const height = measured > 0 ? measured : fallback
  const png = `${OUT_DIR}${name}.png`
  execFileSync(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    `--window-size=${width},${height}`,
    `--screenshot=${png}`,
    `file:///${htmlPath.replaceAll('\\', '/')}`,
  ], { stdio: 'ignore' })
  console.log(`   ${png} (${width}x${height})`)
}

/**
 * The sidebar rail, drawn here as a mock: the card lives in a 248px column at
 * the bottom of the rail, and a card that looks right in a wide dialog can
 * still fall apart in a column this narrow. The rows above it are filler.
 */
const RAIL_WIDTH = 248
const RAIL_HEIGHT = 560
/** Breathing room around the rail, wide enough for the card's own shadow. */
const RAIL_MARGIN = 40
/** The settings dialog window: 800px of dialog plus 24px of page padding each side. */
const DIALOG_WIDTH = 860
/** Only used when the page's self-measurement does not come back. */
const DIALOG_FALLBACK_HEIGHT = 1120

/**
 * Filler for the mock sidebar, and the only invented thing in these pages.
 *
 * Everything else here is the plugin's real output, but a sidebar with nothing
 * above the card looks broken — so these rows stand in for session titles. They
 * are rasterised into `preview/foot*.png`, which are committed and published:
 * a real title pasted in here leaks the user's conversation list to GitHub.
 * `test/tools.test.mjs` pins this exact list so a change has to be deliberate.
 */
export const RAIL_ROWS = ['新会话', '帮我整理这批照片', '写一个周报模板', '这段报错是什么意思', '优化一下这段查询']

function rail(inner) {
  return `<div class="preview-rail" data-preview-chrome="mock">
  <div class="preview-rail-brand">deepseek <b>HARNESS</b></div>
  <div class="preview-rail-new">新会话</div>
  <div class="preview-rail-head">工作区</div>
  ${RAIL_ROWS.map((label) => `<div class="preview-rail-row">${label}</div>`).join('\n  ')}
  <div class="preview-rail-spacer"></div>
  ${inner}
</div>`
}

function railDocument(title, tokens, css, inner) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>dsh-usage-stat preview — ${escapeHtml(title)}</title>
<style>
/* 1. the shell's theme tokens, ${tokens.source} */
${tokens.css}
/* 2. mock sidebar chrome (not part of the plugin) */
html,body{margin:0}
/* The rail sits at the top-left rather than centred. Chrome on Windows refuses a
   window narrower than 500px, so a 296px shot is laid out in a 500px viewport and
   the screenshot takes the top-left region of it; centring the rail would push it
   out of that region and cut it in half. Left-aligned, the capture is the card. */
body{background:var(--dsw-alias-bg-layer-1,#eef0f3);color:var(--dsw-alias-label-primary,#111);font-family:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);padding:${RAIL_MARGIN}px;box-sizing:border-box}
.preview-rail{box-sizing:border-box;display:flex;flex-direction:column;gap:2px;width:${RAIL_WIDTH}px;height:${RAIL_HEIGHT}px;padding:12px 8px;border-radius:var(--dsw-radius-panel,16px);background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:var(--dsw-elevation-prominent,0 12px 40px rgba(0,0,0,.18))}
.preview-rail-brand{font-size:13px;font-weight:500;padding:0 8px 10px;letter-spacing:.01em}
.preview-rail-new{font-size:13px;line-height:20px;padding:7px 10px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,#111));color:var(--dsw-alias-label-primary-foreground,#fff)}
.preview-rail-head{font-size:11px;padding:12px 8px 4px;color:var(--dsw-alias-label-tertiary,#888)}
.preview-rail-row{font-size:12px;line-height:18px;padding:6px 8px;border-radius:var(--dsw-radius-sm,8px);color:var(--dsw-alias-label-secondary,#555);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.preview-rail-spacer{flex:1;min-height:24px}
/* 3. the plugin's own stylesheet, verbatim from lib/client.js */
${css}
</style>
${MEASURE}
</head>
<body>
${rail(inner)}
</body>
</html>
`
}

//#endregion

/** Whether this file was run rather than imported. */
function isMain() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const tokens = await themeTokens()
  const css = pluginCss()

  const page = createPage()
  const react = createReact()
  // The loader only *registers* the factory; calling it is what produces exports.
  const definition = loadBundle(page, react, { fetch: routedFetch(), path: SOURCE_PATH })
  const exported = definition.factory(fakeRequire(react))
  const UsageSection = exported?.__internals?.UsageSection
  const createOverviewStore = exported?.__internals?.createOverviewStore
  if (typeof UsageSection !== 'function') throw new Error('the bundle no longer exports UsageSection through __internals')
  if (typeof createOverviewStore !== 'function') throw new Error('the bundle no longer exports createOverviewStore through __internals')

  // The section reads its data from the same store the live plugin polls into, so
  // the preview seeds that store rather than inventing a props shape.
  const store = createOverviewStore()
  store.set({ status: 'ready', overview: OVERVIEW, error: null })

  const section = () => ({ store })

  const tabs = [
    ['usage', '用量'],
    ['cost', '金额'],
    ['account', '账户'],
    ['settings', '设置'],
  ]

  for (const [name, label] of tabs) {
    // The section fetches on mount, so render, let the promises land, then render
    // again to read the state they set — exactly what the tests do.
    react.render(UsageSection, section())
    await tick()
    const tree = await clickTab(react, UsageSection, section(), label)
    const htmlPath = `${OUT_DIR}${TAG}${name}.html`
    writeFileSync(htmlPath, documentFor(label, tokens, css, serialize(tree)), 'utf8')
    console.log(`${label} → ${htmlPath}`)
    shoot(`${TAG}${name}`, htmlPath, DIALOG_WIDTH, DIALOG_FALLBACK_HEIGHT)
  }

  // The sidebar card, in its own 248px rail. It reads its expanded flag from
  // `window.localStorage` at render time, so the stub is swapped between the two
  // shots instead of adding a prop the real component does not have.
  const FootCard = exported?.__internals?.FootCard
  if (typeof FootCard !== 'function') throw new Error('the bundle no longer exports FootCard through __internals')

  for (const [name, label, flag] of [['foot', '今日用量（展开）', '1'], ['foot-collapsed', '今日用量（折叠）', '0']]) {
    globalThis.window.localStorage = { getItem: () => flag, setItem: () => {} }
    // The expanded flag seeds a useState initialiser, so it is read once per
    // component instance. Without clearing the hook slots the second shot would
    // reuse the first one's state and the two images would be identical.
    react.reset()
    const tree = react.render(FootCard, { store }).tree
    const htmlPath = `${OUT_DIR}${TAG}${name}.html`
    writeFileSync(htmlPath, railDocument(label, tokens, css, serialize(tree)), 'utf8')
    console.log(`${label} → ${htmlPath}`)
    shoot(`${TAG}${name}`, htmlPath, RAIL_WIDTH + RAIL_MARGIN * 2, RAIL_HEIGHT + RAIL_MARGIN * 2)
  }

  console.log(`\ntokens from ${tokens.source}`)
}

if (isMain()) await main()