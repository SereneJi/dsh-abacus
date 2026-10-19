/**
 * Browser-half tests for dsh-usage-stat.
 *
 * The client bundle cannot be exercised by the host's runner without a DOM, so
 * this file borrows the hand-rolled one in `test/harness.mjs`: enough element
 * and `querySelector` behaviour for the sidebar foot placement, and enough of
 * React's hook contract to call the components as plain functions.
 *
 * That is deliberate. The bug this file exists to prevent is a *wiring* bug: the
 * factory wrote to an `exports` it had never declared, so the browser threw
 * `exports is not defined` the moment it executed the bundle, the plugin never
 * applied, and every surface stayed empty while the host half looked perfectly
 * healthy. Nothing on the host side could have caught it. Loading the real
 * bundle into a fake page and running `apply` can.
 *
 * Run with: node --test test/
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CLIENT_PATH, createCtx, createPage, createReact, fakeRequire, findAllByPart, findByPart, findByText, loadBundle, textOf, tick } from './harness.mjs'

/** A day document in the shape the host's `/day` route returns. */
function dayDocument(overrides = {}) {
  const totals = {
    inputTokens: 1_000,
    outputTokens: 200,
    cacheReadTokens: 5_000,
    cacheWriteTokens: 100,
    calls: 3,
    ...(overrides.totals ?? {}),
  }
  return {
    date: overrides.date ?? '2026-10-18',
    totals,
    providers: overrides.providers ?? [
      { provider: 'opencode-go', displayName: 'OpenCode Go', totals: { ...totals, inputTokens: 900 }, models: [{ model: 'deepseek-v4.1-flash', totals: { ...totals, inputTokens: 900 } }] },
      { provider: 'anthropic', displayName: 'Anthropic', totals: { ...totals, inputTokens: 100 }, models: [{ model: 'claude-sonnet-4', totals: { ...totals, inputTokens: 100 } }] },
    ],
  }
}

/**
 * A session document in the shape the host's `/session` route returns: the
 * conversation's own totals plus its per-provider, per-model breakdown. Two
 * vendors on purpose, so the panel's rows and its proportional bar both have
 * something to disagree about.
 */
function sessionDocument(overrides = {}) {
  const totals = {
    inputTokens: 1_000,
    outputTokens: 2_000,
    cacheReadTokens: 126_400,
    cacheWriteTokens: 1_000,
    reasoningTokens: 0,
    calls: 3,
    ...(overrides.totals ?? {}),
  }
  return {
    sessionId: overrides.sessionId ?? 'session-1',
    totals,
    updatedAt: overrides.updatedAt ?? Date.parse('2026-10-18T01:56:00'),
    providers: overrides.providers ?? [
      {
        provider: 'opencode-go',
        displayName: 'OpenCode Go',
        totals: { ...totals, inputTokens: 900 },
        models: [{ model: 'deepseek-v4.1-flash', totals: { ...totals, inputTokens: 900 } }],
      },
      {
        provider: 'deepseek',
        displayName: 'DeepSeek Account',
        totals: { ...totals, inputTokens: 100 },
        models: [{ model: 'deepseek-chat', totals: { ...totals, inputTokens: 100 } }],
      },
    ],
  }
}

/** An overview document in the shape the host's `/overview` route returns. */
function overviewDocument(overrides = {}) {
  const day = overrides.today ?? dayDocument()
  return {
    updatedAt: new Date('2026-10-18T01:56:00').getTime(),
    version: overrides.version ?? '0.8.0',
    history: overrides.history ?? null,
    config: {
      enabled: true,
      pollIntervalSec: 60,
      probeEnabled: true,
      probeIntervalSec: 300,
      alertEnabled: true,
      alertBalanceBelow: 0,
      alertWindow5h: 0,
      alertWindowWeek: 0,
      alertWindowMonth: 0,
      ...(overrides.config ?? {}),
    },
    current: { provider: 'opencode-go', displayName: 'OpenCode Go', model: 'deepseek-v4.1-flash', ...(overrides.current ?? {}) },
    providers: overrides.providers ?? day.providers,
    alerts: overrides.alerts ?? [],
    // The rows a model gets when the user has not priced it. The price editor
    // names them so a reader can see what a row is overriding.
    builtinPrices: overrides.builtinPrices ?? {
      'deepseek-flash': { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 2 },
      'deepseek-v4-pro': { input: 9, output: 27, cacheRead: 0.3, cacheWrite: 9 },
    },
    // Range aggregates are not part of the overview: the settings page asks the
    // `/range` route for whatever window the user picked.
    usage: {
      today: day,
      availableDays: overrides.availableDays ?? ['2026-10-17', '2026-10-18'],
    },
  }
}

/** A range document in the shape the host's `/range` route returns. */
function rangeDocument(overrides = {}) {
  const day = dayDocument()
  return {
    from: overrides.from ?? '2026-10-12',
    to: overrides.to ?? '2026-10-18',
    totals: overrides.totals ?? day.totals,
    providers: overrides.providers ?? day.providers,
    days: overrides.days ?? [
      { date: '2026-10-17', totals: day.totals },
      { date: '2026-10-18', totals: day.totals },
    ],
  }
}


/**
 * A cost view in the shape the host puts inside `/range` and each of its hours.
 *
 * It carries one priced provider and one unpriced model on purpose: the two
 * cases the tab has to tell apart, because `¥0.00` and "we cannot price this"
 * mean opposite things and only one of them belongs in the total.
 */
function costDocument(overrides = {}) {
  return {
    currency: 'CNY',
    total: 1.5,
    tokens: 3_000_000,
    pricedTokens: 2_000_000,
    unpricedTokens: 1_000_000,
    unpricedCount: 1,
    unpriced: [{ model: 'gpt-5.6-luna', tokens: 1_000_000 }],
    providers: [
      {
        provider: 'opencode-go',
        cost: 1.5,
        tokens: 2_000_000,
        pricedTokens: 2_000_000,
        unpricedTokens: 0,
        models: [{ model: 'deepseek-v4.1-flash', cost: 1.5, tokens: 2_000_000, calls: 12, priced: true }],
      },
      {
        provider: 'deepseek',
        cost: 0,
        tokens: 1_000_000,
        pricedTokens: 0,
        unpricedTokens: 1_000_000,
        models: [{ model: 'gpt-5.6-luna', cost: 0, tokens: 1_000_000, calls: 3, priced: false }],
      },
    ],
    ...overrides,
  }
}

/**
 * A vendor-facts document in the shape the host's `/providers` route returns.
 *
 * Mirrors the two cases that matter on a real machine: a provider whose
 * credential resolved and whose endpoints answered, and providers that cannot
 * be queried at all. The third row is deliberately supported-but-uncredentialed
 * so the "why is my provider missing" line is exercised.
 */
function vendorFacts(overrides = {}) {
  return {
    updatedAt: overrides.updatedAt ?? Date.parse('2026-10-18T01:56:00'),
    probing: false,
    intervalSec: 300,
    providers: overrides.providers ?? [
      {
        provider: 'opencode-go',
        displayName: 'OpenCode Go',
        credential: 'api-key',
        credentialSource: 'OPENCODE_GO_API_KEY',
        balanceSupported: false,
        balanceError: 'unsupported',
        planSupported: true,
        plan: {
          planName: 'Pro',
          updatedAt: Date.parse('2026-10-18T01:56:00'),
          windows: [
            { key: '5h', percent: 11, resetsAt: '2026-10-18T20:17:33.000Z' },
            { key: 'week', percent: 41, resetsAt: '2026-10-19T00:00:00.000Z' },
          ],
        },
        updatedAt: Date.parse('2026-10-18T01:56:00'),
      },
      {
        provider: 'deepseek-official',
        displayName: 'DeepSeek Account',
        credential: 'api-key',
        credentialSource: 'DEEPSEEK_API_KEY',
        balanceSupported: true,
        balance: { currency: 'CNY', totalBalance: '12.34', updatedAt: Date.parse('2026-10-18T01:56:00') },
        planSupported: false,
        planError: 'unsupported',
        updatedAt: Date.parse('2026-10-18T01:56:00'),
      },
      {
        provider: 'openrouter',
        displayName: 'OpenRouter',
        credential: 'none',
        balanceSupported: true,
        balanceError: 'no-credential',
        planSupported: false,
        planError: 'unsupported',
      },
    ],
    catalog: { probeable: ['opencode-go', 'deepseek-official', 'openrouter', 'moonshotai'] },
    alerts: overrides.alerts ?? [],
  }
}

/**
 * A `fetch` that answers the plugin's routes and records every URL it saw.
 *
 * A route key matches either the whole URL or just its path, so a caller that
 * does not care about the query string does not have to hard-code today's date
 * into the stub. Anything unrouted resolves to an empty body, which is what the
 * real host would never do — so a missing stub shows up as a render assertion
 * failing, not as a silent pass.
 */
function routedFetch(routes = {}) {
  const seen = []
  const fetch = async (url, options) => {
    const target = String(url)
    seen.push(target)
    const path = target.split('?')[0]
    const body = routes[`${options?.method ?? 'GET'} ${target}`] ?? routes[`${options?.method ?? 'GET'} ${path}`] ?? routes[target] ?? routes[path]
    // A route may describe a failure: `{ ok: false, status: 401 }` makes the
    // response look exactly like the real one a missing route produces.
    const failed = body !== null && typeof body === 'object' && body.ok === false
    return {
      ok: !failed,
      status: failed ? (body.status ?? 500) : 200,
      json: async () => (failed ? (body.body ?? {}) : (body ?? {})),
    }
  }
  return { fetch, seen }
}

//#endregion

//#region --------------------------------------------------------------- wiring

test('the bundle executes and exports apply, inject and name', () => {
  const page = createPage()
  const definition = loadBundle(page, createReact())

  assert.equal(definition.id, 'dsh-usage-stat', 'the module id must equal the package name')
  assert.equal(typeof definition.factory, 'function')

  const module = definition.factory(fakeRequire(createReact()))
  assert.equal(module.name, 'dsh-usage-stat')
  assert.deepEqual(module.inject, ['slots'])
  assert.equal(typeof module.apply, 'function')
  assert.equal(typeof module.__internals.FootCard, 'function')
})

test('apply registers both slots and mounts the foot card without throwing', () => {
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react).factory(fakeRequire(react))
  const { ctx, effects, injected, registered } = createCtx()

  module.apply(ctx)

  assert.deepEqual(injected, ['conversation.composer.dock', 'settings.section'])
  assert.deepEqual(
    registered.map((entry) => [entry.options.name, entry.options.id]),
    [['conversation.composer.dock', 'usage-stat-session'], ['settings.section', 'usage-stat']],
  )
  assert.equal(registered[0].Component, module.__internals.SessionBadge)
  assert.equal(registered[1].Component, module.__internals.UsageSection)
  assert.deepEqual(effects.map((entry) => entry.label), [
    'dsh-usage-stat: overview poll',
    'dsh-usage-stat: sidebar foot card',
  ])

  // The stylesheet is injected once, into <head>.
  assert.equal(page.head.children.filter((node) => node.id === 'dsh-usage-stat-styles').length, 1)
})

test('the foot card is seated immediately before the Settings row', () => {
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react).factory(fakeRequire(react))
  const { ctx } = createCtx()

  module.apply(ctx)

  const card = page.footArea.children.find((node) => node.getAttribute('data-dsh-usage-stat-foot') !== null)
  assert.ok(card !== undefined, 'the card container must be mounted into the foot area')
  assert.equal(card.nextElementSibling, page.settingsArea, 'the card must sit directly above Settings')
  assert.ok(card.rendered !== null && card.rendered !== undefined, 'the container must have a React root rendering the card')
})

test('applying twice does not mount a second card', () => {
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react).factory(fakeRequire(react))

  module.apply(createCtx().ctx)
  module.apply(createCtx().ctx)

  const cards = page.footArea.children.filter((node) => node.getAttribute('data-dsh-usage-stat-foot') !== null)
  assert.equal(cards.length, 1, 'the DOM-level guard must keep the card idempotent')
})

test('the overview poll fetches a document-relative URL and fills the store', async () => {
  const page = createPage()
  const react = createReact()
  const seen = []
  const module = loadBundle(page, react, {
    fetch: async (url) => {
      seen.push(String(url))
      return { ok: true, status: 200, json: async () => ({ overview: overviewDocument() }) }
    },
  }).factory(fakeRequire(react))

  const store = module.__internals.createOverviewStore()
  const dispose = module.__internals.startPolling(store, () => {})
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(seen, ['api/usage-stat/overview'], 'the URL must stay document-relative (the GUI sets <base href="./">)')
  assert.equal(store.getSnapshot().status, 'ready')
  assert.equal(store.getSnapshot().overview.current.provider, 'opencode-go')
  dispose()
})

test('a failed poll keeps the last overview and records the error', async () => {
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react, {
    fetch: async () => {
      throw new Error('offline')
    },
  }).factory(fakeRequire(react))

  const store = module.__internals.createOverviewStore()
  store.set({ status: 'ready', overview: overviewDocument(), error: null })
  const dispose = module.__internals.startPolling(store, () => {})
  await new Promise((resolve) => setImmediate(resolve))

  const snapshot = store.getSnapshot()
  assert.equal(snapshot.status, 'error')
  assert.equal(snapshot.error, 'offline')
  assert.notEqual(snapshot.overview, null, 'a transient failure must not blank the card')
  dispose()
})

//#endregion

//#region ----------------------------------------------------------- components

test('FootCard renders the collapsed summary and expands to per-provider detail', () => {
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react).factory(fakeRequire(react))
  const { FootCard } = module.__internals

  const store = module.__internals.createOverviewStore()
  store.set({ status: 'ready', overview: overviewDocument(), error: null })

  const collapsed = react.render(FootCard, { store })
  const collapsedText = textOf(collapsed.tree)
  assert.match(collapsedText, /今日用量/)
  assert.match(collapsedText, /tokens/)
  // The rail is one number and nothing else: the call count is detail, so it
  // lives in the expanded body (and in the button's tooltip for a hover).
  assert.doesNotMatch(collapsedText, /3 次/)
  assert.match(findByPart(collapsed.tree, 'foot-card-main').props.title, /3 次/)
  assert.equal(findByPart(collapsed.tree, 'foot-card-main').props['aria-expanded'], false)
  // The card carries no settings entry at all: an earlier corner icon sat where
  // the sidebar's account row sits and opened the settings panel, which read as
  // a second account button. The card is a readout, not a door.
  assert.equal(findByPart(collapsed.tree, 'foot-card-open'), null)

  // Expanding is a state change inside the card, so flip the persisted flag
  // the card reads on mount and render a fresh instance.
  globalThis.window.localStorage = { getItem: () => '1', setItem: () => {} }
  react.reset()
  const expanded = react.render(FootCard, { store })

  const expandedText = textOf(expanded.tree)
  assert.match(expandedText, /OpenCode Go/, 'the expanded card lists providers')
  assert.match(expandedText, /deepseek-v4\.1-flash/, 'the expanded card lists models')
  assert.match(expandedText, /Anthropic/)
  assert.match(expandedText, /3 次/, 'the expanded card reports the call count')
  assert.match(expandedText, /更新于/)
  assert.equal(findByPart(expanded.tree, 'foot-card-main').props['aria-expanded'], true)
  // Even open, the card offers no route into settings.
  assert.equal(findByPart(expanded.tree, 'foot-card-open'), null)
  assert.doesNotMatch(expandedText, /在设置中查看明细/)
})

test('FootCard bows out when the plugin is disabled and when the host is missing', () => {
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react).factory(fakeRequire(react))
  const { FootCard, createOverviewStore } = module.__internals

  const disabled = createOverviewStore()
  disabled.set({ status: 'ready', overview: overviewDocument({ config: { enabled: false } }), error: null })
  assert.equal(react.render(FootCard, { store: disabled }).tree, null)

  const offline = createOverviewStore()
  offline.set({ status: 'error', overview: null, error: 'overview 404' })
  assert.match(textOf(react.render(FootCard, { store: offline }).tree), /统计服务未启用/)
})

test('the sidebar card sits flat until hovered and puts its figure on the right', () => {
  // Two declarations the card's placement rests on, and both were once wrong: a
  // tinted background at rest reads as a seam against the sidebar surface, and a
  // chevron pushed to the right edge strands the figure in the middle of the row.
  // The fake DOM cannot compute layout, so the stylesheet itself is the contract.
  const css = readFileSync(CLIENT_PATH, 'utf8')

  assert.match(css, /\.dus-foot\{[^}]*background:transparent/, 'the card has no fill of its own')
  assert.match(css, /\.dus-foot:hover\{background:var\(--dsw-alias-interactive-bg-hover/, 'hover supplies the fill')
  assert.match(css, /\.dus-foot-value\{[^}]*margin-left:auto/, 'the figure takes the right edge')
  assert.doesNotMatch(css, /\.dus-foot-chevron\{[^}]*margin-left:auto/, 'the chevron trails the figure instead of the row')
})

test('the settings header outranks the cards under it', () => {
  // The heading is what makes the panel read as one of the settings dialog's
  // pages instead of a bare stack of cards. It borrows that dialog's own
  // heading shape (a title over a dimmed line of metadata on the primary label
  // colour) but sits one step heavier than the dialog's 16px/500 page title:
  // the cards under it title themselves at 14px/500, and a heading that close
  // to its own card titles reads as one more card title. Again the stylesheet
  // is the contract, because the fake DOM cannot lay out.
  const css = readFileSync(CLIENT_PATH, 'utf8')

  assert.match(css, /\.dus-head-title\{font-size:18px;font-weight:600;line-height:26px/, 'the title outranks the card titles below it')
  assert.match(css, /\.dus-head-title\{[^}]*color:var\(--dsw-alias-label-primary/, 'the title takes the primary label colour')
  assert.match(css, /\.dus-head-sub\{font-size:11px/, 'the freshness line stays subordinate')
  assert.doesNotMatch(css, /\.dus-head-title\{[^}]*font-size:14px/, 'the title is never down at the card-title size')
})

test('the plan windows of one provider share one set of columns', () => {
  // A row-per-window flex box cannot align a column whose content differs per
  // row (the reset stamps are "18:21" on one window and "10-19 08:00" on the
  // next), which is exactly what made the 5-hour bar start further right than
  // the two under it. One grid per provider, with the last column sized once
  // for the whole container, is what puts every bar on the same left edge.
  const css = readFileSync(CLIENT_PATH, 'utf8')

  assert.match(css, /\.dus-windows\{display:grid;grid-template-columns:60px minmax\(0,1fr\) 40px auto/, 'the windows share one grid')
  assert.match(css, /\.dus-window\{display:contents/, 'a window is only a grid item, not its own box')
  assert.doesNotMatch(css, /\.dus-window\{display:flex/, 'the per-row flex box is gone')
})

test('the sidebar card groups each provider with its own bar', () => {
  // The expanded card used to put a 34px share stub in front of the provider
  // name, which read as a stray dash. Each provider is now a block: its line,
  // a full-width bar under it, and its models indented behind a rail.
  const css = readFileSync(CLIENT_PATH, 'utf8')

  assert.match(css, /\.dus-foot-provider\{display:flex;flex-direction:column/, 'a provider is a block')
  assert.match(css, /\.dus-share\{display:block;height:3px/, 'the share bar spans the block')
  assert.match(css, /\.dus-foot-models\{[^}]*border-left/, 'the models hang off a rail under their provider')
  assert.doesNotMatch(css, /\.dus-bar\{/, 'the inline share stub is gone')
})

test('the picked range stays readable without a skin', () => {
  // The picked range is the one filled control on the usage tab. Its label used
  // to take --dsw-alias-brand-text, which is the brand colour *as ink* — the
  // same near-black the fill is on a stock theme, so the label disappeared and
  // only a skin that remaps the brand colour hid it. The on-brand foreground
  // token is the one that means "text on a brand fill".
  const css = readFileSync(CLIENT_PATH, 'utf8')

  assert.match(css, /\.dus-range\[aria-pressed="true"\]\{[^}]*color:var\(--dsw-alias-label-primary-foreground/, 'the label uses the on-brand foreground')
  assert.doesNotMatch(css, /\.dus-range\[aria-pressed="true"\]\{[^}]*color:var\(--dsw-alias-brand-text/, 'the label is not painted in the fill colour')
})

test('the settings form keeps the shell dialog metrics', () => {
  // The form was rebuilt on the settings dialog's own numbers: cards at
  // radius-xl with 12px 16px padding, rows at least 40px tall, 32px inputs and
  // buttons on the l4 stroke, and a filled primary button for the one action.
  // Drifting from these is what made the old form read as a foreign panel, so
  // they are pinned here; the fake DOM cannot measure any of it.
  const css = readFileSync(CLIENT_PATH, 'utf8')

  assert.match(css, /\.dus-panel\{[^}]*padding:12px 16px/, 'the panel takes the dialog card padding')
  assert.match(css, /\.dus-panel\{[^}]*border-radius:var\(--dsw-radius-xl/, 'the panel takes the dialog card radius')
  assert.match(css, /\.dus-form-row\{[^}]*min-height:40px/, 'a form row matches the dialog row height')
  assert.match(css, /\.dus-input\{[^}]*height:32px/, 'the input matches the dialog input height')
  assert.match(css, /\.dus-input\{[^}]*border:\.5px solid var\(--dsw-alias-border-l4/, 'the input takes the dialog stroke')
  assert.match(css, /\.dus-button\{[^}]*height:32px/, 'the button matches the dialog button height')
  assert.match(css, /\.dus-button-primary\{[^}]*background:var\(--dsw-alias-button-primary-fill/, 'the save action is the filled primary button')
  assert.doesNotMatch(css, /\.dus-(group|hint)\{/, 'the replaced group and hint rules are gone')
})

test('the summary strip spreads its figures and the model rows share a column', () => {
  // Two alignment contracts the fake DOM cannot measure. The six figures used
  // to huddle against the left edge with a 22px gap, leaving half the card
  // empty; each now owns an equal column with a hairline between. And a model
  // row used to size its own name column, so every bar started on a different x
  // depending on how long the model name was — a fixed leading column is what
  // makes them line up.
  const css = readFileSync(CLIENT_PATH, 'utf8')

  assert.match(css, /\.dus-metric\{[^}]*flex:1 1 0/, 'every figure grows to an equal share')
  assert.match(css, /\.dus-metric \+ \.dus-metric\{[^}]*border-left/, 'a hairline separates the figures')
  assert.match(css, /\.dus-metrics\{[^}]*border-top/, 'the strip is ruled off from the range above it')
  assert.match(css, /\.dus-model\{display:grid;grid-template-columns:var\(--dus-model-name,132px\)/, 'the model name column is fixed')
  assert.doesNotMatch(css, /\.dus-model\{display:flex/, 'the per-row flex column that misaligned the bars is gone')
  assert.match(css, /\.dus-chart\{[^}]*border-bottom/, 'the chart sits on a baseline')
})

test('SessionBadge shows the conversation total and hides itself at zero', () => {
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react).factory(fakeRequire(react))
  const { SessionBadge } = module.__internals

  const empty = react.render(SessionBadge, { useProjection: () => ({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }) })
  assert.equal(empty.tree, null, 'a conversation with no usage must render nothing')

  const missing = react.render(SessionBadge, { useProjection: () => undefined })
  assert.equal(missing.tree, null, 'a slot without the projection must not crash the composer')

  // Billed input is uncached + cache read + cache write, plus output — the same
  // sum the shell's own usage row uses.
  const usage = { uncachedInputTokens: 1_000, cacheReadTokens: 126_400, cacheWriteTokens: 1_000, outputTokens: 2_000 }
  const shown = react.render(SessionBadge, { useProjection: () => usage })
  const text = textOf(shown.tree)
  assert.match(text, /本次对话/)
  assert.match(text, /130\.4K tokens/)
  assert.equal(shown.tree.props['data-dsh-part'], 'session-pill')
  // No `sessionId` in the props: the pill still renders, but it is not
  // interactive, because there is no conversation to ask the host about.
  assert.equal(shown.tree.props.disabled, true)
})

test('the composer pill opens this chat’s per-vendor breakdown, not a tooltip', async () => {
  const page = createPage()
  const react = createReact()
  const { fetch, seen } = routedFetch({
    'api/usage-stat/session': { ok: true, session: sessionDocument() },
  })
  const module = loadBundle(page, react, { fetch }).factory(fakeRequire(react))
  const { SessionBadge } = module.__internals

  const usage = { uncachedInputTokens: 1_000, cacheReadTokens: 126_400, cacheWriteTokens: 1_000, outputTokens: 2_000 }
  const props = { useProjection: () => usage, sessionId: 'session-1' }

  const closed = react.render(SessionBadge, props)
  const trigger = findByPart(closed.tree, 'session-pill')
  assert.equal(trigger.type, 'button', 'the pill is a real button so it is keyboard reachable')
  assert.equal(trigger.props.title, undefined, 'the hover tooltip is gone — the panel replaced it')
  assert.equal(trigger.props['aria-expanded'], false)
  assert.equal(trigger.props['aria-haspopup'], 'dialog')
  assert.equal(findByPart(closed.tree, 'session-panel'), null, 'a closed pill renders no panel')

  // The harness's setState only writes the hook slot, so the click has to be
  // followed by a second render for the open state to be observed.
  trigger.props.onClick()
  react.render(SessionBadge, props)
  await tick()
  const opened = react.render(SessionBadge, props)

  assert.equal(seen[0], 'api/usage-stat/session?id=session-1')
  assert.equal(findByPart(opened.tree, 'session-pill').props['aria-expanded'], true)
  const panel = findByPart(opened.tree, 'session-panel')
  assert.notEqual(panel, null, 'the open pill renders its panel')
  assert.equal(panel.props.role, 'dialog')

  const text = textOf(panel)
  assert.match(text, /本次对话/)
  assert.match(text, /130\.4K tokens/)
  assert.match(text, /OpenCode Go/)
  assert.match(text, /deepseek-v4\.1-flash/)
  assert.match(text, /DeepSeek Account/)
  assert.match(text, /deepseek-chat/)
  // Two vendors, two bar segments, and the rows carry the same two numbers the
  // bar is proportioned by.
  assert.equal(findAllByPart(panel, 'session-segment').length, 2)
  const swatches = findAllByPart(panel, 'session-swatch')
  assert.equal(swatches.length, 2)
  assert.match(swatches[0].props.className, /dus-tint-0/)
  assert.match(swatches[1].props.className, /dus-tint-1/)
})

test('a session with no recorded breakdown says so instead of inventing one', async () => {
  const page = createPage()
  const react = createReact()
  // A conversation folded before the per-vendor breakdown existed has totals
  // and nothing else. It must not be silently presented as unattributed.
  const { fetch } = routedFetch({
    'api/usage-stat/session': { ok: true, session: sessionDocument({ providers: [] }) },
  })
  const module = loadBundle(page, react, { fetch }).factory(fakeRequire(react))
  const { SessionBadge } = module.__internals

  const usage = { uncachedInputTokens: 1_000, cacheReadTokens: 126_400, cacheWriteTokens: 1_000, outputTokens: 2_000 }
  const props = { useProjection: () => usage, sessionId: 'session-1' }
  findByPart(react.render(SessionBadge, props).tree, 'session-pill').props.onClick()
  react.render(SessionBadge, props)
  await tick()
  const opened = react.render(SessionBadge, props)

  const text = textOf(findByPart(opened.tree, 'session-panel'))
  assert.match(text, /只有总量记录/)
  assert.equal(findAllByPart(opened.tree, 'session-segment').length, 0)
})

test('a session route that fails leaves the pill working and explains itself', async () => {
  const page = createPage()
  const react = createReact()
  const { fetch } = routedFetch({ 'api/usage-stat/session': { ok: false, status: 503 } })
  const module = loadBundle(page, react, { fetch }).factory(fakeRequire(react))
  const { SessionBadge } = module.__internals

  const usage = { uncachedInputTokens: 1_000, cacheReadTokens: 126_400, cacheWriteTokens: 1_000, outputTokens: 2_000 }
  const props = { useProjection: () => usage, sessionId: 'session-1' }
  findByPart(react.render(SessionBadge, props).tree, 'session-pill').props.onClick()
  react.render(SessionBadge, props)
  await tick()
  const opened = react.render(SessionBadge, props)

  const text = textOf(findByPart(opened.tree, 'session-panel'))
  assert.match(text, /session 503/)
  // The pill's own number comes from the projection, so it is unaffected.
  assert.match(textOf(findByPart(opened.tree, 'session-pill')), /130\.4K tokens/)
})

test('a 200 with the wrong shape is an error, not an empty panel', async () => {
  const page = createPage()
  const react = createReact()
  // `session` is a string where a document belongs: `field()` must reject it,
  // because otherwise the panel would render `undefined` and throw far from
  // the fetch that produced it.
  const { fetch } = routedFetch({ 'api/usage-stat/session': { ok: true, session: 'nope' } })
  const module = loadBundle(page, react, { fetch }).factory(fakeRequire(react))
  const { SessionBadge } = module.__internals

  const usage = { uncachedInputTokens: 1_000, cacheReadTokens: 126_400, cacheWriteTokens: 1_000, outputTokens: 2_000 }
  const props = { useProjection: () => usage, sessionId: 'session-1' }
  findByPart(react.render(SessionBadge, props).tree, 'session-pill').props.onClick()
  react.render(SessionBadge, props)
  await tick()
  const opened = react.render(SessionBadge, props)

  assert.match(textOf(findByPart(opened.tree, 'session-panel')), /session: unexpected response/)
})

test('a partly-shaped session answer still shows the pill’s own number', async () => {
  const page = createPage()
  const react = createReact()
  // An object, so `field()` passes it, but with no totals and no breakdown.
  const { fetch } = routedFetch({ 'api/usage-stat/session': { ok: true, session: { nothing: 'here' } } })
  const module = loadBundle(page, react, { fetch }).factory(fakeRequire(react))
  const { SessionBadge } = module.__internals

  const usage = { uncachedInputTokens: 1_000, cacheReadTokens: 126_400, cacheWriteTokens: 1_000, outputTokens: 2_000 }
  const props = { useProjection: () => usage, sessionId: 'session-1' }
  findByPart(react.render(SessionBadge, props).tree, 'session-pill').props.onClick()
  react.render(SessionBadge, props)
  await tick()
  const opened = react.render(SessionBadge, props)

  const text = textOf(findByPart(opened.tree, 'session-panel'))
  // The head must not fall back to `0 tokens` and contradict the pill.
  assert.match(text, /130\.4K tokens/)
  assert.match(text, /只有总量记录/)
})

test('UsageSection renders the loading note until an overview arrives', () => {
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react).factory(fakeRequire(react))
  const { UsageSection, createOverviewStore } = module.__internals

  const store = createOverviewStore()
  const pending = react.render(UsageSection, { store })
  assert.match(textOf(pending.tree), /正在加载用量数据/)

  store.set({ status: 'error', overview: null, error: 'day 500' })
  const failed = react.render(UsageSection, { store })
  assert.match(textOf(failed.tree), /加载失败：day 500/)
})

test('UsageSection offers the three tabs and no token-bank placeholder', () => {
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react).factory(fakeRequire(react))
  const { UsageSection, createOverviewStore } = module.__internals

  const store = createOverviewStore()
  store.set({ status: 'ready', overview: overviewDocument(), error: null })

  const { tree } = react.render(UsageSection, { store })
  const text = textOf(tree)
  // Usage, the two vendor readings merged into one tab, and the plugin's own
  // knobs as a tab of their own.
  for (const label of ['用量', '账户', '设置']) assert.match(text, new RegExp(label))
  assert.doesNotMatch(text, /余额|个人套餐/, 'the two vendor tabs are merged, not both listed')
  assert.doesNotMatch(text, /Token 银行/, 'the token bank was dropped')
  assert.doesNotMatch(text, /第二阶段/)

  // The header is a title lockup: the page's own name over how fresh the
  // numbers are. It must never fall back to naming the last billed route --
  // that was never what a page title promises.
  assert.match(text, /用量统计/)
  assert.match(text, /更新于/)
  assert.doesNotMatch(text, /OpenCode Go · deepseek-v4\.1-flash/)
})

test('the account tab fetches vendor facts on open and renders readings', async () => {
  const page = createPage()
  const react = createReact()
  const { fetch, seen } = routedFetch({ 'api/usage-stat/providers': { ok: true, providers: vendorFacts() } })
  const module = loadBundle(page, react, { fetch }).factory(fakeRequire(react))
  const { UsageSection, createOverviewStore } = module.__internals

  const store = createOverviewStore()
  store.set({ status: 'ready', overview: overviewDocument(), error: null })

  const props = { store }
  // Switching tabs is a state change, so the fake runtime needs another render
  // to observe it, and one more for the facts the effect then fetches. The tab
  // button is found by its label rather than by a test-only attribute.
  findByText(react.render(UsageSection, props).tree, '账户').props.onClick()
  await tick()
  react.render(UsageSection, props)
  await tick()
  const { tree } = react.render(UsageSection, props)
  const text = textOf(tree)

  assert.ok(seen.includes('api/usage-stat/providers'), `the facts route was read: ${seen.join(', ')}`)
  assert.match(text, /余额与套餐/)
  assert.match(text, /OpenCode Go/)
  assert.match(text, /¥12\.34/, 'a fetched balance is shown with its currency symbol')
  assert.match(text, /5 小时/, 'the same provider block carries its plan windows')
  // A provider with no reading at all is folded away rather than listed as an
  // error next to the ones that worked.
  assert.match(text, /无法查询的供应商/)
  assert.match(text, /未配置 API Key/, 'the folded row still says why')
  assert.notEqual(findByPart(tree, 'account-card'), null)
  assert.notEqual(findByPart(tree, 'unavailable-row'), null)
  assert.doesNotMatch(text, /Token 银行/)
})

test('the account tab names a few unconfigured providers instead of all of them', async () => {
  // The supported-provider table is long. A hint that spells out every name is
  // no longer a hint, so the tail is counted instead of listed.
  const page = createPage()
  const react = createReact()
  const facts = vendorFacts()
  facts.catalog = {
    probeable: [
      'moonshotai', 'moonshotai-cn', 'siliconflow', 'siliconflow-cn', 'siliconflow-intl',
      'zai', 'zai-coding', 'zai-coding-cn', 'zenmux',
    ],
  }
  const { fetch } = routedFetch({ 'api/usage-stat/providers': { ok: true, providers: facts } })
  const module = loadBundle(page, react, { fetch }).factory(fakeRequire(react))
  const { UsageSection, createOverviewStore } = module.__internals

  const store = createOverviewStore()
  store.set({ status: 'ready', overview: overviewDocument(), error: null })

  const props = { store }
  findByText(react.render(UsageSection, props).tree, '账户').props.onClick()
  await tick()
  react.render(UsageSection, props)
  await tick()
  const text = textOf(react.render(UsageSection, props).tree)

  assert.match(text, /配置 API Key 后还可查询：moonshotai、moonshotai-cn、siliconflow、siliconflow-cn、siliconflow-intl、zai/)
  assert.match(text, /等 3 项/, 'the rest are counted rather than spelled out')
  assert.doesNotMatch(text, /zenmux/, 'the tail of the catalog stays out of the line')
})

test('the account tab renders each plan window with its share and reset time', async () => {
  const page = createPage()
  const react = createReact()
  const { fetch } = routedFetch({ 'api/usage-stat/providers': { ok: true, providers: vendorFacts() } })
  const module = loadBundle(page, react, { fetch }).factory(fakeRequire(react))
  const { UsageSection, createOverviewStore } = module.__internals

  const store = createOverviewStore()
  store.set({ status: 'ready', overview: overviewDocument(), error: null })

  const props = { store }
  findByText(react.render(UsageSection, props).tree, '账户').props.onClick()
  await tick()
  react.render(UsageSection, props)
  await tick()
  const { tree } = react.render(UsageSection, props)
  const text = textOf(tree)

  assert.match(text, /余额与套餐/)
  assert.match(text, /5 小时/)
  assert.match(text, /本周/)
  assert.match(text, /11%/)
  assert.match(text, /41%/)
  assert.match(text, /重置/)
  assert.match(text, /Pro/)
  // Two windows means two bars, and each bar's width is the spent share.
  const windows = findAllByPart(tree, 'plan-window')
  assert.equal(windows.length, 2)
  assert.equal(windows[0].children[1].children[0].props.style.width, '11%')
})

test('a probe failure keeps the last good fact and reports the error', async () => {
  const page = createPage()
  const react = createReact()
  const stale = vendorFacts()
  stale.providers[0].balance = undefined
  stale.providers[0].balanceError = '查询失败：HTTP 503: upstream busy'
  const { fetch } = routedFetch({ 'api/usage-stat/providers': { ok: true, providers: stale } })
  const module = loadBundle(page, react, { fetch }).factory(fakeRequire(react))
  const { AccountTab } = module.__internals

  const { tree } = react.render(AccountTab, { facts: stale, probing: false, error: null, onProbe: () => {} })
  const text = textOf(tree)
  // The provider is still listed because its plan came through, and the half
  // that failed says so where its number would have been.
  assert.match(text, /查询失败：HTTP 503: upstream busy/, 'a vendor message is shown verbatim')
  assert.match(text, /OpenCode Go/)
  assert.match(text, /5 小时/)
})

test('a vendor tab survives a host that does not serve the facts route', async () => {
  // The realistic mismatch: the browser half is hot-swapped while the host half
  // still needs its restart, so `/providers` is not there yet and answers 401.
  const page = createPage()
  const react = createReact()
  const { fetch } = routedFetch({ 'api/usage-stat/providers': { ok: false, status: 401, body: {} } })
  const module = loadBundle(page, react, { fetch }).factory(fakeRequire(react))
  const { UsageSection, createOverviewStore } = module.__internals

  const store = createOverviewStore()
  store.set({ status: 'ready', overview: overviewDocument(), error: null })

  const props = { store }
  findByText(react.render(UsageSection, props).tree, '账户').props.onClick()
  await tick()
  react.render(UsageSection, props)
  await tick()
  const { tree } = react.render(UsageSection, props)
  const text = textOf(tree)

  assert.match(text, /余额与套餐/, 'the tab still renders its header')
  assert.match(text, /载入中|加载/, 'it shows a loading state rather than an empty page')
  assert.doesNotMatch(text, /¥/, 'no balance is invented when the facts never arrived')
})

test('a 200 with the wrong shape is an error, not an undefined document', async () => {
  // A route that answers 200 with a body missing its envelope used to resolve
  // `undefined` into component state, which then crashed a component far away
  // from the request. It must surface as an error on the tab instead.
  const page = createPage()
  const react = createReact()
  const { fetch } = routedFetch({ 'api/usage-stat/providers': { nothing: 'here' } })
  const module = loadBundle(page, react, { fetch }).factory(fakeRequire(react))
  const { UsageSection, createOverviewStore } = module.__internals

  const store = createOverviewStore()
  store.set({ status: 'ready', overview: overviewDocument(), error: null })

  const props = { store }
  findByText(react.render(UsageSection, props).tree, '账户').props.onClick()
  await tick()
  react.render(UsageSection, props)
  await tick()
  const { tree } = react.render(UsageSection, props)
  const text = textOf(tree)

  assert.match(text, /providers: unexpected response/, 'the failure is named where it happened')
  assert.match(text, /余额与套餐/, 'the tab is still usable')
})

test('the usage tab no longer carries the settings card', async () => {
  // Settings moved to a tab of their own, so the readings tab must not hold a
  // form that a save would re-render.
  const page = createPage()
  const react = createReact()
  const { fetch } = routedFetch({ 'api/usage-stat/range': { ok: true, range: rangeDocument() } })
  const module = loadBundle(page, react, { fetch }).factory(fakeRequire(react))
  const { UsageTab } = module.__internals

  const props = { overview: overviewDocument() }
  react.render(UsageTab, props)
  await tick()
  const { tree } = react.render(UsageTab, props)
  const text = textOf(tree)

  assert.match(text, /用量概览/)
  assert.doesNotMatch(text, /启用插件/)
  assert.doesNotMatch(text, /更新间隔/)
  assert.doesNotMatch(text, /余量提醒/)
})

test('the settings tab owns every knob and drops the ledger bounds', async () => {
  const page = createPage()
  const react = createReact()
  const { fetch } = routedFetch({ 'api/usage-stat/config': { ok: true, config: overviewDocument().config } })
  const module = loadBundle(page, react, { fetch }).factory(fakeRequire(react))
  const { SettingsTab } = module.__internals

  const props = { overview: overviewDocument(), onConfigSaved: () => {} }
  react.render(SettingsTab, props)
  await tick()
  const { tree } = react.render(SettingsTab, props)
  const text = textOf(tree)

  assert.match(text, /启用插件/)
  assert.match(text, /更新间隔/)
  assert.match(text, /查询间隔/)
  // The unit lives in a mark after the box, not inside the label, so every
  // numeric row lines up on one right edge.
  assert.doesNotMatch(text, /（秒）/)
  assert.match(text, /余量提醒/)
  // Retention and the size cap are gone: both only ever threw history away.
  assert.doesNotMatch(text, /历史保留天数/)
  assert.doesNotMatch(text, /账本上限|当前占用/)
  // The hint speaks to the user, not to whoever reads the source.
  assert.doesNotMatch(text, /config\.json/)
  assert.equal(findAllByPart(tree, 'setting-input').length, 2)
})

test('the settings tab carries the version and the state of the history scan', async () => {
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react, {}).factory(fakeRequire(react))
  const { SettingsTab } = module.__internals

  const fresh = { overview: overviewDocument(), onConfigSaved: () => {} }
  react.render(SettingsTab, fresh)
  await tick()
  const { tree } = react.render(SettingsTab, fresh)
  assert.match(textOf(tree), /v0\.8\.0/, 'the plugin says which version is running')
  assert.match(textOf(tree), /尚未补录/, 'and whether the past has been read yet')

  // A second instance with a bookmark: the row reports what the scan found.
  react.reset()
  const scanned = {
    overview: overviewDocument({ history: { atMs: Date.parse('2026-10-18T01:30:00'), files: 3, events: 412 } }),
    onConfigSaved: () => {},
  }
  react.render(SettingsTab, scanned)
  await tick()
  const { tree: after } = react.render(SettingsTab, scanned)
  assert.match(textOf(after), /已补录 3 个会话/)
})

test('the history row runs a scan on demand and reports the tally', async () => {
  const page = createPage()
  const react = createReact()
  const { fetch, seen } = routedFetch({
    'POST api/usage-stat/backfill': { ok: true, backfill: { files: 7, events: 900, skipped: false } },
  })
  const module = loadBundle(page, react, { fetch }).factory(fakeRequire(react))
  const { SettingsTab } = module.__internals

  const props = { overview: overviewDocument(), onConfigSaved: () => {} }
  react.render(SettingsTab, props)
  await tick()
  const { tree } = react.render(SettingsTab, props)

  const button = findByPart(tree, 'backfill-button')
  assert.notEqual(button, null, 'the row offers a re-scan')
  button.props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(seen[0], 'api/usage-stat/backfill')
  const { tree: after } = react.render(SettingsTab, props)
  assert.match(textOf(after), /已补录 7 个会话/)
  assert.notEqual(findByPart(after, 'history-state'), null)
})

test('the history row reports a failed scan instead of a tally', async () => {
  const page = createPage()
  const react = createReact()
  const { fetch } = routedFetch({ 'POST api/usage-stat/backfill': { ok: false, status: 500 } })
  const module = loadBundle(page, react, { fetch }).factory(fakeRequire(react))
  const { SettingsTab } = module.__internals

  const props = { overview: overviewDocument(), onConfigSaved: () => {} }
  react.render(SettingsTab, props)
  await tick()
  const { tree } = react.render(SettingsTab, props)
  findByPart(tree, 'backfill-button').props.onClick()
  await new Promise((resolve) => setTimeout(resolve, 0))

  const { tree: after } = react.render(SettingsTab, props)
  assert.match(textOf(after), /backfill 500/)
  assert.doesNotMatch(textOf(after), /已补录/)
})

test('the account tab tells the user where a missing key goes', async () => {
  const page = createPage()
  const react = createReact()
  const { fetch } = routedFetch({ 'api/usage-stat/providers': { ok: true, providers: vendorFacts() } })
  const module = loadBundle(page, react, { fetch }).factory(fakeRequire(react))
  const { AccountTab } = module.__internals

  const props = { facts: vendorFacts(), error: null }
  react.render(AccountTab, props)
  await tick()
  const { tree } = react.render(AccountTab, props)

  // One row reports a missing credential, so the page says where to put it.
  const note = findByPart(tree, 'account-howto')
  assert.notEqual(note, null)
  assert.match(textOf(note), /设置 → 模型/)
  assert.match(textOf(note), /API Key/)
})

test('the account tab stays quiet when nothing is missing a key', async () => {
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react, {}).factory(fakeRequire(react))
  const { AccountTab } = module.__internals

  const facts = vendorFacts({
    providers: [
      {
        provider: 'deepseek-official',
        displayName: 'DeepSeek Account',
        credential: 'api-key',
        balanceSupported: true,
        balance: { currency: 'CNY', totalBalance: '12.34' },
        planSupported: false,
        planError: 'unsupported',
      },
    ],
  })
  const props = { facts, error: null }
  react.render(AccountTab, props)
  await tick()
  const { tree } = react.render(AccountTab, props)

  assert.equal(findByPart(tree, 'account-howto'), null, 'no missing key, no instructions')
})

test('axisTicks spreads its labels across the window', async () => {
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react, {}).factory(fakeRequire(react))
  const { axisTicks } = module.__internals

  const day = (date) => ({ date, totals: { calls: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } })
  assert.deepEqual(axisTicks([]), [])
  assert.deepEqual(axisTicks([day('2026-10-18')]), ['2026-10-18'])

  // A week gets a first, a middle and a last label — not just the two ends.
  const week = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18'].map(day)
  assert.deepEqual(axisTicks(week), ['2026-10-12', '2026-10-15', '2026-10-18'])

  // A month gets four, and they stay inside the window and in order.
  const month = Array.from({ length: 30 }, (_, index) => day(`2026-10-${String(index + 1).padStart(2, '0')}`))
  const ticks = axisTicks(month)
  assert.equal(ticks.length, 4)
  assert.deepEqual(ticks, [...ticks].sort(), 'labels come out in date order')
  assert.equal(ticks[0], '2026-10-01')
  assert.equal(ticks[3], '2026-10-30')
})

test('UsageTab renders the range picker, the metrics, the breakdown and the chart', async () => {
  const page = createPage()
  const react = createReact()
  const { fetch, seen } = routedFetch({ 'api/usage-stat/range': { ok: true, range: rangeDocument() } })
  const module = loadBundle(page, react, { fetch }).factory(fakeRequire(react))
  const { UsageTab, shiftDayKey } = module.__internals

  const props = { overview: overviewDocument() }
  react.render(UsageTab, props)

  // The window is fetched from an effect and the fake runtime renders once per
  // call, so let the promise chain settle and render again to observe the state
  // the resolved fetch wrote.
  await new Promise((resolve) => setTimeout(resolve, 0))

  // The default window is the last seven days, asked for by date, not by preset.
  const today = new Date()
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  assert.equal(seen[0], `api/usage-stat/range?from=${shiftDayKey(todayKey, -6)}&to=${todayKey}`)

  const { tree } = react.render(UsageTab, props)

  const text = textOf(tree)
  for (const label of ['总 tokens', '输入', '输出', '缓存读', '缓存写', '调用次数']) assert.match(text, new RegExp(label))
  // Every window is offered as a preset, plus a custom from/to pair.
  for (const label of ['今天', '近 7 天', '近 30 天', '全部', '自定义']) assert.match(text, new RegExp(label))
  assert.notEqual(findByPart(tree, 'range-today'), null)
  assert.notEqual(findByPart(tree, 'range-custom'), null)
  assert.match(text, /用量概览/)
  assert.match(text, /供应商与模型/)
  assert.match(text, /OpenCode Go/)
  assert.match(text, /每日用量/)
  // The chart is scaled to the window's own peak, so the card names it.
  assert.match(text, /最高 6\.3K（10-17）/)
  // The chart spans the picked window, not only the days that hold usage: the
  // range document has two days but the window is seven, so seven bars.
  assert.equal(findAllByPart(tree, 'chart-col').length, 7)
  // The trend-days knob is gone: the range picker replaced it.
  assert.doesNotMatch(text, /趋势天数/)
})

test('the daily chart covers the whole picked window, empty days included', () => {
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react).factory(fakeRequire(react))
  const { chartDays, CHART_MAX_DAYS } = module.__internals

  const totals = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 }
  const days = [
    { date: '2026-10-12', totals },
    { date: '2026-10-18', totals },
  ]

  const chart = chartDays('2026-10-12', '2026-10-18', days)
  assert.equal(chart.length, 7)
  assert.equal(chart[0].date, '2026-10-12')
  assert.equal(chart[6].date, '2026-10-18')
  // A day with no usage is a zero bar, not a missing column, so the axis and
  // the numbers above it describe the same span.
  assert.equal(chart[3].date, '2026-10-15')
  assert.equal(chart[3].totals.calls, 0)
  assert.equal(chart[3].totals.inputTokens, 0)

  // An unset or backwards window has nothing to draw, and an enormous one is
  // capped so the chart cannot try to lay out a decade of columns.
  assert.deepEqual(chartDays('', '2026-10-18', days), [])
  assert.deepEqual(chartDays('2026-10-18', '2026-10-12', days), [])
  assert.equal(chartDays('2000-01-01', '2026-10-18', days).length, CHART_MAX_DAYS)
})

test('formatTokens matches the shell\'s own compact style', () => {
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react).factory(fakeRequire(react))
  const { formatTokens } = module.__internals

  assert.equal(formatTokens(0), '0')
  assert.equal(formatTokens(999), '999')
  assert.equal(formatTokens(1_000), '1K')
  assert.equal(formatTokens(1_284), '1.3K')
  assert.equal(formatTokens(130_400), '130.4K')
  assert.equal(formatTokens(34_400_000), '34.4M')
})

test('shiftDayKey walks calendar days without drifting on DST', () => {
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react).factory(fakeRequire(react))
  const { shiftDayKey } = module.__internals

  assert.equal(shiftDayKey('2026-10-18', 0), '2026-10-18')
  assert.equal(shiftDayKey('2026-10-18', -6), '2026-10-12')
  assert.equal(shiftDayKey('2026-10-01', -1), '2026-09-30', 'it crosses month boundaries')
  assert.equal(shiftDayKey('2026-01-01', -1), '2025-12-31', 'and year boundaries')
  // A DST-shifting zone must still land on a whole day: 2026-03-29 is the
  // European spring-forward date and 2026-10-25 the fall-back one.
  assert.equal(shiftDayKey('2026-03-30', -1), '2026-03-29')
  assert.equal(shiftDayKey('2026-10-26', -1), '2026-10-25')
})

test('rangeOf resolves every preset to an explicit from/to pair', () => {
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react).factory(fakeRequire(react))
  const { rangeOf, RANGE_PRESETS } = module.__internals

  const days = ['2026-08-01', '2026-09-14', '2026-10-18']
  assert.deepEqual([...RANGE_PRESETS], ['today', 'last7', 'last30', 'all', 'custom'])
  assert.deepEqual(rangeOf('today', '2026-10-18', days), { from: '2026-10-18', to: '2026-10-18' })
  assert.deepEqual(rangeOf('last7', '2026-10-18', days), { from: '2026-10-12', to: '2026-10-18' })
  assert.deepEqual(rangeOf('last30', '2026-10-18', days), { from: '2026-09-19', to: '2026-10-18' })
  // `all` starts at the oldest retained day, and falls back to today when the
  // ledger is empty rather than producing an open-ended window.
  assert.deepEqual(rangeOf('all', '2026-10-18', days), { from: '2026-08-01', to: '2026-10-18' })
  assert.deepEqual(rangeOf('all', '2026-10-18', []), { from: '2026-10-18', to: '2026-10-18' })
  assert.deepEqual(rangeOf('nonsense', '2026-10-18', days), { from: '2026-10-12', to: '2026-10-18' })
})

test('DayChart scales every bar against the busiest day in the window', () => {
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react).factory(fakeRequire(react))
  const { DayChart } = module.__internals

  const { tree } = react.render(DayChart, {
    days: [
      { date: '2026-10-16', totals: { inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 2 } },
      { date: '2026-10-17', totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 0 } },
      { date: '2026-10-18', totals: { inputTokens: 3_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 4 } },
    ],
  })

  const bars = []
  const collect = (node) => {
    if (node === null || node === undefined || typeof node === 'string') return
    if (Array.isArray(node)) return node.forEach(collect)
    if (node.props?.['data-dsh-part'] === 'chart-col') bars.push(node)
    node.children.forEach(collect)
  }
  collect(tree)

  assert.equal(bars.length, 3)
  const heights = bars.map((bar) => {
    let style = null
    const scan = (node) => {
      if (node === null || node === undefined || typeof node === 'string') return
      if (Array.isArray(node)) return node.forEach(scan)
      const own = node.props?.style
      if (own !== null && typeof own === 'object' && typeof own.height === 'string') style = own.height
      node.children.forEach(scan)
    }
    scan(bar)
    return Number(/^([\d.]+)%$/.exec(style ?? '')?.[1])
  })
  assert.equal(heights[2], 100, 'the busiest day fills the plot')
  assert.equal(heights[0], 33, 'a third of the peak is a third of the height')
  assert.equal(heights[1], 2, 'a day with no usage keeps a visible stub')
})

test('peakOf names the day the chart scales to', () => {
  // The chart is relative, so the card has to say what "full height" means.
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react).factory(fakeRequire(react))
  const { peakOf } = module.__internals

  const day = (date, tokens) => ({ date, totals: { inputTokens: tokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 } })

  assert.deepEqual(peakOf([day('2026-10-16', 100), day('2026-10-17', 300), day('2026-10-18', 200)]), { value: 300, date: '2026-10-17' })
  assert.deepEqual(peakOf([]), { value: 0, date: '' }, 'nothing to scale to is not a crash')
  assert.deepEqual(peakOf(undefined), { value: 0, date: '' })
  assert.deepEqual(peakOf([day('2026-10-16', 0), day('2026-10-17', 0)]), { value: 0, date: '' }, 'an all-empty window has no peak day')
  assert.deepEqual(peakOf([day('2026-10-16', 100), day('2026-10-17', 100)]), { value: 100, date: '2026-10-16' }, 'the first day wins a tie')
})

//#region ------------------------------------------------------------- reminders

test('the reminder index groups by provider and drops what it cannot read', () => {
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react).factory(fakeRequire(react))
  const { alertsIndex } = module.__internals

  const week = { provider: 'opencode-go', kind: 'window', window: 'week', remaining: 5, threshold: 10 }
  const month = { provider: 'opencode-go', kind: 'window', window: 'month', remaining: 1, threshold: 5 }
  const balance = { provider: 'deepseek-official', kind: 'balance', currency: 'CNY', amount: 0.5, threshold: 1 }

  const index = alertsIndex([week, month, balance, null, 'x', 7, {}, { provider: '' }])
  assert.deepEqual([...index.keys()], ['opencode-go', 'deepseek-official'])
  assert.deepEqual(index.get('opencode-go'), [week, month])

  // A missing or malformed list is an empty index, never a throw: the dot is
  // decoration over the numbers and may not be able to take a card down.
  for (const bad of [undefined, null, 'x', 7, {}]) {
    assert.equal(alertsIndex(bad).size, 0)
  }
})

test('a reminder reads as a sentence about what is left', () => {
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react).factory(fakeRequire(react))
  const { alertTitle, dotFor, alertsIndex } = module.__internals

  assert.equal(
    alertTitle({ provider: 'opencode-go', kind: 'window', window: 'week', remaining: 5.4, threshold: 10 }),
    '本周剩余 5%，低于提醒值 10%',
  )
  assert.equal(
    alertTitle({ provider: 'deepseek-official', kind: 'balance', currency: 'CNY', amount: 0.5, threshold: 1 }),
    '余额 ¥0.50，低于提醒值 1',
  )

  // One provider can trip more than one rule, and both reasons survive.
  const index = alertsIndex([
    { provider: 'opencode-go', kind: 'window', window: 'week', remaining: 5, threshold: 10 },
    { provider: 'opencode-go', kind: 'window', window: '5h', remaining: 2, threshold: 20 },
  ])
  assert.equal(dotFor(index, 'opencode-go'), '本周剩余 5%，低于提醒值 10%；5 小时剩余 2%，低于提醒值 20%')
  assert.equal(dotFor(index, 'anthropic'), undefined, 'a provider with no reminder gets no dot')
})

test('the sidebar card marks the provider that is running low', () => {
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react).factory(fakeRequire(react))
  const { FootCard, createOverviewStore } = module.__internals

  const store = createOverviewStore()
  store.set({
    status: 'ready',
    overview: overviewDocument({
      alerts: [{ provider: 'opencode-go', displayName: 'OpenCode Go', kind: 'window', window: 'week', remaining: 5, threshold: 10 }],
    }),
    error: null,
  })

  globalThis.window.localStorage = { getItem: () => '1', setItem: () => {} }
  const { tree } = react.render(FootCard, { store })

  const dots = findAllByPart(tree, 'alert-dot')
  assert.equal(dots.length, 1, 'only the flagged provider is marked')
  assert.match(dots[0].props.title, /本周剩余 5%/)
  assert.equal(dots[0].props['aria-label'], dots[0].props.title, 'the mark is legible without a hover too')

  // A provider with no reminder must not be marked by accident.
  react.reset()
  const clean = react.render(FootCard, { store: (() => {
    const other = createOverviewStore()
    other.set({ status: 'ready', overview: overviewDocument(), error: null })
    return other
  })() })
  assert.equal(findAllByPart(clean.tree, 'alert-dot').length, 0)
})

test('a provider running low is listed even when it is outside the top rows', () => {
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react).factory(fakeRequire(react))
  const { FootCard, createOverviewStore } = module.__internals

  // Four providers with descending usage: the cap shows three, and the fourth
  // is the one with the reminder. A reminder must not be hideable by ranking.
  const totals = { inputTokens: 1_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, calls: 1 }
  const providers = ['a', 'b', 'c', 'z'].map((id, index) => ({
    provider: id,
    displayName: id.toUpperCase(),
    totals: { ...totals, inputTokens: 4_000 - index * 1_000 },
    models: [],
  }))

  const store = createOverviewStore()
  store.set({
    status: 'ready',
    overview: overviewDocument({
      providers,
      today: { date: '2026-10-18', totals, providers },
      availableDays: ['2026-10-18'],
      alerts: [{ provider: 'z', displayName: 'Z', kind: 'window', window: 'month', remaining: 1, threshold: 5 }],
    }),
    error: null,
  })

  globalThis.window.localStorage = { getItem: () => '1', setItem: () => {} }
  const { tree } = react.render(FootCard, { store })

  const text = textOf(tree)
  assert.match(text, /Z/, 'the flagged provider is pulled into the list')
  const dots = findAllByPart(tree, 'alert-dot')
  assert.equal(dots.length, 1)
  assert.match(dots[0].props.title, /本月剩余 1%/)
})

test('the account tab marks the rows it warns about', async () => {
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react).factory(fakeRequire(react))
  const { AccountTab } = module.__internals

  const facts = vendorFacts({
    alerts: [
      { provider: 'opencode-go', displayName: 'OpenCode Go', kind: 'window', window: 'week', remaining: 5, threshold: 10 },
      { provider: 'deepseek-official', displayName: 'DeepSeek Account', kind: 'balance', currency: 'CNY', amount: 0.5, threshold: 1 },
    ],
  })

  const { tree } = react.render(AccountTab, { facts, probing: false, error: null, onProbe: () => {} })
  const dots = findAllByPart(tree, 'alert-dot')
  // Two vendors, two reminders, one dot each — and each says which of its own
  // numbers is low.
  assert.equal(dots.length, 2)
  assert.match(dots[0].props.title, /本周剩余 5%/)
  assert.match(dots[1].props.title, /余额 ¥0\.50/)
  assert.notEqual(findByPart(tree, 'balance-row'), null)
  assert.equal(findAllByPart(tree, 'plan-window').length, 2)
})

test('the settings tab exposes every reminder threshold', async () => {
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react).factory(fakeRequire(react))
  const { SettingsTab } = module.__internals

  const props = { overview: overviewDocument({ config: { alertBalanceBelow: 10, alertWindowWeek: 15 } }), onConfigSaved: () => {} }
  react.render(SettingsTab, props)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const { tree } = react.render(SettingsTab, props)

  const text = textOf(tree)
  for (const label of ['余量提醒', '余额低于', '5 小时剩余低于', '本周剩余低于', '本月剩余低于']) {
    assert.match(text, new RegExp(label))
  }
  // The hint is written for the person reading the settings, not for whoever
  // reads the source.
  assert.match(text, /填 0 表示该项不提醒/)

  // The stored thresholds are what the inputs show, and each input is bounded
  // so a typo cannot arm a reminder the host would then clamp away silently.
  const numbers = findAllByPart(tree, 'alert-input')
  assert.equal(numbers.length, 4)
  assert.deepEqual(numbers.map((input) => input.props.value), [10, 0, 15, 0])
  assert.deepEqual(numbers.map((input) => input.props.max), [1_000_000, 100, 100, 100])
  assert.ok(numbers.every((input) => input.props.min === 0))
  assert.equal(findAllByPart(tree, 'alert-check').length, 1)

  // Every numeric row in the form carries a unit mark, so all six boxes end on
  // the same right edge instead of the ones without a mark sitting a
  // suffix-width further right.
  const suffixes = findAllByPart(tree, 'form-unit')
  assert.deepEqual(suffixes.map((node) => textOf(node)), ['秒', '秒', '元', '%', '%', '%'])
})

test('chartHours fills the day to twenty-four columns, gaps included', () => {
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react).factory(fakeRequire(react))
  const { chartHours, clockLabel } = module.__internals

  const hours = chartHours({
    hours: [
      { hour: 0, totals: { inputTokens: 5, calls: 1 } },
      { hour: 23, totals: { inputTokens: 7, calls: 1 } },
    ],
  })
  assert.equal(hours.length, 24)
  assert.deepEqual(hours.map((row) => row.hour), Array.from({ length: 24 }, (_, hour) => hour))
  // A quiet hour is a real column of nothing, so the chart reads as a clock
  // rather than as a list of the hours that happened to be busy.
  assert.equal(hours[12].totals.inputTokens, 0)
  assert.equal(hours[23].totals.inputTokens, 7)
  assert.equal(clockLabel(9), '09:00')
  assert.equal(clockLabel(18), '18:00')
  // No data at all is an empty day, not a throw.
  assert.equal(chartHours(undefined).length, 24)
})

test('peakHourOf names the hour the hour chart scales to', () => {
  const page = createPage()
  const react = createReact()
  const module = loadBundle(page, react).factory(fakeRequire(react))
  const { chartHours, peakHourOf } = module.__internals

  const hours = chartHours({
    hours: [
      { hour: 9, totals: { inputTokens: 10 } },
      { hour: 15, totals: { inputTokens: 900 } },
    ],
  })
  assert.deepEqual(peakHourOf(hours), { value: 900, hour: 15 })
  // Nothing recorded: no peak, and no hour to name.
  assert.deepEqual(peakHourOf(chartHours({ hours: [] })), { value: 0, hour: -1 })
})

test('a one-day window charts the day by the hour instead of by the day', async () => {
  const page = createPage()
  const react = createReact()
  const day = dayDocument()
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const { fetch } = routedFetch({
    'api/usage-stat/range': {
      ok: true,
      range: {
        from: today,
        to: today,
        totals: day.totals,
        providers: day.providers,
        days: [{ date: today, totals: day.totals }],
        hours: {
          date: today,
          available: true,
          hours: [
            { hour: 9, totals: { inputTokens: 10, calls: 2 } },
            { hour: 15, totals: { inputTokens: 900, calls: 5 } },
          ],
        },
      },
    },
  })
  const module = loadBundle(page, react, { fetch }).factory(fakeRequire(react))
  const { UsageTab } = module.__internals

  const props = { overview: overviewDocument() }
  react.render(UsageTab, props)
  await tick()
  findByPart(react.render(UsageTab, props).tree, 'range-today').props.onClick()
  // The click only records the choice. The render after it is what changes the
  // window and starts the fetch, so the fetch needs a tick of its own before the
  // numbers can be read — nothing stale is shown in between, by design.
  await tick()
  react.render(UsageTab, props)
  await tick()
  const { tree } = react.render(UsageTab, props)
  const text = textOf(tree)

  assert.match(text, /每小时用量/)
  assert.doesNotMatch(text, /每日用量/)
  // The peak is named in clock time, because that is what the bars scale to.
  assert.match(text, /15:00/)
  // Twenty-four columns, and only the two hours that recorded something drew a
  // bar: a quiet hour draws nothing rather than a zero-height stub.
  assert.equal(findAllByPart(tree, 'chart-hour').length, 24)
  assert.equal(findAllByPart(tree, 'chart-bar').length, 2)
  // The axis is a clock, not a date.
  assert.match(text, /00:00/)
  assert.match(text, /18:00/)
  assert.doesNotMatch(text, /10-12/)
})
//#region -------------------------------------------------------------- cost tab

test('formatMoney keeps the precision that matters at each magnitude', () => {
  const react = createReact()
  const module = loadBundle(createPage(), react).factory(fakeRequire(react))
  const { formatMoney } = module.__internals

  // A day can be a few yuan and a single cheap call a fraction of a cent. Two
  // decimals everywhere would print every small amount as ¥0.00, which reads as
  // "free" rather than "small".
  assert.equal(formatMoney(0), '¥0.00')
  assert.equal(formatMoney(0.00032), '¥0.00032')
  assert.equal(formatMoney(0.0123), '¥0.012')
  assert.equal(formatMoney(1.5), '¥1.50')
  assert.equal(formatMoney(1234.5), '¥1,234.50')
  // Nothing usable is nothing, not `¥NaN`.
  assert.equal(formatMoney(undefined), '¥0.00')
  assert.equal(formatMoney(Number.NaN), '¥0.00')
})

test('the client reads a price row exactly like the host does', async () => {
  const react = createReact()
  const module = loadBundle(createPage(), react).factory(fakeRequire(react))
  const { pricesFromRows, priceRowsFrom, canonicalPrices, blankPriceRow } = module.__internals
  const host = await import('../lib/core/pricing.js')

  // The client cannot require plugin code, so filling a row is a second
  // implementation. It is only safe as long as it is the *same* one.
  const rows = [
    { model: 'DeepSeek-V4.1-Flash', from: '', input: '2', output: '8', cacheRead: '', cacheWrite: '' },
    { model: 'gpt-5.6-luna', from: '2026-10-01', input: '1.5', output: '4.5', cacheRead: '0.05', cacheWrite: '1.5' },
    // A price change is a second row for the same model, not an edit of the first.
    { model: 'gpt-5.6-luna', from: '2026-10-15', input: '3', output: '9', cacheRead: '0.1', cacheWrite: '3' },
    // Nothing typed in at all is an empty slot, not a bad row.
    blankPriceRow(),
  ]

  const mine = pricesFromRows(rows)
  assert.deepEqual(mine.errors, [])
  assert.deepEqual(mine.prices, host.normalizePrices(mine.prices))
  // Two fields is a complete row: a model with no cache-write price has none.
  assert.equal(mine.prices['deepseek-v4.1-flash'][0].cacheWrite, 0)
  // The undated row leads, and the later price follows the earlier one.
  assert.deepEqual(mine.prices['gpt-5.6-luna'].map((row) => row.from), ['2026-10-01', '2026-10-15'])
  // Model names are matched case-insensitively, the way the host matches them.
  assert.deepEqual(Object.keys(mine.prices).sort(), ['deepseek-v4.1-flash', 'gpt-5.6-luna'])

  // And the round trip back into the grid keeps what the host would keep: one
  // line per dated row, oldest first.
  assert.deepEqual(
    priceRowsFrom(mine.prices).map((row) => `${row.model}@${row.from}`),
    ['deepseek-v4.1-flash@', 'gpt-5.6-luna@2026-10-01', 'gpt-5.6-luna@2026-10-15'],
  )
  assert.equal(canonicalPrices(mine.prices), canonicalPrices(host.normalizePrices(mine.prices)))
})

test('a row named like a prototype member is a bad row, not a replaced prototype', () => {
  const react = createReact()
  const module = loadBundle(createPage(), react).factory(fakeRequire(react))
  const { pricesFromRows } = module.__internals

  const parsed = pricesFromRows([
    { model: '__proto__', input: '1', output: '2' },
    { model: 'constructor', input: '1', output: '2' },
    { model: 'prototype', input: '1', output: '2' },
  ])
  assert.deepEqual(parsed.prices, {})
  assert.deepEqual(parsed.errors.map((entry) => entry.row), [1, 2, 3])
  assert.equal(Object.getPrototypeOf(parsed.prices), Object.prototype)
})

test('a row that is half filled in is named, and the whole ones still save', () => {
  const react = createReact()
  const module = loadBundle(createPage(), react).factory(fakeRequire(react))
  const { pricesFromRows } = module.__internals

  const parsed = pricesFromRows([
    { model: 'ark-plan', input: '1', output: '4' },
    // A name with no price is not a price of zero.
    { model: 'mimo-v2.6-flash', input: '', output: '' },
    // A price with no name cannot be looked up by anything.
    { model: '', input: '1', output: '2' },
    // A number that is not one.
    { model: 'gpt-5.6-luna', input: 'cheap', output: '4' },
  ])

  assert.deepEqual(Object.keys(parsed.prices), ['ark-plan'])
  assert.deepEqual(parsed.errors.map((entry) => entry.row), [2, 3, 4])
})

test('costScope narrows to a provider and to one model of it', () => {
  const react = createReact()
  const module = loadBundle(createPage(), react).factory(fakeRequire(react))
  const { costScope } = module.__internals
  const cost = costDocument()

  assert.equal(costScope(cost, '', ''), cost)

  const provider = costScope(cost, 'opencode-go', '')
  assert.equal(provider.total, 1.5)
  assert.equal(provider.tokens, 2_000_000)
  assert.equal(provider.pricedTokens, 2_000_000)
  assert.equal(provider.unpricedCount, 0)
  assert.equal(provider.providers.length, 1)

  const model = costScope(cost, 'deepseek', 'gpt-5.6-luna')
  assert.equal(model.total, 0)
  assert.equal(model.pricedTokens, 0)
  assert.equal(model.unpricedTokens, 1_000_000)
  assert.equal(model.unpricedCount, 1)
  assert.equal(model.providers[0].models.length, 1)

  // An unknown provider is nothing to show, not a zero.
  assert.equal(costScope(cost, 'nope', ''), null)
  assert.equal(costScope(null, 'opencode-go', ''), null)
})

test('costColumns fills the clock and follows the scope', () => {
  const react = createReact()
  const module = loadBundle(createPage(), react).factory(fakeRequire(react))
  const { costColumns, peakColumn } = module.__internals
  const hourView = {
    date: '2026-10-18',
    available: true,
    hours: [
      { hour: 9, cost: costDocument({ total: 0.5 }) },
      { hour: 15, cost: costDocument({ total: 1.0 }) },
    ],
  }

  const all = costColumns(hourView, '', '')
  assert.equal(all.length, 24)
  assert.equal(all[9].value, 0.5)
  assert.equal(all[15].value, 1)
  // An hour with no record is a zero column, not a missing one.
  assert.equal(all[12].value, 0)
  assert.deepEqual(peakColumn(all), { value: 1, hour: 15, date: '' })

  // Narrowed to the provider with no price, every hour is worth nothing — and
  // the chart says so rather than naming a peak of zero.
  const scoped = costColumns(hourView, 'deepseek', '')
  assert.equal(scoped[9].value, 0)
  assert.deepEqual(peakColumn(scoped), { value: 0, hour: -1, date: '' })
})

test('the cost tab converts the window and follows the scope picker', async () => {
  const react = createReact()
  const { fetch } = routedFetch({
    'api/usage-stat/range': { ok: true, range: { ...rangeDocument(), cost: costDocument() } },
  })
  const module = loadBundle(createPage(), react, { fetch }).factory(fakeRequire(react))
  const { CostTab } = module.__internals
  const props = { overview: overviewDocument() }

  react.render(CostTab, props)
  await tick()
  const whole = react.render(CostTab, props).tree
  const text = textOf(whole)
  assert.match(text, /金额折算/)
  assert.match(text, /¥1\.50/)
  assert.match(text, /gpt-5\.6-luna/)
  // The unpriced model is named, and the number it would have contributed is
  // called out as uncounted rather than folded in as zero.
  assert.notEqual(findByPart(whole, 'cost-unpriced'), null)
  assert.equal(findAllByPart(whole, 'cost-provider').length, 2)

  // Two boxes, not one: the provider first, then the model within it. The model
  // box has nothing to offer until a provider is chosen.
  assert.equal(findByPart(whole, 'cost-scope-model').props.disabled, true)

  findByPart(whole, 'cost-scope-provider').props.onChange({ target: { value: 'opencode-go' } })
  const scoped = react.render(CostTab, props).tree
  // The breakdown narrows to the one provider. The pickers still list every
  // name — they have to, that is what a picker is — so the assertion is on the
  // rows, not on the text.
  assert.equal(findAllByPart(scoped, 'cost-provider').length, 1)
  assert.equal(findAllByPart(scoped, 'cost-model').length, 1)
  assert.equal(findByPart(scoped, 'cost-unpriced'), null)

  // And the second box narrows further, to one model of that provider.
  findByPart(scoped, 'cost-scope-model').props.onChange({ target: { value: 'deepseek-v4.1-flash' } })
  const one = react.render(CostTab, props).tree
  assert.equal(findAllByPart(one, 'cost-provider').length, 1)
  assert.equal(findAllByPart(one, 'cost-model').length, 1)
})

test('a one-day window charts the cost by the hour', async () => {
  const react = createReact()
  const day = dayDocument()
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const { fetch } = routedFetch({
    'api/usage-stat/range': {
      ok: true,
      range: {
        from: today,
        to: today,
        totals: day.totals,
        providers: day.providers,
        days: [{ date: today, totals: day.totals }],
        cost: costDocument(),
        hours: {
          date: today,
          available: true,
          hours: [
            { hour: 9, totals: { inputTokens: 10, calls: 1 }, cost: costDocument({ total: 0.25 }) },
            { hour: 15, totals: { inputTokens: 900, calls: 4 }, cost: costDocument({ total: 2.5 }) },
          ],
        },
      },
    },
  })
  const module = loadBundle(createPage(), react, { fetch }).factory(fakeRequire(react))
  const { CostTab } = module.__internals
  const props = { overview: overviewDocument() }

  react.render(CostTab, props)
  await tick()
  findByPart(react.render(CostTab, props).tree, 'range-today').props.onClick()
  // Same two-step as the usage tab: the click records, the next render fetches.
  await tick()
  react.render(CostTab, props)
  await tick()
  const { tree } = react.render(CostTab, props)
  const text = textOf(tree)

  assert.match(text, /每小时金额/)
  // The peak is named in money and on the clock, because that is what the bars
  // scale to.
  assert.match(text, /最高 ¥2\.50（15:00）/)
  assert.equal(findAllByPart(tree, 'chart-hour').length, 24)
  assert.equal(findAllByPart(tree, 'chart-bar').length, 2)
  assert.match(text, /00:00/)
})

test('a longer window charts the cost day by day', async () => {
  const react = createReact()
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  const key = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  // The tab defaults to the last seven days and computes the window itself, so
  // the fixture's days have to fall inside that window for the money to land.
  const today = key(now)
  const yesterday = key(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
  const { fetch } = routedFetch({
    'api/usage-stat/range': {
      ok: true,
      range: {
        ...rangeDocument(),
        cost: costDocument(),
        // Two of the seven days carry money; the quiet ones still get a column
        // but draw no bar, so the window reads as seven days rather than two.
        days: [
          { date: yesterday, totals: { inputTokens: 10, calls: 1 }, cost: costDocument({ total: 0.4 }) },
          { date: today, totals: { inputTokens: 20, calls: 1 }, cost: costDocument({ total: 1.2 }) },
        ],
      },
    },
  })
  const module = loadBundle(createPage(), react, { fetch }).factory(fakeRequire(react))
  const { CostTab } = module.__internals
  const props = { overview: overviewDocument() }

  react.render(CostTab, props)
  await tick()
  const { tree } = react.render(CostTab, props)
  const text = textOf(tree)

  // A multi-day window is charted by the day, the way the usage tab charts it;
  // the clock chart is for a single day.
  assert.match(text, /每日金额/)
  assert.doesNotMatch(text, /每小时金额/)
  assert.equal(findAllByPart(tree, 'chart-col').length, 7)
  assert.equal(findAllByPart(tree, 'chart-hour').length, 0)
  assert.equal(findAllByPart(tree, 'chart-bar').length, 2)
  // The peak is named in money and on the day it happened.
  const short = `${Number(today.slice(5, 7))}-${Number(today.slice(8, 10))}`
  assert.match(text, new RegExp(`最高 ¥1\\.20（${short}）`))
})

test('the settings tab edits the price table a row at a time', async () => {
  const react = createReact()
  const module = loadBundle(createPage(), react).factory(fakeRequire(react))
  const { SettingsTab } = module.__internals
  const overview = overviewDocument({
    config: { prices: { 'deepseek-flash': { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 2 } } },
  })
  const props = { overview, onConfigSaved: () => {} }

  react.render(SettingsTab, props)
  const tree = react.render(SettingsTab, props).tree
  // One row per stored price, and each column is its own box.
  assert.equal(findAllByPart(tree, 'price-row').length, 1)
  assert.equal(findByPart(tree, 'price-model').props.value, 'deepseek-flash')
  assert.deepEqual(
    findAllByPart(tree, 'price-field').map((node) => node.props.value),
    ['2', '8', '0.04', '2'],
  )
  // The built-in rows are named, so a reader can see what a row overrides.
  assert.match(textOf(tree), /deepseek-v4-pro/)
  // Nothing typed yet, so there is nothing to save.
  assert.equal(findByPart(tree, 'config-save').props.disabled, true)

  // A row that cannot be read blocks the save rather than being dropped.
  findByPart(tree, 'price-field').props.onChange({ target: { value: '' } })
  const broken = react.render(SettingsTab, props).tree
  assert.notEqual(findByPart(broken, 'prices-bad'), null)
  assert.equal(findByPart(broken, 'config-save').props.disabled, true)

  findAllByPart(broken, 'price-field')[0].props.onChange({ target: { value: '3' } })
  const fixed = react.render(SettingsTab, props).tree
  assert.equal(findByPart(fixed, 'prices-bad'), null)
  assert.equal(findByPart(fixed, 'config-save').props.disabled, false)

  // A new row starts empty, and removing one takes it away again.
  findByPart(fixed, 'price-add').props.onClick()
  const added = react.render(SettingsTab, props).tree
  assert.equal(findAllByPart(added, 'price-row').length, 2)
  assert.equal(findAllByPart(added, 'price-field').length, 8)
  findAllByPart(added, 'price-remove')[1].props.onClick()
  const removed = react.render(SettingsTab, props).tree
  assert.equal(findAllByPart(removed, 'price-row').length, 1)
})