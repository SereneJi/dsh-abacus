/**
 * Shared browser-half harness for dsh-usage-stat.
 *
 * The client bundle cannot be exercised by the host's runner without a DOM, so
 * this module supplies a small hand-rolled one: enough element and
 * `querySelector` behaviour for the sidebar foot placement, and enough of
 * React's hook contract to call the components as plain functions and read the
 * tree they return.
 *
 * It lives outside the test file because two callers need the same renderer:
 * the tests in `test/client.test.mjs`, and `tools/preview.mjs`, which renders
 * the real components into a static page for visual review. A second copy of a
 * hook runtime would drift from this one the first time either changed.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Absolute path of the shipped browser bundle. */
export const CLIENT_PATH = fileURLToPath(new URL('../lib/client.js', import.meta.url))
//#region ------------------------------------------------------------- fake DOM

/** Attribute selectors the plugin actually uses, and nothing more. */
export function matchesSimple(node, selector) {
  const match = /^\[([A-Za-z0-9_-]+)(?:([*^$~|]?=)"?([^"\]]*)"?)?\]$/.exec(selector.trim())
  if (match === null) return false
  const [, attr, op, value] = match
  const actual = attr === 'class'
    ? node.className
    : node.attributes[attr] ?? (typeof node[attr] === 'string' ? node[attr] : undefined)
  if (actual === undefined || actual === null) return false
  const text = String(actual)
  if (op === undefined) return true
  if (op === '=') return text === value
  if (op === '*=') return text.includes(value)
  if (op === '^=') return text.startsWith(value)
  if (op === '$=') return text.endsWith(value)
  return false
}

export function matches(node, selector) {
  return selector.split(',').some((part) => matchesSimple(node, part))
}

export class FakeNode {
  constructor(tag, attributes = {}) {
    this.tagName = String(tag).toUpperCase()
    this.attributes = { ...attributes }
    this.className = attributes.class ?? ''
    this.id = attributes.id ?? ''
    this.children = []
    this.parentNode = null
    this.style = {}
    this.textContent = ''
    this.listeners = new Map()
  }

  get lastElementChild() {
    return this.children[this.children.length - 1] ?? null
  }

  get firstElementChild() {
    return this.children[0] ?? null
  }

  get nextElementSibling() {
    if (this.parentNode === null) return null
    const siblings = this.parentNode.children
    return siblings[siblings.indexOf(this) + 1] ?? null
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value)
    if (name === 'class') this.className = String(value)
    if (name === 'id') this.id = String(value)
  }

  getAttribute(name) {
    return this.attributes[name] ?? null
  }

  append(child) {
    return this.appendChild(child)
  }

  appendChild(child) {
    child.parentNode?.removeChild(child)
    child.parentNode = this
    this.children.push(child)
    return child
  }

  insertBefore(child, reference) {
    const index = this.children.indexOf(reference)
    if (index === -1) return this.appendChild(child)
    child.parentNode?.removeChild(child)
    child.parentNode = this
    this.children.splice(index, 0, child)
    return child
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index !== -1) this.children.splice(index, 1)
    child.parentNode = null
    return child
  }

  remove() {
    this.parentNode?.removeChild(this)
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(listener)
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener)
  }

  /** Depth-first descendants only; a node never matches itself, as in the DOM. */
  querySelector(selector) {
    for (const child of this.children) {
      if (matches(child, selector)) return child
      const nested = child.querySelector(selector)
      if (nested !== null) return nested
    }
    return null
  }

  querySelectorAll(selector) {
    const found = []
    for (const child of this.children) {
      if (matches(child, selector)) found.push(child)
      found.push(...child.querySelectorAll(selector))
    }
    return found
  }
}

/**
 * A page holding the sidebar shape the plugin targets:
 * `sidebarCol > footArea > [footerActions, settingsArea]`.
 */
export function createPage() {
  const html = new FakeNode('html')
  const head = new FakeNode('head')
  const body = new FakeNode('body')
  const column = new FakeNode('div', { class: 'a1b2c3_sidebarCol' })
  const footArea = new FakeNode('div', { class: 'a1b2c3_footArea' })
  const footerActions = new FakeNode('div', { class: 'a1b2c3_footerActions' })
  const settingsArea = new FakeNode('div', { class: 'a1b2c3_settingsArea' })

  html.append(head)
  html.append(body)
  body.append(column)
  column.append(footArea)
  footArea.append(footerActions)
  footArea.append(settingsArea)

  const document = {
    documentElement: html,
    head,
    body,
    visibilityState: 'visible',
    lang: 'zh-CN',
    getElementById: (id) => (head.children.find((node) => node.id === id) ?? body.querySelector(`[id="${id}"]`)),
    createElement: (tag) => new FakeNode(tag),
    querySelector: (selector) => html.querySelector(selector),
    addEventListener: () => {},
    removeEventListener: () => {},
  }

  return { document, head, body, column, footArea, footerActions, settingsArea }
}

//#endregion

//#region ----------------------------------------------------------- fake React

/**
 * Enough of React to render a component tree as plain data.
 *
 * Hooks are keyed by the component's position in the tree, so a nested
 * component (a `Metric`, a `UsageRow`) gets its own state slots exactly as a
 * fiber would, and state survives across `render` calls. Effects run once after
 * each render, mount-style. This is what lets the tests assert on the *rendered
 * output* rather than on the top-level element alone.
 */
export function createReact() {
  const slotsByPath = new Map()
  let path = 'root'
  let cursor = 0
  let pending = []
  let owner = ''

  /**
   * The slot key for the hook being read right now.
   *
   * React keys hook state to the component *instance* at its position, so two
   * different components that occupy the same position on different renders —
   * `UsageTab` and `SettingsTab` swap places when the settings tab is picked —
   * keep separate state. Keying by position alone made the second component
   * read the first one's slots, which silently handed `SettingsTab` a string
   * where it expected a config object.
   */
  const slotKey = () => `${path}::${owner}#${cursor++}`

  const api = {
    Fragment: Symbol('react.fragment'),
    createElement(type, props, ...children) {
      // React hands a component its children through `props.children`, so the
      // harness must too: without this a wrapper component receives none and
      // silently renders an empty body, which looks like a passing test.
      const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false && child !== true)
      return { type, props: { ...(props ?? {}), children: flat }, children: flat }
    },
    useState(initial) {
      const key = slotKey()
      if (!slotsByPath.has(key)) slotsByPath.set(key, typeof initial === 'function' ? initial() : initial)
      return [slotsByPath.get(key), (next) => {
        slotsByPath.set(key, typeof next === 'function' ? next(slotsByPath.get(key)) : next)
      }]
    },
    useCallback(fn) {
      cursor += 1
      return fn
    },
    useRef(initial) {
      const key = slotKey()
      if (!slotsByPath.has(key)) slotsByPath.set(key, { current: initial })
      return slotsByPath.get(key)
    },
    useEffect(fn) {
      cursor += 1
      pending.push(fn)
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      cursor += 1
      return getSnapshot()
    },
  }

  /** Expand one node, calling any function component it names. */
  function expand(node, nodePath) {
    if (node === null || node === undefined || typeof node === 'string' || typeof node === 'number') return node
    if (Array.isArray(node)) return node.map((child, index) => expand(child, `${nodePath}.${index}`))
    if (typeof node.type === 'function') {
      const previous = path
      const previousOwner = owner
      path = nodePath
      owner = node.type.name || 'anonymous'
      cursor = 0
      const rendered = node.type(node.props)
      path = previous
      owner = previousOwner
      return expand(rendered, nodePath)
    }
    return { ...node, children: node.children.map((child, index) => expand(child, `${nodePath}.${index}`)) }
  }

  return {
    api,
    render(Component, props) {
      pending = []
      const tree = expand(api.createElement(Component, props), 'root')
      const teardown = pending.map((fn) => fn()).filter((cleanup) => typeof cleanup === 'function')
      return { tree, teardown }
    },
    reset() {
      slotsByPath.clear()
      cursor = 0
      pending = []
    },
  }
}

//#endregion

//#region -------------------------------------------------------------- harness

/** Every string in a rendered tree, in document order. */
export function textOf(node) {
  if (node === null || node === undefined || typeof node === 'string') return node === undefined ? '' : String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  const own = node.children.map(textOf).join(' ')
  return own
}

/** Depth-first search of a rendered tree for the first node whose type matches. */
export function findByPart(node, part) {
  if (node === null || node === undefined || typeof node === 'string') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByPart(child, part)
      if (found !== null) return found
    }
    return null
  }
  if (node.props?.['data-dsh-part'] === part) return node
  for (const child of node.children) {
    const found = findByPart(child, part)
    if (found !== null) return found
  }
  return null
}

/** Every node carrying a `data-dsh-part`, in document order. */
export function findAllByPart(node, part, into = []) {
  if (node === null || node === undefined || typeof node === 'string') return into
  if (Array.isArray(node)) {
    for (const child of node) findAllByPart(child, part, into)
    return into
  }
  if (node.props?.['data-dsh-part'] === part) into.push(node)
  for (const child of node.children) findAllByPart(child, part, into)
  return into
}

/**
 * Let one macrotask pass, so an effect's already-resolved fetch promise has
 * landed in state before the next render reads it.
 */
export function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * The first element whose own text is exactly `label`.
 *
 * Tab buttons are found this way because they carry no test attribute — adding
 * one purely for tests would put test-only markup in the shipped bundle.
 */
export function findByText(node, label) {
  if (node === null || node === undefined || typeof node === 'string') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByText(child, label)
      if (found !== null) return found
    }
    return null
  }
  if (typeof node.type === 'string' && node.children.length > 0 && node.children.every((child) => typeof child === 'string')) {
    if (node.children.join('') === label) return node
  }
  for (const child of node.children) {
    const found = findByText(child, label)
    if (found !== null) return found
  }
  return null
}

/**
 * Load the shipped bundle into a fake page and hand back its module exports.
 *
 * The bundle is a plain script that registers itself with
 * `window.__ModuleLoader__`, so evaluating it in this module's scope with
 * `window`/`document`/`fetch`/`MutationObserver` stubbed is exactly how the
 * browser would run it — including the failure mode where it throws before it
 * ever registers.
 *
 * The page globals are left installed on purpose: the components read
 * `window.localStorage` and `document` at render time, long after the bundle
 * has been evaluated, so the page has to outlive the load.
 */
export function loadBundle(page, react, { fetch, path } = {}) {
  const captured = []
  const globals = {
    window: {
      __ModuleLoader__: { load: (definition) => captured.push(definition) },
      setTimeout: () => 1,
      clearTimeout: () => {},
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      innerWidth: 1280,
      innerHeight: 800,
      localStorage: { getItem: () => null, setItem: () => {} },
      navigator: { language: 'zh-CN' },
    },
    document: page.document,
    navigator: { language: 'zh-CN' },
    localStorage: { getItem: () => null, setItem: () => {} },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    fetch: fetch ?? (async () => ({ ok: true, status: 200, json: async () => ({}) })),
  }

  for (const [name, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
  }

  // eslint-disable-next-line no-new-func -- the point is to run the artifact as a script
  new Function('require', readFileSync(path ?? CLIENT_PATH, 'utf8'))(fakeRequire(react))

  assert.equal(captured.length, 1, 'the bundle must register exactly one module with the loader')
  return captured[0]
}

/**
 * `require` as the loader seeds it: `react`, `react-dom` and `react-dom/client`
 * only.
 *
 * The throw is load-bearing: it is the guard that keeps the client half from
 * importing a `@deepseek-ai/*` package, which would work in the harness's
 * module table and then fail in a deployment whose bundle graph differs.
 */
export function fakeRequire(react) {
  return (id) => {
    if (id === 'react') return react.api
    if (id === 'react-dom') {
      return {
        // The real portal moves the node to another container. The harness
        // keeps it in place so the panel is reachable from the rendered tree
        // by the same `data-dsh-part` lookup everything else uses.
        createPortal: (element) => element,
      }
    }
    if (id === 'react-dom/client') {
      return {
        createRoot: (container) => ({
          render: (element) => {
            container.rendered = element
          },
          unmount: () => {
            container.rendered = null
          },
        }),
      }
    }
    throw new Error(`unexpected require(${JSON.stringify(id)}) — the client half must not import DSH packages`)
  }
}

/** A fake client context recording what `apply` registers. */
export function createCtx() {
  const effects = []
  const injected = []
  const registered = []
  const ctx = {
    effect: (fn, label) => {
      effects.push({ label, dispose: fn() })
      return () => {}
    },
    slots: {
      inject: (name, callback) => {
        injected.push(name)
        const dispose = callback()
        return typeof dispose === 'function' ? dispose : () => {}
      },
      register: (options, Component) => {
        registered.push({ options, Component })
        return () => {}
      },
    },
  }
  return { ctx, effects, injected, registered }
}