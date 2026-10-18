/**
 * dsh-usage-stat browser half.
 *
 * Delivered as a lazy CommonJS bundle the DSH module loader executes in the
 * page (`window.__ModuleLoader__.load({ id, factory })`). The `id` MUST equal
 * the package name — it is the module-table key — and the module exports
 * `{ name, inject, apply }`, which is what the vendored Cordis loader hands to
 * `ctx.registry.plugin`.
 *
 * ## What this half renders
 *
 * 1. **The sidebar foot card** — a compact "今日用量" glance in the sidebar's
 *    foot area, above the Settings row, that expands in place to a
 *    per-provider, per-model breakdown. The foot's only slot
 *    (`sidebar.footer.action`) is a horizontal action row that cannot host a
 *    block, so the card is seated at the DOM level with its own React root and
 *    re-seated by a body mutation observer whenever the shell re-renders
 *    around it. That is the same approach the previous usage plugin used, and
 *    the only one that yields a full-width card in this shell version.
 * 2. **The conversation badge** — a pill in `conversation.composer.dock`
 *    showing the current conversation's total tokens. The pill itself reads the
 *    slot's ambient `useProjection` prop, so the closed state needs no HTTP
 *    request and no host round trip: the number is already in the page. Clicking
 *    it opens a panel — the same surface the shell's own context meter opens —
 *    with this conversation's per-vendor, per-model breakdown, fetched on
 *    demand from `/api/usage-stat/session`.
 * 3. **The 用量统计 settings section** — a `settings.section` entry with a
 *    range picker, per-provider / per-model detail, a per-day chart and the
 *    plugin's own settings.
 *
 * ## Where things are
 *
 * The file is one linear script with `//#region` banners. In order:
 *
 * - **copy** — the zh/en strings. Every user-facing word lives here, so a
 *   wording change is one edit in one place rather than a search for literals.
 * - **formatting** — pure helpers with no React in them: `formatTokens`,
 *   `formatClock`, `shortDate`, `shiftDayKey`, `totalOf`, `peakOf`,
 *   `axisTicks`, `chartDays`, `rangeOf`.
 * - **styles** — the whole stylesheet as one template string, injected once.
 *   It only ever names `--dsw-*` theme tokens, so it follows the user's skin.
 * - **api** — the host routes this half calls, one method each.
 * - **store** / **polling** — the overview subscription the shell's
 *   `useSyncExternalStore` reads, and the visible-tab refresh cadence.
 * - **icons** — the inline SVGs.
 * - **foot card** — the sidebar card and its DOM seating.
 * - **session pill** — the composer badge and the breakdown panel it opens.
 * - **settings view** — `UsageSection` and its three tabs (`UsageTab`,
 *   `AccountTab`, `SettingsTab`).
 * - **vendor facts** — the balance / plan / reminder rendering shared by the
 *   account tab and the sidebar card.
 * - **mounting** — the observer that keeps the foot card seated.
 * - **apply** — the plugin body, and `__internals` for the tests.
 *
 * ## Conventions honoured here
 *
 * - **No build step.** This file is the shipped artifact; edit it and the
 *   client HMR poller picks it up in about half a second.
 * - **No runtime imports of DSH client packages.** Only `react`, `react-dom`,
 *   `react-dom/client` and the `slots` service are used; everything else is
 *   plain DOM. Colours come from the `--dsw-alias-*` theme tokens so the
 *   plugin follows the user's theme and skin.
 * - **Document-relative API URLs.** The GUI is served with `<base href="./">`,
 *   so fetches omit the leading slash that the host routes register with.
 * - **Every user-facing string is in `copy`.** The host never sends prose, so
 *   a sentence assembled from host data (a reason, a window name) is built from
 *   a template here.
 *
 * @module dsh-usage-stat/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-usage-stat',
  factory: (require) => {
    // The loader hands the factory a CommonJS `require` and consumes whatever
    // this factory RETURNS, so the module envelope has to exist before
    // anything writes to it. Without these two lines the bundle throws
    // `exports is not defined` the moment the browser executes it, and the
    // plugin silently never applies.
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const ReactDOM = require('react-dom')
    const ReactDOMClient = require('react-dom/client')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React

    //#region ------------------------------------------------------------ copy

    /**
     * Copy table. Deliberately local rather than borrowed from the Host's
     * locale service: the plugin must load on a deployment where that service
     * is absent, and its own strings are few. The active language is read from
     * the document (`<html lang>`) with the browser language as a fallback.
     */
    const COPY = {
      zh: {
        title: '用量统计',
        today: '今日用量',
        noData: '今日暂无用量',
        calls: '{n} 次调用',
        callsShort: '{n} 次',
        updated: '更新于 {time}',
        loading: '正在加载用量数据…',
        loadingVendors: '正在查询各供应商…',
        error: '加载失败：{error}',
        hostOff: '统计服务未启用',
        expand: '展开各供应商与模型明细',
        collapse: '收起明细',
        session: '本次对话',
        sessionNoBreakdown: '这段对话只有总量记录，没有分供应商明细',
        more: '还有 {n} 项',
        version: 'v{version}',
        tabUsage: '用量',
        tabAccount: '账户',
        refresh: '刷新',
        refreshing: '刷新中…',
        range: '统计范围',
        rangeToday: '今天',
        range7: '近 7 天',
        range30: '近 30 天',
        rangeAll: '全部',
        rangeCustom: '自定义',
        rangeFrom: '开始日期',
        rangeTo: '结束日期',
        rangeBad: '结束日期不能早于开始日期。',
        overview: '用量概览',
        daily: '每日用量',
        dailyPeak: '最高 {value}（{date}）',
        total: '总 tokens',
        input: '输入',
        output: '输出',
        cacheRead: '缓存读',
        cacheWrite: '缓存写',
        callCount: '调用次数',
        providers: '供应商与模型',
        settings: '设置',
        enable: '启用插件',
        pollInterval: '更新间隔（秒）',
        pollHint: '用量数据多久自动更新一次。',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        saveFailed: '保存失败：{error}',
        current: '当前',
        noProviders: '这个时间段还没有用量记录。',
        balanceTitle: '账户余额',
        planTitle: '套餐额度',
        accountTitle: '余额与套餐',
        balanceLabel: '余额',
        unavailable: '无法查询的供应商',
        vendorUpdated: '查询于 {time}',
        vendorStale: '尚未查询',
        probeNow: '立即查询',
        probing: '查询中…',
        probeEnabled: '查询余额与套餐',
        probeInterval: '查询间隔（秒）',
        probeHint: '余额与套餐变化较慢，不必像用量那样频繁查询。',
        noBalance: '还没有可查询余额的供应商。配置好对应的 API Key 后，余额会显示在这里。',
        reasonNoCredential: '未配置 API Key',
        reasonOauth: '已用账号登录，无法查询余额',
        reasonOrigin: '非官方地址，不查询余额',
        reasonUnsupported: '该供应商没有提供这项数据',
        catalogHint: '配置 API Key 后还可查询：{list}',
        catalogMore: '等 {n} 项',
        window5h: '5 小时',
        windowWeek: '本周',
        windowMonth: '本月',
        resetAt: '{time} 重置',
        planName: '套餐：{name}',
        alertEnabled: '余量提醒',
        alertBalance: '余额低于',
        alertUnit: '元',
        alertWindow5h: '5 小时剩余低于',
        alertWindowWeek: '本周剩余低于',
        alertWindowMonth: '本月剩余低于',
        alertHint: '余额或剩余额度低于所填数字时，会在对应供应商旁显示提醒。填 0 表示该项不提醒。',
        alertWindowTitle: '{window}剩余 {remaining}%，低于提醒值 {threshold}%',
        alertBalanceTitle: '余额 {amount}，低于提醒值 {threshold}',
        accountHowTo: '在「设置 → 模型」里为对应供应商填好 API Key，这里就会显示它的余额与套餐。',
        historyTitle: '历史用量',
        historyHint: '插件只记录它运行期间的用量。首次启用时会自动把 DSH 已保存的过往会话补进来；中间关过插件的话，可以在这里手动补一次。',
        historyRun: '重新补录',
        historyRunning: '正在补录…',
        historyDone: '已补录 {files} 个会话',
        historyNone: '尚未补录',
        historyAt: '已补录 {files} 个会话 · {time}',
      },
      en: {
        title: 'Usage stats',
        today: 'Today',
        noData: 'No usage yet today',
        calls: '{n} calls',
        callsShort: '{n} calls',
        updated: 'Updated {time}',
        loading: 'Loading usage…',
        loadingVendors: 'Querying providers…',
        error: 'Failed to load: {error}',
        hostOff: 'Usage service is not running',
        expand: 'Show per-provider and per-model detail',
        collapse: 'Hide detail',
        session: 'This chat',
        sessionNoBreakdown: 'This chat has a total only, no per-vendor detail',
        more: '{n} more',
        version: 'v{version}',
        tabUsage: 'Usage',
        tabAccount: 'Account',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        range: 'Range',
        rangeToday: 'Today',
        range7: 'Last 7 days',
        range30: 'Last 30 days',
        rangeAll: 'All',
        rangeCustom: 'Custom',
        rangeFrom: 'From',
        rangeTo: 'To',
        rangeBad: 'The end date cannot precede the start date.',
        overview: 'Overview',
        daily: 'Per day',
        dailyPeak: 'Peak {value} ({date})',
        total: 'Total tokens',
        input: 'Input',
        output: 'Output',
        cacheRead: 'Cache read',
        cacheWrite: 'Cache write',
        callCount: 'Calls',
        providers: 'Providers and models',
        settings: 'Settings',
        enable: 'Enable plugin',
        pollInterval: 'Refresh interval (seconds)',
        pollHint: 'How often the usage figures refresh.',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        saveFailed: 'Save failed: {error}',
        current: 'current',
        noProviders: 'No usage in this range yet.',
        balanceTitle: 'Account balance',
        planTitle: 'Plan quotas',
        accountTitle: 'Balance & plans',
        balanceLabel: 'Balance',
        unavailable: 'Providers that cannot be queried',
        vendorUpdated: 'Fetched {time}',
        vendorStale: 'Not fetched yet',
        probeNow: 'Fetch now',
        probing: 'Fetching…',
        probeEnabled: 'Fetch balance and plans',
        probeInterval: 'Fetch interval (seconds)',
        probeHint: 'Balances and plan windows move slowly, so they do not need to refresh as often as usage.',
        noBalance: 'No provider with a queryable balance yet. Configure an API key for one and its balance appears here.',
        reasonNoCredential: 'No API key configured',
        reasonOauth: 'Signed in with an account, so the balance cannot be queried',
        reasonOrigin: 'Points at a non-official address, so the balance is not queried',
        reasonUnsupported: 'This provider does not publish this figure',
        catalogHint: 'Queryable once an API key is configured: {list}',
        catalogMore: ' and {n} more',
        window5h: '5 hours',
        windowWeek: 'This week',
        windowMonth: 'This month',
        resetAt: 'resets {time}',
        planName: 'Plan: {name}',
        alertEnabled: 'Low-quota reminder',
        alertBalance: 'Balance below',
        alertUnit: '¥',
        alertWindow5h: '5-hour left below',
        alertWindowWeek: 'This week left below',
        alertWindowMonth: 'This month left below',
        alertHint: 'A reminder appears beside the provider when its balance or remaining quota falls below the number here. 0 turns that line off.',
        alertWindowTitle: '{window}: {remaining}% left, below the {threshold}% reminder',
        alertBalanceTitle: 'Balance {amount}, below the {threshold} reminder',
        accountHowTo: 'Add an API key for the provider under Settings → Models and its balance and plan windows appear here.',
        historyTitle: 'History',
        historyHint: 'The plugin only counts what it was running to see. It fills in the sessions DSH already saved the first time it starts; if it was switched off in between, run it again here.',
        historyRun: 'Scan again',
        historyRunning: 'Scanning…',
        historyDone: 'Added {files} sessions',
        historyNone: 'Not scanned yet',
        historyAt: 'Added {files} sessions · {time}',
      },
    }

    /** The active language, resolved once per page load. */
    const LANG = (() => {
      try {
        const html = document.documentElement.lang
        if (typeof html === 'string' && html.toLowerCase().startsWith('zh')) return 'zh'
        const nav = navigator.language
        if (typeof nav === 'string' && nav.toLowerCase().startsWith('zh')) return 'zh'
        if (typeof html === 'string' && html !== '') return 'en'
        return 'en'
      } catch {
        return 'zh'
      }
    })()

    /**
     * Look up one string, substituting `{name}` placeholders.
     * @param {string} key - the copy key.
     * @param {Record<string, string|number>} [params] - placeholder values.
     * @returns {string} the localized string.
     */
    function t(key, params) {
      const table = COPY[LANG] ?? COPY.zh
      const raw = table[key] ?? COPY.zh[key] ?? key
      if (params === undefined) return raw
      return raw.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    //#endregion

    //#region ------------------------------------------------------- formatting

    /**
     * Trim a scaled number to one decimal.
     *
     * One decimal at every magnitude keeps the width predictable and the card
     * legible — `1.3K`, `12.3K`, `130.4K`, `34.4M`. Rounding the hundreds away
     * (the obvious "short number" rule) is wrong here: it turns a
     * 130,400-token conversation into `130K` and drops the digit the user is
     * actually watching.
     */
    function trim(value) {
      if (value >= 1000) return String(Math.round(value))
      return value.toFixed(1).replace(/\.0$/, '')
    }

    /**
     * Compact token count: `12345` → `12.3K`, `1234567` → `1.23M`.
     *
     * Uppercase units and one decimal up to the hundreds, which is the shape
     * the usage card the user is replacing already renders (`34.4M tokens`), so
     * the two read alike wherever both are on screen.
     * @param {number} value - the token count.
     * @returns {string} the compact form.
     */
    function formatTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0'
      if (value < 1000) return String(Math.round(value))
      if (value < 1_000_000) return `${trim(value / 1000)}K`
      if (value < 1_000_000_000) return `${trim(value / 1_000_000)}M`
      return `${trim(value / 1_000_000_000)}B`
    }

    /** `HH:MM` in the user's locale, or an empty string when unformattable. */
    function formatClock(ms) {
      try {
        return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      } catch {
        return ''
      }
    }

    /** `M-D` for a `YYYY-MM-DD` key. */
    function shortDate(key) {
      const parts = String(key).split('-')
      return parts.length === 3 ? `${Number(parts[1])}-${Number(parts[2])}` : String(key)
    }

    /** Today's local-date key, matching the host's day bucketing. */
    function todayKey() {
      const now = new Date()
      const month = String(now.getMonth() + 1).padStart(2, '0')
      const day = String(now.getDate()).padStart(2, '0')
      return `${now.getFullYear()}-${month}-${day}`
    }

    /**
     * A local-date key shifted by whole days.
     *
     * Goes through the local `Date` constructor rather than adding 86 400 000 ms,
     * so a DST boundary cannot land the result on the wrong day, and formats the
     * result exactly like {@link todayKey} so the two compare as plain strings.
     * @param {string} key - the `YYYY-MM-DD` key to shift.
     * @param {number} deltaDays - whole days to add; negative goes back.
     * @returns {string} the shifted key.
     */
    function shiftDayKey(key, deltaDays) {
      const parts = String(key).split('-').map(Number)
      const date = new Date(parts[0], (parts[1] ?? 1) - 1, parts[2] ?? 1)
      date.setDate(date.getDate() + deltaDays)
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `${date.getFullYear()}-${month}-${day}`
    }

    /** Billed tokens of one bucket set: every disjoint input bucket plus output. */
    function totalOf(totals) {
      if (totals === null || typeof totals !== 'object') return 0
      return (totals.inputTokens ?? 0) + (totals.cacheReadTokens ?? 0) + (totals.cacheWriteTokens ?? 0) + (totals.outputTokens ?? 0)
    }

    /** An all-zero bucket, for the paths that render before any data arrives. */
    function zeroTotals() {
      return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, calls: 0 }
    }

    //#endregion

    //#region ------------------------------------------------------------ styles

    const STYLE_ID = 'dsh-usage-stat-styles'

    /**
     * The plugin's whole stylesheet, injected once.
     *
     * Everything is scoped by the `dus-` class prefix and every colour comes
     * from a `--dsw-*` theme token (or `currentColor`), so the card, the pill
     * and the settings page follow the active theme and skin — including a
     * user skin that remaps those tokens — instead of fighting them.
     */
    const CSS = `
.dus-foot{position:relative;box-sizing:border-box;width:100%;margin:2px 0 4px;border:none;border-radius:var(--dsw-radius-sm,10px);background:transparent;color:inherit;transition:background-color 120ms ease}
.dus-foot:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent))}
.dus-foot-main{appearance:none;box-sizing:border-box;display:flex;flex-direction:column;gap:4px;width:100%;padding:8px;border:none;border-radius:var(--dsw-radius-sm,10px);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dus-foot-main:focus-visible{outline:none;box-shadow:0 0 0 var(--dsw-focus-ring-width,2px) color-mix(in srgb,currentColor 45%,transparent)}
.dus-foot-main svg,.dus-foot-title svg{display:block}
.dus-foot-head{display:flex;align-items:baseline;gap:6px;min-width:0}
.dus-foot-title{display:inline-flex;align-items:center;gap:6px;min-width:0;flex:0 2 auto;overflow:hidden;font-size:12px;opacity:.65;white-space:nowrap;text-overflow:ellipsis}
.dus-foot-title svg{flex:none}
/* The figure takes the right edge and the chevron trails it, so the line reads
   label-left / value-right like every other row in the sidebar. Pushing the
   chevron instead would strand the number in the middle of the row. */
.dus-foot-value{flex:0 1 auto;margin-left:auto;min-width:0;max-width:100%;overflow:hidden;font-size:15px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;text-overflow:ellipsis}
.dus-foot-chevron{flex:none;display:inline-flex;align-items:center;opacity:.45;transition:transform 140ms ease}
.dus-foot:hover .dus-foot-chevron{opacity:.75}
.dus-foot-chevron[data-expanded="true"]{transform:rotate(180deg)}
.dus-foot-line{font-size:11px;opacity:.7;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dus-foot-meta{font-size:10px;opacity:.5;font-variant-numeric:tabular-nums}
.dus-foot-detail{display:flex;flex-direction:column;gap:10px;margin-top:2px;padding-top:7px;border-top:.5px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 12%,transparent))}
.dus-row{display:flex;align-items:baseline;gap:6px;font-size:11px;line-height:14px;min-width:0}
.dus-row-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dus-row-value{flex:none;font-variant-numeric:tabular-nums;opacity:.85}
.dus-row-provider .dus-row-name{font-weight:500}
/* A provider is a block — its line, its share bar, its models — so the groups
   stay legible in a rail this narrow. The bar is full width rather than an
   inline stub: at 34px it read as a stray dash sitting in front of the name. */
.dus-foot-provider{display:flex;flex-direction:column;gap:4px}
.dus-share{display:block;height:3px;border-radius:999px;background:color-mix(in srgb,currentColor 12%,transparent);overflow:hidden}
.dus-share > i{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary,currentColor);opacity:.5}
.dus-foot-models{display:flex;flex-direction:column;gap:3px;padding-left:9px;border-left:.5px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 12%,transparent))}
.dus-row-model{opacity:.62}
.dus-foot-more{font-size:10px;opacity:.5}

/* Collapsed rail: the 56px sidebar has no room for a card. */
[data-sidebar-collapsed] .dus-foot{display:none}

/* Composer dock pill: matches the shell's own stats pills exactly, because it
   sits in the same flex row and any deviation reads as a seam. The font size
   and line height are restated rather than inherited: the shell sets them on
   its own stats container, which is a sibling of this entry, not an ancestor. */
.dus-pill{box-sizing:border-box;corner-shape:round;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));font-variant-numeric:tabular-nums;white-space:nowrap;background:0 0;border:none;border-radius:999px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}
.dus-pill:hover,.dus-pill[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dus-pill svg{display:block;flex:none}
.dus-pill-value{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}

/* The pill's own box in the dock row. The row's flex gap lands here now that
   the pill is wrapped with its panel, so this has to be the flex item. */
.dus-meter-root{position:relative;flex:none;display:inline-flex;min-width:0}

/* The panel the composer pill opens. Every value here is the one the shell's
   own context meter uses on its panel — same menu fill, same backdrop filter,
   same prominent elevation, same radius and metrics — because these two panels
   can be open at the same moment and any deviation would read as a seam. */
.dus-meter{position:fixed;z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2,currentColor));width:min(264px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter,none);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgb(0 0 0/.18));color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:12px;font-size:12px;line-height:20px}
.dus-meter-head{align-items:center;gap:6px;display:flex}
.dus-meter-title{color:var(--dsw-alias-label-tertiary)}
.dus-meter-figures{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin-left:auto;font-weight:500}
.dus-meter-bar{corner-shape:round;background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;gap:1px;height:4px;margin:10px 0 12px;display:flex;overflow:hidden}
.dus-meter-segment{background:var(--dus-tint,var(--dsw-alias-label-tertiary));border-radius:1px;flex:none;min-width:2px;height:100%}
.dus-meter-rows{margin:6px 0 0}
.dus-meter-row{justify-content:space-between;align-items:center;gap:12px;padding:2px 0;display:flex}
.dus-meter-row dt{color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dus-meter-row dd{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin:0;flex:none}
.dus-meter-model dt{color:var(--dsw-alias-label-tertiary);padding-left:14px}
.dus-meter-model dd{color:var(--dsw-alias-label-secondary)}
.dus-meter-swatch{background:var(--dus-tint,var(--dsw-alias-label-tertiary));vertical-align:baseline;border-radius:2px;width:8px;height:8px;margin-right:6px;display:inline-block}
.dus-meter-note{color:var(--dsw-alias-label-tertiary);padding:2px 0;word-break:break-word}
/* Bar and swatch tints. Six hues the shell itself ships, each falling back to a
   label colour so a renamed static token degrades to a readable monochrome
   meter instead of an invisible one. */
.dus-tint-0{--dus-tint:var(--dsw-static-deepseek-450,var(--dsw-alias-label-secondary))}
.dus-tint-1{--dus-tint:var(--dsw-static-blue-450,var(--dsw-alias-label-secondary))}
.dus-tint-2{--dus-tint:var(--dsw-static-amber-400,var(--dsw-alias-label-secondary))}
.dus-tint-3{--dus-tint:var(--dsw-static-green-500,var(--dsw-alias-label-secondary))}
.dus-tint-4{--dus-tint:var(--dsw-static-neutral-bluish-400,var(--dsw-alias-label-secondary))}
.dus-tint-5{--dus-tint:var(--dsw-static-red-400,var(--dsw-alias-label-secondary))}

/* Settings section */
.dus-section{display:flex;flex-direction:column;gap:16px;min-width:0;color:var(--dsw-alias-label-primary)}
.dus-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
/* Title and freshness stack as one lockup, so the button beside them lines up
   with the title's own cap height instead of floating in the middle of the
   pair. The shape is the shell settings dialog's page title (a heading above a
   dimmed line of metadata), carried one step heavier than the dialog's own
   16px/500: the cards under it title themselves at 14px/500, and a heading that
   sits that close to its own card titles reads as another card title. */
.dus-head-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.dus-head-title{font-size:18px;font-weight:600;line-height:26px;letter-spacing:.01em;color:var(--dsw-alias-label-primary)}
.dus-head-sub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dus-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:none}
.dus-button{appearance:none;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l3,color-mix(in srgb,currentColor 22%,transparent));border-radius:var(--dsw-radius-md,10px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;transition:background-color 120ms ease,border-color 120ms ease}
.dus-button:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent))}
.dus-button:focus-visible{outline:none;box-shadow:0 0 0 var(--dsw-focus-ring-width,2px) color-mix(in srgb,currentColor 45%,transparent)}
.dus-button[disabled]{opacity:.4;cursor:default}
/* The save button is the only filled control on the page: the shell reserves
   its primary fill for the one action it wants the reader to take. */
.dus-button-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,currentColor));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-label-primary))}
.dus-button-primary:hover{background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,currentColor))}
.dus-button-primary[disabled]{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,currentColor))}
.dus-tabs{display:flex;align-items:center;gap:4px;border-bottom:.5px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 12%,transparent))}
.dus-tab{appearance:none;position:relative;padding:8px 12px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;border-radius:var(--dsw-radius-sm,8px) var(--dsw-radius-sm,8px) 0 0}
.dus-tab:hover{color:var(--dsw-alias-label-secondary)}
.dus-tab[aria-selected="true"]{color:var(--dsw-alias-brand-text,var(--dsw-alias-label-primary))}
/* The selected tab's mark spans the tab exactly and sits on the row's own
   hairline, so the two read as one line that thickens and takes the brand
   colour rather than as two bars of different lengths. The radius and the
   un-bolded weight follow dsh's own settings tabs (ui-settings-plugins). */
.dus-tab[aria-selected="true"]::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-brand-primary,currentColor)}
.dus-tab:focus-visible{outline:none;box-shadow:0 0 0 var(--dsw-focus-ring-width,2px) color-mix(in srgb,currentColor 45%,transparent)}
.dus-card{display:flex;flex-direction:column;gap:12px;padding:12px 16px;border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 14%,transparent)));border-radius:var(--dsw-radius-xl,16px);background:var(--dsw-alias-settings-card-fill,transparent)}
.dus-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dus-card-title{font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}
.dus-card-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dus-select{appearance:none;height:26px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 18%,transparent));border-radius:var(--dsw-radius-xs,6px);background:var(--dsw-alias-bg-layer-2,transparent);color:inherit;font:inherit;font-size:12px;cursor:pointer}
/* The summary strip. Six figures strung along the left of a wide card read as
   cramped and leave the right half of the card empty, so each one owns an equal
   column and a hairline separates them: the figures then describe the whole card
   instead of huddling in its corner. */
.dus-metrics{display:flex;align-items:flex-start;padding:14px 0 2px;border-top:.5px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 10%,transparent))}
.dus-metric{display:flex;flex-direction:column;gap:3px;flex:1 1 0;min-width:0;padding:0 14px}
.dus-metric:first-child{padding-left:0}
.dus-metric + .dus-metric{border-left:.5px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 10%,transparent))}
.dus-metric-value{font-size:20px;font-weight:600;font-variant-numeric:tabular-nums;line-height:26px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dus-metric-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dus-list{display:flex;flex-direction:column;gap:10px}
.dus-provider{display:flex;flex-direction:column;gap:6px}
.dus-provider-head{display:flex;align-items:baseline;gap:8px;font-size:12px}
.dus-badge{flex:none;padding:0 5px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 10%,transparent));color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px}
/* The low-quota reminder dot. It is the one place this plugin deliberately
   leaves the shell's own palette: a warning that inherits the theme's ink would
   not read as a warning. The static red token is a shell token, so it still
   follows the theme, and the fallback keeps the dot visible if the token is
   ever renamed rather than silently dropping the mark. */
.dus-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-static-red-400,currentColor);align-self:center}
.dus-provider-total{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
/* One grid per model row, but a *fixed* name column, so every bar on the card
   starts on the same x no matter how long the model name is. A flex row sized
   its own leading column per row, which pushed each bar to a different left
   edge. */
.dus-model{display:grid;grid-template-columns:var(--dus-model-name,132px) minmax(0,1fr) 52px;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dus-model-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dus-model-bar{height:4px;border-radius:999px;background:color-mix(in srgb,currentColor 10%,transparent);overflow:hidden;min-width:20px}
.dus-model-bar > i{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary,currentColor);opacity:.55}
.dus-model-total{font-variant-numeric:tabular-nums;text-align:right}
/* Balance rows and plan windows: a name column, a value column, and the same
   4px share bar the usage tab draws, so all three tabs read as one surface. */
.dus-stack{display:flex;flex-direction:column;gap:12px}
.dus-vendor-row{display:flex;align-items:baseline;gap:8px;font-size:12px}
.dus-vendor-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dus-vendor-value{margin-left:auto;flex:none;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
/* One grid per provider, not one flex row per window: the columns then line up
   across the windows of that provider no matter how long each reset stamp is.
   The last column is auto, which grid resolves once for the whole container —
   that is the part a per-row flex box cannot do. */
.dus-windows{display:grid;grid-template-columns:60px minmax(0,1fr) 40px auto;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dus-window{display:contents}
.dus-window-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.dus-window-percent{text-align:right;font-variant-numeric:tabular-nums}
.dus-window-reset{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.dus-plan-block{display:flex;flex-direction:column;gap:8px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 12%,transparent))}
.dus-plan-block:first-child{padding-top:0;border-top:none}
/* The collapsed tail of the account tab: every provider whose facts could not
   be fetched. A disclosure rather than a card, because it answers "why is my
   provider missing" — it is not a number anyone reads twice. */
.dus-fold{border-top:.5px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 12%,transparent))}
.dus-fold-summary{display:flex;align-items:center;gap:6px;padding-top:8px;font-size:12px;color:var(--dsw-alias-label-tertiary);cursor:pointer;list-style:none}
.dus-fold-summary::-webkit-details-marker{display:none}
.dus-fold-summary::before{content:"▸";flex:none;font-size:10px;transition:transform 140ms ease}
.dus-fold[open] > .dus-fold-summary::before{transform:rotate(90deg)}
.dus-fold-body{display:flex;flex-direction:column;gap:8px;padding-top:8px}
/* Settings panels. The shell's own settings pages put one topic in one card,
   name the topic on its own line, and give every setting a row underneath:
   what it is on the left, the control on the right, the explanation under the
   name. These classes are that shape, at the dialog's own metrics
   (--dsw-radius-xl card, 40px rows, 32px controls, .5px border-l4 inputs). */
.dus-panel{display:flex;flex-direction:column;padding:12px 16px;border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 14%,transparent)));border-radius:var(--dsw-radius-xl,16px);background:var(--dsw-alias-settings-card-fill,transparent)}
.dus-panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:32px}
.dus-panel-title{font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}
.dus-panel-note{padding:2px 0 4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dus-form-row{display:grid;grid-template-columns:1fr auto;align-items:center;gap:16px;min-height:40px;padding:6px 0}
.dus-form-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.dus-form-label{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.dus-form-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dus-form-control{display:flex;align-items:center;justify-content:flex-end;gap:6px}
.dus-suffix{flex:none;width:12px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dus-trend{display:flex;flex-direction:column;gap:8px}
.dus-trend-axis{display:flex;justify-content:space-between;font-size:10px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
/* Per-day bars for the selected range. Each column is a flex child so a
   180-day window stays legible by simply getting thinner, with no scrolling.
   The row never overflows: a window longer than CHART_MAX_DAYS is drawn from
   its most recent days only, so the columns keep a floor width. */
.dus-chart{display:flex;align-items:flex-end;gap:2px;height:104px;padding-top:4px;overflow:hidden;border-bottom:.5px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 10%,transparent))}
.dus-chart-col{flex:1;min-width:2px;height:100%;display:flex;align-items:flex-end;border-radius:2px}
.dus-chart-col:hover{background:color-mix(in srgb,currentColor 8%,transparent)}
.dus-chart-bar{width:100%;min-height:2px;border-radius:2px;background:var(--dsw-alias-brand-primary,currentColor);opacity:.6}
.dus-chart-col:hover .dus-chart-bar{opacity:.9}
.dus-ranges{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dus-range{appearance:none;height:26px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 18%,transparent));border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.dus-range:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent))}
/* The picked range is the one filled control on the page, so its label takes
   the on-brand foreground. It used to take --dsw-alias-brand-text, which is the
   brand colour *as ink* — the same near-black the fill is — and the label
   vanished on a stock theme (only a skin that remaps the brand colour hid the
   mistake). --dsw-alias-label-primary-foreground is the token that means "text
   on a brand fill". */
.dus-range[aria-pressed="true"]{background:var(--dsw-alias-brand-primary,color-mix(in srgb,currentColor 16%,transparent));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,var(--dsw-static-neutral-bluish-00,#fff));font-weight:600}
.dus-range:focus-visible{outline:none;box-shadow:0 0 0 var(--dsw-focus-ring-width,2px) color-mix(in srgb,currentColor 45%,transparent)}
.dus-range-dates{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dus-empty{padding:10px 0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dus-field{display:flex;align-items:center;gap:10px;font-size:12px}
.dus-field-label{flex:1;min-width:0;color:var(--dsw-alias-label-secondary)}
.dus-input{box-sizing:border-box;width:132px;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4,color-mix(in srgb,currentColor 26%,transparent));border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;font-variant-numeric:tabular-nums}
.dus-input:focus{border-color:var(--dsw-alias-state-business-primary,currentColor);outline:none;box-shadow:0 0 0 var(--dsw-focus-ring-width,2px) color-mix(in srgb,currentColor 22%,transparent)}
/* Numbers sit on the right edge of their control so the digits line up down
   the column, which is the whole point of a column of numbers. */
.dus-form-row .dus-input{text-align:right}
.dus-check{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary,currentColor);cursor:pointer}
.dus-note{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:16px}
.dus-version{margin-right:auto;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-dimmed));font-variant-numeric:tabular-nums}
.dus-note code{font-family:var(--dsw-font-markdown-code-font-family,monospace);font-size:11px;padding:1px 4px;border-radius:4px;background:var(--dsw-alias-markdown-inline-code,color-mix(in srgb,currentColor 10%,transparent))}
`

    /** Inject the stylesheet once per page. */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.append(style)
    }

    //#endregion

    //#region --------------------------------------------------------------- api

    /**
     * Host calls. Paths are document-relative on purpose: the GUI is served
     * with `<base href="./">`, so a leading slash would escape a sub-path
     * deployment. The host registers the same paths *with* a leading slash.
     */
    /**
     * Read one field out of a response body, refusing to pass on a non-object.
     *
     * A 200 with an unexpected shape is not an empty answer, it is a broken one —
     * and returning `undefined` here would let it travel into component state and
     * blow up somewhere far away from the request that caused it.
     * @param {unknown} body - the parsed response body.
     * @param {string} key - the envelope key this route promises.
     * @returns {object} the promised document.
     */
    function field(body, key) {
      const value = body === null || typeof body !== 'object' ? undefined : body[key]
      if (value === null || typeof value !== 'object') throw new Error(`${key}: unexpected response`)
      return value
    }

    const api = {
      /** @returns {Promise<object>} the overview document. */
      async overview() {
        const response = await fetch('api/usage-stat/overview', { signal: AbortSignal.timeout(20_000) })
        if (!response.ok) throw new Error(`overview ${response.status}`)
        return field(await response.json(), 'overview')
      },
      /**
       * @param {string} date - a `YYYY-MM-DD` local date.
       * @returns {Promise<object>} that day's detail.
       */
      async day(date) {
        const response = await fetch(`api/usage-stat/day?date=${encodeURIComponent(date)}`, { signal: AbortSignal.timeout(20_000) })
        if (!response.ok) throw new Error(`day ${response.status}`)
        return field(await response.json(), 'day')
      },
      /**
       * An arbitrary window, aggregated per provider and per day. Both ends are
       * inclusive; an empty string means "open-ended at that end".
       * @param {string} from - the first local-date key.
       * @param {string} to - the last local-date key.
       * @returns {Promise<object>} the range view.
       */
      async range(from, to) {
        const query = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
        const response = await fetch(`api/usage-stat/range?${query}`, { signal: AbortSignal.timeout(20_000) })
        if (!response.ok) throw new Error(`range ${response.status}`)
        return field(await response.json(), 'range')
      },
      /** @returns {Promise<object>} a freshly assembled overview. */
      async refresh() {
        const response = await fetch('api/usage-stat/refresh', { method: 'POST', signal: AbortSignal.timeout(20_000) })
        if (!response.ok) throw new Error(`refresh ${response.status}`)
        return field(await response.json(), 'overview')
      },
      /**
       * One conversation's totals and its own per-provider, per-model
       * breakdown. Fetched on demand — the composer badge only asks when its
       * panel is opened, so a closed panel costs nothing.
       * @param {string} sessionId - the session id from the slot's props.
       * @returns {Promise<object>} the session view.
       */
      async session(sessionId) {
        const response = await fetch(`api/usage-stat/session?id=${encodeURIComponent(sessionId)}`, { signal: AbortSignal.timeout(20_000) })
        if (!response.ok) throw new Error(`session ${response.status}`)
        return field(await response.json(), 'session')
      },
      /** @returns {Promise<object>} the cached vendor facts. */
      async providers() {
        const response = await fetch('api/usage-stat/providers', { signal: AbortSignal.timeout(20_000) })
        if (!response.ok) throw new Error(`providers ${response.status}`)
        return field(await response.json(), 'providers')
      },
      /**
       * Probe the vendor endpoints now and return the fresh snapshot.
       *
       * This is the one call that makes the host reach the network, so it gets a
       * longer budget than a read: a cold cycle may query several vendors.
       * @returns {Promise<object>} the refreshed vendor facts.
       */
      async probe() {
        const response = await fetch('api/usage-stat/probe', { method: 'POST', signal: AbortSignal.timeout(60_000) })
        if (!response.ok) throw new Error(`probe ${response.status}`)
        return field(await response.json(), 'providers')
      },
      /**
       * Replay the sessions DSH saved, and return the tally.
       *
       * Reading the logs takes a moment but no network, so it gets a budget
       * between a plain read and a vendor probe.
       * @returns {Promise<object>} `{ files, events, skipped }`.
       */
      async backfill() {
        const response = await fetch('api/usage-stat/backfill', { method: 'POST', signal: AbortSignal.timeout(60_000) })
        if (!response.ok) throw new Error(`backfill ${response.status}`)
        return field(await response.json(), 'backfill')
      },
      /**
       * @param {object} patch - the partial config update.
       * @returns {Promise<object>} the config after the update.
       */
      async saveConfig(patch) {
        const response = await fetch('api/usage-stat/config', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
          signal: AbortSignal.timeout(20_000),
        })
        if (!response.ok) throw new Error(`config ${response.status}`)
        return (await response.json()).config
      },
    }

    //#endregion

    //#region ------------------------------------------------------------- store

    /**
     * One shared overview snapshot for the card and the settings section.
     * A hand-rolled external store (rather than a React context) because the
     * foot card lives in its own React root outside the shell's tree.
     * @returns {object} the store.
     */
    function createOverviewStore() {
      let snapshot = { status: 'loading', overview: null, error: null }
      const listeners = new Set()
      const emit = () => {
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch {
            // One bad subscriber must not stop the others.
          }
        }
      }
      return {
        /** @param {() => void} listener - the subscriber. @returns {() => void} the disposer. */
        subscribe(listener) {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        /** @returns {object} the current snapshot (stable identity between changes). */
        getSnapshot() {
          return snapshot
        },
        /** @param {object} next - the new snapshot. */
        set(next) {
          snapshot = next
          emit()
        },
      }
    }

    //#endregion

    //#region ----------------------------------------------------------- polling

    /**
     * The single poll loop: a `setTimeout` chain rather than `setInterval`, so
     * a changed `pollIntervalSec` takes effect on the very next tick and a slow
     * host can never stack requests. A hidden tab pauses entirely.
     *
     * Two details keep the loop genuinely single. `schedule` clears whatever
     * timer is armed before arming the next one, so even if two paths reach it
     * only one chain stays alive; and `running` refuses a concurrent tick,
     * because a tick can be awaiting the (≤20 s) fetch when the tab is shown
     * again and `clearTimeout` cannot cancel a timer that already fired. Both
     * are load-bearing: without them the older chain stays armed but untracked
     * and the host receives two requests per interval until the page reloads.
     * @param {object} store - the overview store.
     * @returns {() => void} the disposer.
     */
    function startPolling(store) {
      let timer
      let disposed = false
      let running = false

      const load = async () => {
        try {
          const overview = await api.overview()
          if (disposed) return
          store.set({ status: 'ready', overview, error: null })
        } catch (error) {
          if (disposed) return
          const current = store.getSnapshot()
          store.set({ status: 'error', overview: current.overview, error: error instanceof Error ? error.message : String(error) })
        }
      }

      const schedule = () => {
        if (disposed) return
        if (timer !== undefined) window.clearTimeout(timer)
        const seconds = store.getSnapshot().overview?.config?.pollIntervalSec
        const interval = (typeof seconds === 'number' && seconds >= 5 ? seconds : 30) * 1000
        timer = window.setTimeout(tick, interval)
      }

      const runOnce = async () => {
        if (disposed || running) return
        running = true
        try {
          await load()
        } finally {
          running = false
        }
      }

      const tick = async () => {
        if (disposed) return
        if (document.visibilityState === 'visible') await runOnce()
        schedule()
      }

      const onVisibility = () => {
        if (disposed || running) return
        if (document.visibilityState === 'visible') {
          if (timer !== undefined) {
            window.clearTimeout(timer)
            timer = undefined
          }
          void tick()
        }
      }

      // The first load is unconditional: a tab that starts hidden still needs
      // its card populated for the moment it is shown.
      void runOnce().then(schedule)
      document.addEventListener('visibilitychange', onVisibility)
      return () => {
        disposed = true
        if (timer !== undefined) window.clearTimeout(timer)
        document.removeEventListener('visibilitychange', onVisibility)
      }
    }

    //#endregion

    //#region ------------------------------------------------------------- icons

    /** A 14px gauge, the card's and the pill's mark. */
    function GaugeIcon(props) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: props?.size ?? 14,
          height: props?.size ?? 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: 'M2.5 12.5a7 7 0 0 1 11 -4.3' }),
        h('path', { d: 'M8 12.5V8.2l2.9-2.1' }),
        h('circle', { cx: 8, cy: 12.5, r: 1 }),
      )
    }

    /** The disclosure chevron: down expands, up collapses. */
    function ChevronIcon(props) {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: 12,
          height: 12,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
        },
        h('path', { d: props?.expanded === true ? 'm4 10 4-4 4 4' : 'm4 6 4 4 4-4' }),
      )
    }

    //#endregion

    //#region ----------------------------------------------------------- foot card

    /** localStorage key holding the card's expanded flag. */
    const FOOT_EXPANDED_KEY = 'dsh-usage-stat.foot-card.expanded'

    /** How many providers the expanded card lists before pointing at settings. */
    const FOOT_PROVIDER_CAP = 3

    /** How many model rows one listed provider shows. */
    const FOOT_MODEL_CAP = 2

    /** How many unconfigured providers the account tab names before counting the rest. */
    const CATALOG_CAP = 6

    /** Read the persisted expansion flag (default: collapsed, one quiet line). */
    function readFootExpanded() {
      try {
        return window.localStorage.getItem(FOOT_EXPANDED_KEY) === '1'
      } catch {
        return false
      }
    }

    /** Persist the expansion flag; a storage failure keeps the session state. */
    function writeFootExpanded(expanded) {
      try {
        window.localStorage.setItem(FOOT_EXPANDED_KEY, expanded ? '1' : '0')
      } catch {
        // Storage unavailable; the state still flips for this page.
      }
    }

    /**
     * One `name — value` row, optionally with a share bar and a reminder dot.
     *
     * `dot` is the dot's tooltip text: present means "this provider has a fact
     * below a threshold you set", absent means nothing to say. The reason
     * travels with the mark so a dot is never a mystery the user has to go
     * digging to explain.
     */
    function UsageRow(props) {
      return h(
        'div',
        { className: `dus-row${props.variant === undefined ? '' : ` ${props.variant}`}` },
        props.dot === undefined ? null : h(AlertDot, { title: props.dot }),
        h('span', { className: 'dus-row-name', title: props.title ?? props.name }, props.name),
        h('span', { className: 'dus-row-value' }, props.value),
      )
    }

    /**
     * The sidebar foot card.
     *
     * Collapsed (the default) it is one quiet line — mark, label, total — so
     * the sidebar foot keeps its shape. Expanded it lists today's per-provider
     * and per-model tokens, which is the whole point of the card: the numbers
     * the settings page shows, reachable without opening anything.
     */
    function FootCard(props) {
      const { store } = props
      const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
      const [expanded, setExpanded] = useState(readFootExpanded)

      // The write stays outside the updater: React may invoke an updater more
      // than once (StrictMode, a replayed concurrent render), and a side effect
      // in there is not guaranteed to run once per click.
      const toggle = useCallback(() => {
        const next = !expanded
        writeFootExpanded(next)
        setExpanded(next)
      }, [expanded])

      const overview = snapshot.overview
      const enabled = overview?.config?.enabled ?? true
      if (!enabled) return null
      // A missing host half means no route at all: bow out rather than pin an
      // error to the sidebar foot forever.
      if (overview === null && snapshot.status === 'error') {
        return h(
          'div',
          { className: 'dus-foot', 'data-dsh-plugin': 'usage-stat', 'data-dsh-part': 'foot-card' },
          h('div', { className: 'dus-foot-main', style: { cursor: 'default' } },
            h('span', { className: 'dus-foot-head' },
              h('span', { className: 'dus-foot-title' }, h(GaugeIcon), t('title')),
              h('span', { className: 'dus-foot-value' }, '—')),
            h('span', { className: 'dus-foot-line' }, t('hostOff'))),
        )
      }

      const today = overview?.usage?.today ?? { date: todayKey(), totals: zeroTotals(), providers: [] }
      const total = totalOf(today.totals)
      const calls = today.totals.calls ?? 0
      const updated = overview === null ? '' : formatClock(overview.updatedAt)

      // A reminder must not be able to hide behind the cap: the heaviest
      // providers are shown, and any provider the user asked to be warned about
      // is shown alongside them even when it ranks below the cut. The card grows
      // by a row or two in exactly the case where that is the point.
      const alertIndex = alertsIndex(overview?.alerts)
      const providers = today.providers.slice(0, FOOT_PROVIDER_CAP)
      for (const row of today.providers) {
        if (providers.includes(row) || !alertIndex.has(row.provider)) continue
        providers.push(row)
      }
      const heaviest = today.providers[0] === undefined ? 1 : Math.max(1, totalOf(today.providers[0].totals))
      const hiddenProviders = Math.max(0, today.providers.length - providers.length)
      // The header is one line in a rail that can be narrow, and a large total
      // ("999.9B tokens") plus a call count plus a title does not always fit. The
      // row degrades by priority — the title ellipsizes, then the call count
      // drops, and the number itself is the last thing to give up — and the full
      // reading stays available as a tooltip either way.
      const headline = `${t('today')} ${formatTokens(total)} tokens${calls === 0 ? '' : ` · ${t('callsShort', { n: calls })}`}`

      const detail = expanded
        ? h(
            'div',
            { className: 'dus-foot-detail' },
            providers.length === 0
              ? h('span', { className: 'dus-foot-line' }, t('noData'))
              : providers.map((provider) => {
                  const value = totalOf(provider.totals)
                  const models = (provider.models ?? []).slice(0, FOOT_MODEL_CAP)
                  return h(
                    'div',
                    { key: provider.provider, className: 'dus-foot-provider' },
                    h(UsageRow, {
                      name: provider.displayName ?? provider.provider,
                      value: formatTokens(value),
                      variant: 'dus-row-provider',
                      dot: dotFor(alertIndex, provider.provider),
                    }),
                    h('span', { className: 'dus-share' }, h('i', { style: { width: `${Math.round((value / heaviest) * 100)}%` } })),
                    models.length === 0 ? null : h(
                      'div',
                      { className: 'dus-foot-models' },
                      models.map((model) => h(UsageRow, {
                        key: `${provider.provider}:${model.model}`,
                        name: model.model,
                        value: formatTokens(totalOf(model.totals)),
                        variant: 'dus-row-model',
                      })),
                    ),
                  )
                }),
            hiddenProviders > 0 ? h('span', { className: 'dus-foot-more' }, t('more', { n: hiddenProviders })) : null,
          )
        : null

      return h(
        'div',
        { className: 'dus-foot', 'data-dsh-plugin': 'usage-stat', 'data-dsh-part': 'foot-card' },
        h(
          'button',
          {
            type: 'button',
            className: 'dus-foot-main',
            'data-dsh-part': 'foot-card-main',
            'aria-expanded': expanded,
            'aria-label': expanded ? t('collapse') : t('expand'),
            title: headline,
            onClick: toggle,
          },
          h(
            'span',
            { className: 'dus-foot-head' },
            h('span', { className: 'dus-foot-title' }, h(GaugeIcon), t('today')),
            h('span', { className: 'dus-foot-value' }, `${formatTokens(total)} tokens`),
            // The chevron is the header row's only affordance and it only
            // toggles. An icon that opened the settings panel instead read as a
            // second account button, which is not what a chevron promises.
            h('span', { className: 'dus-foot-chevron', 'data-expanded': expanded }, h(ChevronIcon, { expanded })),
          ),
          detail,
          // The call count and the fold time are detail, so the rail keeps the
          // one number that answers "how much today" and nothing else. The
          // count is still in the button's tooltip, for a hover without a click.
          expanded
            ? h(
                'span',
                { className: 'dus-foot-meta' },
                calls === 0 ? '' : `${t('callsShort', { n: calls })}${updated === '' ? '' : ' · '}`,
                updated === '' ? '' : t('updated', { time: updated }),
              )
            : null,
        ),
      )
    }

    //#endregion

    //#region -------------------------------------------------------- session pill

    /**
     * Bar and swatch tints, in segment order. Six hues the shell itself ships,
     * so the meter matches the palette of the panel next to it instead of
     * introducing colours of its own.
     */
    const PROVIDER_TINTS = ['dus-tint-0', 'dus-tint-1', 'dus-tint-2', 'dus-tint-3', 'dus-tint-4', 'dus-tint-5']

    /**
     * The tint class for the nth provider row. Wraps around rather than
     * stopping, so the seventh vendor still gets a colour.
     * @param {number} index - the row's position in the bar.
     * @returns {string} the tint class.
     */
    function tintOf(index) {
      return PROVIDER_TINTS[index % PROVIDER_TINTS.length]
    }

    /** Gap between the trigger and the panel, and the viewport margin it respects. */
    const PANEL_GAP = 8
    const PANEL_MARGIN = 12
    /** Used for the first measurement, before the panel has a width of its own. */
    const PANEL_FALLBACK_WIDTH = 264

    /**
     * Where the panel goes: centred on the trigger, above it when there is
     * room and below it when there is not, clamped to the viewport on both
     * axes. The shell's context meter opens its panel the same way, so the two
     * never disagree about where "above the composer" is.
     *
     * Returns `null` until it has measured; the panel renders hidden until
     * then rather than flashing at the origin.
     * @param {boolean} open - whether the panel is open.
     * @param {{ current: (Element|null) }} anchorRef - the trigger.
     * @param {{ current: (Element|null) }} panelRef - the panel.
     * @returns {{ left: number, top: number }|null} the fixed position, or null before the first measurement.
     */
    function useAnchoredPanel(open, anchorRef, panelRef) {
      const [position, setPosition] = useState(null)
      useEffect(() => {
        if (!open) {
          setPosition(null)
          return undefined
        }
        const place = () => {
          const anchor = anchorRef.current
          if (anchor === null || anchor === undefined) return
          const rect = anchor.getBoundingClientRect()
          const panel = panelRef.current
          const width = panel === null || panel === undefined || panel.offsetWidth === 0
            ? PANEL_FALLBACK_WIDTH
            : panel.offsetWidth
          const height = panel === null || panel === undefined ? 0 : panel.offsetHeight
          const viewportWidth = typeof window === 'undefined' ? 0 : window.innerWidth
          const viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight
          const maxLeft = Math.max(PANEL_MARGIN, viewportWidth - width - PANEL_MARGIN)
          const left = Math.min(Math.max(rect.left + rect.width / 2 - width / 2, PANEL_MARGIN), maxLeft)
          let top = rect.top - PANEL_GAP - height
          if (top < PANEL_MARGIN) top = rect.bottom + PANEL_GAP
          if (viewportHeight > 0) {
            top = Math.min(top, Math.max(PANEL_MARGIN, viewportHeight - height - PANEL_MARGIN))
          }
          setPosition({ left: Math.round(left), top: Math.round(top) })
        }
        place()
        window.addEventListener('resize', place)
        return () => window.removeEventListener('resize', place)
      }, [open, anchorRef, panelRef])
      return position
    }

    /**
     * Close the panel when the pointer goes down outside it, or on Escape.
     * The panel is portalled to `document.body`, so "outside" has to be
     * checked against the panel as well as the trigger.
     * @param {boolean} open - whether the panel is open.
     * @param {{ current: (Element|null) }} rootRef - the trigger.
     * @param {{ current: (Element|null) }} panelRef - the panel.
     * @param {() => void} close - the stable close callback.
     */
    function useDismiss(open, rootRef, panelRef, close) {
      useEffect(() => {
        if (!open) return undefined
        const contains = (ref, target) => {
          const node = ref.current
          return node !== null && node !== undefined && typeof node.contains === 'function' && node.contains(target)
        }
        const onPointerDown = (event) => {
          if (contains(rootRef, event.target) || contains(panelRef, event.target)) return
          close()
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') close()
        }
        document.addEventListener('pointerdown', onPointerDown)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open, rootRef, panelRef, close])
    }

    /**
     * The panel body: a proportional bar over the vendor rows, then the rows
     * themselves with each vendor's models nested under it.
     * @param {{ facts: object|null, error: string, loading: boolean, fallbackTotal: number }} props - the panel state.
     * @returns {object} the panel contents.
     */
    function SessionPanelBody(props) {
      const facts = props.facts
      const providers = facts === null || facts === undefined ? [] : (facts.providers ?? [])
      // Fall back to the projection's number when the host's document carries
      // no totals of its own, so a partly-shaped answer cannot make the panel
      // contradict the pill it hangs off.
      const total = facts === null || facts === undefined || facts.totals === undefined
        ? props.fallbackTotal
        : totalOf(facts.totals)
      const segments = providers
        .map((row, index) => ({ key: row.provider, tint: tintOf(index), share: total > 0 ? (totalOf(row.totals) / total) * 100 : 0 }))
        .filter((segment) => segment.share > 0)
      return [
        h(
          'div',
          { className: 'dus-meter-head', key: 'head' },
          h('span', { className: 'dus-meter-title' }, t('session')),
          h('span', { className: 'dus-meter-figures' }, `${formatTokens(total)} tokens`),
        ),
        h(
          'div',
          { className: 'dus-meter-bar', key: 'bar' },
          segments.map((segment) => h('div', {
            key: segment.key,
            className: `dus-meter-segment ${segment.tint}`,
            'data-dsh-part': 'session-segment',
            style: { width: `${segment.share}%` },
          })),
        ),
        h(
          'dl',
          { className: 'dus-meter-rows', key: 'rows' },
          sessionRows(props),
        ),
      ]
    }

    /**
     * The row list: one row per vendor, then every one of that vendor's models
     * indented under it. Model rows are always shown — the model name is half
     * of what the panel is for — even when a vendor has a single model and the
     * two numbers therefore agree.
     * @param {{ facts: object|null, error: string, loading: boolean }} props - the panel state.
     * @returns {object[]} the rows.
     */
    function sessionRows(props) {
      if (props.loading) {
        return [h('div', { className: 'dus-meter-note', key: 'loading' }, t('loading'))]
      }
      if (props.error !== '') {
        return [h('div', { className: 'dus-meter-note', key: 'error' }, `${t('error')} · ${props.error}`)]
      }
      const facts = props.facts
      if (facts === null || facts === undefined) {
        return [h('div', { className: 'dus-meter-note', key: 'idle' }, t('loading'))]
      }
      const providers = facts.providers ?? []
      if (providers.length === 0) {
        // The pill only renders when the projection reports usage, so an empty
        // breakdown means this conversation was recorded before the breakdown
        // existed — say so rather than implying the tokens are unattributed.
        return [h('div', { className: 'dus-meter-note', key: 'none' }, t('sessionNoBreakdown'))]
      }
      const rows = []
      providers.forEach((row, index) => {
        rows.push(h(
          'div',
          { className: 'dus-meter-row', key: `p-${row.provider}` },
          h('dt', null, h('span', { className: `dus-meter-swatch ${tintOf(index)}`, 'data-dsh-part': 'session-swatch', 'aria-hidden': true }), row.displayName ?? row.provider),
          h('dd', null, formatTokens(totalOf(row.totals))),
        ))
        for (const model of row.models ?? []) {
          rows.push(h(
            'div',
            { className: 'dus-meter-row dus-meter-model', key: `m-${row.provider}-${model.model}` },
            h('dt', null, model.model),
            h('dd', null, formatTokens(totalOf(model.totals))),
          ))
        }
      })
      return rows
    }

    /**
     * The current conversation's token badge, registered into
     * `conversation.composer.dock`.
     *
     * The closed pill reads the session's `tokenUsage` projection through the
     * slot's ambient `useProjection` prop, so it needs no host call: the number
     * the host folded is the number the shell already holds, and the badge can
     * never disagree with the per-turn usage row in the transcript.
     *
     * Clicking it opens the per-vendor, per-model breakdown of this
     * conversation, fetched on demand — a closed panel costs nothing. There is
     * deliberately no hover tooltip: a tooltip that repeats the panel's job is
     * a second, worse copy of it.
     */
    function SessionBadge(props) {
      const usage = props.useProjection('tokenUsage')
      const total = usage === undefined || usage === null
        ? 0
        : (usage.uncachedInputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + (usage.outputTokens ?? 0)
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const [open, setOpen] = useState(false)
      const [facts, setFacts] = useState(null)
      const [error, setError] = useState('')
      const [loading, setLoading] = useState(false)
      const rootRef = useRef(null)
      const panelRef = useRef(null)
      const close = useCallback(() => setOpen(false), [])
      const position = useAnchoredPanel(open, rootRef, panelRef)
      useDismiss(open, rootRef, panelRef, close)

      // Re-read while the panel is open and the conversation grows, so the
      // breakdown tracks the pill instead of freezing at the moment it opened.
      // `total` is the projection's own number, which only changes when a call
      // settles — not on every streamed chunk.
      useEffect(() => {
        if (!open || sessionId === '') return undefined
        let cancelled = false
        setLoading(true)
        setError('')
        api.session(sessionId).then(
          (next) => {
            if (cancelled) return
            setFacts(next)
            setLoading(false)
          },
          (reason) => {
            if (cancelled) return
            setFacts(null)
            setError(reason instanceof Error ? reason.message : String(reason))
            setLoading(false)
          },
        )
        return () => {
          cancelled = true
        }
      }, [open, sessionId, total])

      if (total <= 0) return null

      const label = `${t('session')} · ${formatTokens(total)} tokens`
      const trigger = h(
        'button',
        {
          type: 'button',
          ref: rootRef,
          className: 'dus-pill',
          'data-dsh-plugin': 'usage-stat',
          'data-dsh-part': 'session-pill',
          'aria-label': label,
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          disabled: sessionId === '',
          onClick: () => setOpen(!open),
        },
        h(GaugeIcon, { size: 12 }),
        h('span', null, t('session')),
        h('span', { className: 'dus-pill-value' }, `${formatTokens(total)} tokens`),
      )

      if (sessionId === '') return trigger

      const panel = open
        ? ReactDOM.createPortal(
            h(
              'div',
              {
                ref: panelRef,
                className: 'dus-meter',
                style: position === null ? { visibility: 'hidden', left: 0, top: 0 } : position,
                role: 'dialog',
                'aria-label': t('session'),
                'data-dsh-plugin': 'usage-stat',
                'data-dsh-part': 'session-panel',
              },
              h(SessionPanelBody, { facts, error, loading, fallbackTotal: total }),
            ),
            document.body,
          )
        : null

      return h('span', { className: 'dus-meter-root' }, trigger, panel)
    }

    //#endregion

    //#region ------------------------------------------------------ settings view

    /** One labelled number in the metrics strip. */
    function Metric(props) {
      return h(
        'div',
        { className: 'dus-metric' },
        h('div', { className: 'dus-metric-value' }, props.value),
        h('div', { className: 'dus-metric-label' }, props.label),
      )
    }

    /**
     * The heaviest model total across a set of provider rows.
     *
     * Every model bar inside one card shares this single denominator, so a bar
     * length means the same thing wherever it appears in that card and a small
     * provider reads as small. Normalizing per provider instead would draw the
     * top model of a 3 %-of-the-day provider at full width, which cannot be
     * read against its neighbours.
     * @param {Array<object>} providers - provider summaries.
     * @returns {number} the largest model total, floored at 1 so a division is safe.
     */
    function heaviestModel(providers) {
      let heaviest = 0
      for (const provider of providers ?? []) {
        for (const model of provider?.models ?? []) {
          const value = totalOf(model?.totals)
          if (value > heaviest) heaviest = value
        }
      }
      return Math.max(1, heaviest)
    }

    /**
     * One provider's block: the provider total, then its models as share bars.
     * @param {{ row: object, scale: number, current?: string }} props - the
     * provider summary, the card's shared bar scale, and the live route key
     * when this row is the one the Host is currently running on.
     */
    function ProviderBlock(props) {
      const { row, scale, current } = props
      return h(
        'div',
        { className: 'dus-provider' },
        h(
          'div',
          { className: 'dus-provider-head' },
          h('span', null, row.displayName ?? row.provider),
          // Only the live route is badged. Marking every row would make the
          // badge carry no information — and it is only meaningful on today's
          // card, so a past day passes `current: undefined`.
          current !== undefined && current === row.provider ? h('span', { className: 'dus-badge' }, t('current')) : null,
          h('span', { className: 'dus-provider-total' }, `${formatTokens(totalOf(row.totals))} · ${t('calls', { n: row.totals.calls ?? 0 })}`),
        ),
        (row.models ?? []).map((model) => h(
          'div',
          { className: 'dus-model', key: model.model },
          h('span', { className: 'dus-model-name', title: model.model }, model.model),
          h('span', { className: 'dus-model-bar' }, h('i', { style: { width: `${Math.round((totalOf(model.totals) / Math.max(1, scale)) * 100)}%` } })),
          h('span', { className: 'dus-model-total' }, formatTokens(totalOf(model.totals))),
        )),
      )
    }

    /** The range presets, in picker order. */
    const RANGE_PRESETS = Object.freeze(['today', 'last7', 'last30', 'all', 'custom'])

    /** Copy key per preset. */
    const RANGE_LABELS = Object.freeze({
      today: 'rangeToday',
      last7: 'range7',
      last30: 'range30',
      all: 'rangeAll',
      custom: 'rangeCustom',
    })

    /** localStorage key holding the preset the user last picked. */
    const RANGE_KEY = 'dsh-usage-stat.range-preset'

    /** The remembered preset, or `last7` when nothing valid is stored. */
    function readRangePreset() {
      try {
        const value = window.localStorage.getItem(RANGE_KEY)
        return RANGE_PRESETS.includes(value) ? value : 'last7'
      } catch {
        return 'last7'
      }
    }

    /** Remember the preset, so reopening settings lands where the user left off. */
    function writeRangePreset(preset) {
      try {
        window.localStorage.setItem(RANGE_KEY, preset)
      } catch {
        // A blocked localStorage must not break the picker.
      }
    }

    /**
     * The window a fixed preset names, as two inclusive local-date keys.
     *
     * `custom` is not handled here: it has no fixed window, so the caller reads
     * the two date inputs instead.
     * @param {string} preset - `today`, `last7`, `last30` or `all`.
     * @param {string} today - today's local-date key.
     * @param {string[]} availableDays - every retained day, ascending.
     * @returns {{ from: string, to: string }} the inclusive window.
     */
    function rangeOf(preset, today, availableDays) {
      if (preset === 'today') return { from: today, to: today }
      if (preset === 'last30') return { from: shiftDayKey(today, -29), to: today }
      if (preset === 'all') return { from: availableDays[0] ?? today, to: today }
      return { from: shiftDayKey(today, -6), to: today }
    }

    /**
     * How many day columns a chart draws at most.
     *
     * A window longer than this is drawn from its most recent days rather than
     * squeezed: below a couple of pixels a bar stops being a bar, and the
     * recent shape is the part anyone reads.
     */
    const CHART_MAX_DAYS = 366

    /**
     * Every day of the window, with the totals recorded for it.
     *
     * The bars have to cover the same window the numbers above them cover. A
     * chart that silently drops the days nobody used makes the range picker
     * look broken — the axis says "30 days" and only four bars are drawn. Days
     * with no usage are real columns of zero height.
     *
     * The walk goes backwards from the end so that a decade-long window costs
     * a bounded number of steps and still lands on its most recent days.
     * @param {string} from - the first local-date key, inclusive.
     * @param {string} to - the last local-date key, inclusive.
     * @param {Array<{ date: string, totals: object }>} days - the days that recorded usage.
     * @returns {Array<{ date: string, totals: object }>} one entry per day in the window, ascending.
     */
    function chartDays(from, to, days) {
      const known = new Map()
      for (const day of Array.isArray(days) ? days : []) {
        if (day === null || typeof day !== 'object') continue
        if (typeof day.date === 'string') known.set(day.date, day.totals)
      }
      if (from === '' || to === '' || from > to) return []
      /** @type {Array<{ date: string, totals: object }>} */
      const out = []
      let key = to
      for (let step = 0; step < CHART_MAX_DAYS && key >= from; step += 1) {
        out.push({ date: key, totals: known.get(key) ?? zeroTotals() })
        key = shiftDayKey(key, -1)
      }
      return out.reverse()
    }

    /**
     * The window's heaviest day — what the chart scales to, and the figure the
     * card names so the axis is not a mystery.
     * @param {Array<{ date: string, totals: object }>} days - the window's days.
     * @returns {{ value: number, date: string }} - `0` / `''` when there is nothing to scale to.
     */
    function peakOf(days) {
      let value = 0
      let date = ''
      for (const day of days ?? []) {
        const total = totalOf(day.totals)
        if (total > value) {
          value = total
          date = day.date
        }
      }
      return { value, date }
    }

    /**
     * The dates the chart's axis labels, evenly spread over the window.
     *
     * Two labels (first and last) are enough for a few days, but a week of bars
     * with nothing in between leaves the reader counting columns to find a date.
     * The step grows with the window instead of a fixed count, so the labels stay
     * readable rather than colliding.
     * @param {Array<{ date: string }>} days - the chart's columns, oldest first.
     * @returns {string[]} - the dates to label, oldest first; `[]` when empty.
     */
    function axisTicks(days) {
      const count = (days ?? []).length
      if (count === 0) return []
      if (count === 1) return [days[0].date]
      const labels = count >= 24 ? 4 : count >= 7 ? 3 : 2
      const out = []
      for (let index = 0; index < labels; index += 1) {
        const at = Math.round((index * (count - 1)) / (labels - 1))
        const date = days[at].date
        if (out[out.length - 1] !== date) out.push(date)
      }
      return out
    }

    /**
     * One bar per day in the window, scaled to the window's own peak.
     *
     * A bar chart rather than a second provider list: "which day was heavy" is
     * the question the provider totals cannot answer, and the card the user is
     * replacing shows no per-day shape at all. The scale is relative — the
     * heaviest day in the window is the full height — because an absolute scale
     * would flatten a quiet week into an invisible line; the card head names that
     * peak so the height means something.
     * @param {{ days: Array<{ date: string, totals: object }> }} props - the window's per-day totals.
     */
    function DayChart(props) {
      const days = props.days ?? []
      const top = Math.max(1, peakOf(days).value)
      return h(
        'div',
        { className: 'dus-chart' },
        days.map((day) => {
          const value = totalOf(day.totals)
          return h(
            'div',
            {
              key: day.date,
              className: 'dus-chart-col',
              'data-dsh-part': 'chart-col',
              title: `${day.date} · ${formatTokens(value)} tokens · ${t('callsShort', { n: day.totals?.calls ?? 0 })}`,
            },
            h('div', { className: 'dus-chart-bar', style: { height: `${Math.max(2, Math.round((value / top) * 100))}%` } }),
          )
        }),
      )
    }

    /**
     * The 用量 tab: a range picker, then one window's metrics, providers, daily
     * shape, and the plugin's own settings.
     *
     * Every number on this page comes from the *selected window* — there is no
     * separate "today" card next to a "trend" card, because two cards holding
     * the same numbers read as a bug. The window defaults to the last 7 days
     * and is remembered across sessions.
     */
    function UsageTab(props) {
      const { overview } = props
      const today = todayKey()
      const availableDays = overview.usage?.availableDays ?? []
      const [preset, setPreset] = useState(readRangePreset)
      const [customFrom, setCustomFrom] = useState(() => shiftDayKey(todayKey(), -6))
      const [customTo, setCustomTo] = useState(todayKey)
      const [range, setRange] = useState(null)
      const [rangeError, setRangeError] = useState(null)

      const picked = preset === 'custom' ? { from: customFrom, to: customTo } : rangeOf(preset, today, availableDays)
      const from = picked.from
      const to = picked.to
      const backwards = from !== '' && to !== '' && from > to
      const fetchable = from !== '' && to !== '' && !backwards

      // Refetch whenever the window changes *or* the polled overview advances,
      // so an open settings page keeps showing live numbers without a second
      // timer of its own.
      useEffect(() => {
        if (!fetchable) return undefined
        let cancelled = false
        api.range(from, to).then(
          (value) => {
            if (!cancelled) {
              setRange(value)
              setRangeError(null)
            }
          },
          (error) => {
            if (!cancelled) setRangeError(error instanceof Error ? error.message : String(error))
          },
        )
        return () => {
          cancelled = true
        }
      }, [from, to, fetchable, overview.updatedAt])

      const pick = (value) => {
        setPreset(value)
        writeRangePreset(value)
      }

      const totals = range?.totals ?? zeroTotals()
      const providers = range?.providers ?? []
      const days = range?.days ?? []
      // The chart covers the picked window, not just the days that happen to
      // hold usage, so its axis and the numbers above it agree.
      const chart = chartDays(from, to, days)
      const peak = peakOf(chart)
      const scale = heaviestModel(providers)
      // The live route is only worth marking when the window actually covers
      // today; on a past window it says nothing about the numbers shown.
      const currentProvider = from <= today && to >= today ? overview.current?.provider : undefined

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dus-card' },
          h(
            'div',
            { className: 'dus-card-head' },
            h('span', { className: 'dus-card-title' }, t('overview')),
            h(
              'div',
              { className: 'dus-ranges', role: 'group', 'aria-label': t('range') },
              RANGE_PRESETS.map((value) => h(
                'button',
                {
                  key: value,
                  type: 'button',
                  className: 'dus-range',
                  'data-dsh-part': `range-${value}`,
                  'aria-pressed': preset === value,
                  onClick: () => pick(value),
                },
                t(RANGE_LABELS[value]),
              )),
            ),
          ),
          preset === 'custom'
            ? h(
                'div',
                { className: 'dus-range-dates' },
                h(
                  'label',
                  { className: 'dus-field', style: { flex: 'none' } },
                  h('span', { className: 'dus-field-label' }, t('rangeFrom')),
                  h('input', {
                    className: 'dus-input',
                    type: 'date',
                    'data-dsh-part': 'range-from',
                    value: customFrom,
                    ...(customTo === '' ? {} : { max: customTo }),
                    onChange: (event) => setCustomFrom(event.target.value),
                  }),
                ),
                h(
                  'label',
                  { className: 'dus-field', style: { flex: 'none' } },
                  h('span', { className: 'dus-field-label' }, t('rangeTo')),
                  h('input', {
                    className: 'dus-input',
                    type: 'date',
                    'data-dsh-part': 'range-to',
                    value: customTo,
                    ...(customFrom === '' ? {} : { min: customFrom }),
                    onChange: (event) => setCustomTo(event.target.value),
                  }),
                ),
              )
            : null,
          backwards ? h('div', { className: 'dus-note' }, t('rangeBad')) : null,
          rangeError !== null
            ? h('div', { className: 'dus-note' }, t('error', { error: rangeError }))
            : range === null
              ? h('div', { className: 'dus-note' }, t('loading'))
              : h(
                  React.Fragment,
                  null,
                  h('div', { className: 'dus-note' }, from === to ? from : `${from} → ${to}`),
                  h(
                    'div',
                    { className: 'dus-metrics' },
                    h(Metric, { value: formatTokens(totalOf(totals)), label: t('total') }),
                    h(Metric, { value: formatTokens(totals.inputTokens), label: t('input') }),
                    h(Metric, { value: formatTokens(totals.outputTokens), label: t('output') }),
                    h(Metric, { value: formatTokens(totals.cacheReadTokens), label: t('cacheRead') }),
                    // Cache writes are real (Anthropic-style providers bill
                    // them) but several providers never report one. A tile that
                    // is always zero is noise, so it only appears when the
                    // window actually has writes; the number is still folded
                    // and still shown once it exists.
                    totals.cacheWriteTokens > 0
                      ? h(Metric, { value: formatTokens(totals.cacheWriteTokens), label: t('cacheWrite') })
                      : null,
                    h(Metric, { value: String(totals.calls ?? 0), label: t('callCount') }),
                  ),
                ),
        ),
        h(
          'div',
          { className: 'dus-card' },
          h('div', { className: 'dus-card-head' }, h('span', { className: 'dus-card-title' }, t('providers'))),
          providers.length === 0
            ? h('div', { className: 'dus-empty' }, t('noProviders'))
            : h('div', { className: 'dus-list' }, providers.map((row) => h(ProviderBlock, { key: row.provider, row, scale, current: currentProvider }))),
        ),
        h(
          'div',
          { className: 'dus-card' },
          h(
            'div',
            { className: 'dus-card-head' },
            h('span', { className: 'dus-card-title' }, t('daily')),
            // The chart scales to the window's own peak, so the card names that
            // peak: "how tall is the tallest bar" is otherwise unanswerable.
            peak.date === ''
              ? null
              : h('span', { className: 'dus-card-note' }, t('dailyPeak', { value: formatTokens(peak.value), date: shortDate(peak.date) })),
          ),
          chart.length === 0
            ? h('div', { className: 'dus-empty' }, t('noProviders'))
            : h(
                React.Fragment,
                null,
                h(DayChart, { days: chart }),
                h(
                  'div',
                  { className: 'dus-trend-axis' },
                  axisTicks(chart).map((date) => h('span', { key: date }, shortDate(date))),
                ),
              ),
        ),
      )
    }

    /**
     * The 设置 tab: the plugin's own knobs.
     *
     * It is a tab of its own rather than a card under the usage numbers,
     * because settings and readings answer different questions: the usage tab
     * is what you look at, this one is what you change. Splitting them also
     * keeps a save from re-rendering a chart nobody asked to change.
     */
    function SettingsTab(props) {
      const { overview, onConfigSaved } = props
      const [draft, setDraft] = useState(null)
      const [saveState, setSaveState] = useState({ status: 'idle', error: null })
      const [backfill, setBackfill] = useState({ status: 'idle', files: 0, error: null })

      const config = draft ?? overview.config
      const edit = (patch) => setDraft({ ...config, ...patch })

      const runBackfill = async () => {
        setBackfill({ status: 'running', files: 0, error: null })
        try {
          const tally = await api.backfill()
          setBackfill({ status: 'done', files: tally?.files ?? 0, error: null })
        } catch (error) {
          setBackfill({ status: 'error', files: 0, error: error instanceof Error ? error.message : String(error) })
        }
      }

      /** What the history row reports: the last manual run wins over the bookmark. */
      const historyText = () => {
        if (backfill.status === 'running') return t('historyRunning')
        if (backfill.status === 'done') return t('historyDone', { files: backfill.files })
        if (backfill.status === 'error') return t('saveFailed', { error: backfill.error ?? '' })
        const stamp = overview?.history
        if (stamp === null || stamp === undefined) return t('historyNone')
        return t('historyAt', { files: stamp.files ?? 0, time: formatClock(stamp.atMs) })
      }

      const save = async () => {
        setSaveState({ status: 'saving', error: null })
        try {
          const saved = await api.saveConfig({
            enabled: config.enabled,
            pollIntervalSec: config.pollIntervalSec,
            probeEnabled: config.probeEnabled,
            probeIntervalSec: config.probeIntervalSec,
            alertEnabled: config.alertEnabled,
            alertBalanceBelow: config.alertBalanceBelow,
            alertWindow5h: config.alertWindow5h,
            alertWindowWeek: config.alertWindowWeek,
            alertWindowMonth: config.alertWindowMonth,
          })
          setDraft(null)
          setSaveState({ status: 'saved', error: null })
          onConfigSaved(saved)
        } catch (error) {
          setSaveState({ status: 'error', error: error instanceof Error ? error.message : String(error) })
        }
      }

      /**
       * One settings row: the setting on the left, its control on the right,
       * and the line explaining it under the name. This is the shape the shell
       * uses for its own settings, so a row here reads as a row there.
       */
      const formRow = (key, label, control, hint) => h(
        'div',
        { className: 'dus-form-row', key },
        h(
          'div',
          { className: 'dus-form-text' },
          h('span', { className: 'dus-form-label' }, label),
          hint === undefined ? null : h('span', { className: 'dus-form-hint' }, hint),
        ),
        h('div', { className: 'dus-form-control' }, control),
      )

      const checkBox = (part, label, checked, patch) => h('input', {
        className: 'dus-check',
        'data-dsh-part': part,
        type: 'checkbox',
        checked,
        title: label,
        'aria-label': label,
        onChange: (event) => edit(patch(event.target.checked)),
      })

      const numberBox = (part, value, min, max, patch, suffix) => [
        h('input', {
          className: 'dus-input',
          'data-dsh-part': part,
          type: 'number',
          min,
          max,
          value,
          onChange: (event) => edit(patch(Number(event.target.value))),
        }),
        suffix === undefined ? null : h('span', { className: 'dus-suffix', 'data-dsh-part': 'alert-unit' }, suffix),
      ]

      return h(
        'div',
        { className: 'dus-stack' },
        h(
          'div',
          { className: 'dus-panel' },
          formRow('enable', t('enable'), checkBox('enable-check', t('enable'), config.enabled === true, (next) => ({ enabled: next }))),
        ),
        h(
          'div',
          { className: 'dus-panel' },
          h('div', { className: 'dus-panel-head' }, h('span', { className: 'dus-panel-title' }, t('tabUsage'))),
          formRow(
            'poll',
            t('pollInterval'),
            numberBox('setting-input', config.pollIntervalSec, 5, 600, (next) => ({ pollIntervalSec: next })),
            t('pollHint'),
          ),
        ),
        h(
          'div',
          { className: 'dus-panel' },
          h(
            'div',
            { className: 'dus-panel-head' },
            h('span', { className: 'dus-panel-title' }, t('balanceTitle')),
            checkBox('probe-check', t('probeEnabled'), config.probeEnabled === true, (next) => ({ probeEnabled: next })),
          ),
          formRow(
            'probe',
            t('probeInterval'),
            numberBox('setting-input', config.probeIntervalSec, 60, 3600, (next) => ({ probeIntervalSec: next })),
            t('probeHint'),
          ),
        ),
        h(
          'div',
          { className: 'dus-panel' },
          h(
            'div',
            { className: 'dus-panel-head' },
            h('span', { className: 'dus-panel-title' }, t('alertEnabled')),
            checkBox('alert-check', t('alertEnabled'), config.alertEnabled === true, (next) => ({ alertEnabled: next })),
          ),
          h('div', { className: 'dus-panel-note' }, t('alertHint')),
          // The balance line is an amount and the three window lines are
          // percentages of what is *left*, which is why they are two different
          // kinds of input rather than four of the same. The amount still gets a
          // unit mark so its box lands on the same right edge as the three
          // percentage boxes above it.
          formRow(
            'alert-balance',
            t('alertBalance'),
            numberBox('alert-input', config.alertBalanceBelow, 0, 1000000, (next) => ({ alertBalanceBelow: next }), t('alertUnit')),
          ),
          ...[
            ['alertWindow5h', t('alertWindow5h')],
            ['alertWindowWeek', t('alertWindowWeek')],
            ['alertWindowMonth', t('alertWindowMonth')],
          ].map(([key, label]) => formRow(
            key,
            label,
            numberBox('alert-input', config[key], 0, 100, (next) => ({ [key]: next }), '%'),
          )),
        ),
        h(
          'div',
          { className: 'dus-panel' },
          h(
            'div',
            { className: 'dus-panel-head' },
            h('span', { className: 'dus-panel-title' }, t('historyTitle')),
            h('button', {
              type: 'button',
              className: 'dus-button',
              'data-dsh-part': 'backfill-button',
              disabled: backfill.status === 'running',
              onClick: runBackfill,
            }, backfill.status === 'running' ? t('historyRunning') : t('historyRun')),
          ),
          h('div', { className: 'dus-panel-note' }, t('historyHint')),
          h(
            'div',
            { className: 'dus-form-row' },
            h('div', { className: 'dus-form-text' }, h('span', { className: 'dus-form-label', 'data-dsh-part': 'history-state' }, historyText())),
          ),
        ),
        h(
          'div',
          { className: 'dus-actions' },
          // Which build is live, at the far end of the row so it never competes
          // with the save button. The host reads it out of the manifest.
          typeof overview?.version === 'string' && overview.version !== ''
            ? h('span', { className: 'dus-version' }, t('version', { version: overview.version }))
            : null,
          saveState.status === 'saved' ? h('span', { className: 'dus-note' }, t('saved')) : null,
          saveState.status === 'error' ? h('span', { className: 'dus-note' }, t('saveFailed', { error: saveState.error ?? '' })) : null,
          h('button', { type: 'button', className: 'dus-button dus-button-primary', disabled: draft === null || saveState.status === 'saving', onClick: save },
            saveState.status === 'saving' ? t('saving') : t('save')),
        ),
      )
    }

    //#region ------------------------------------------------------- vendor facts

    /**
     * Copy key per machine reason behind an unavailable vendor fact.
     *
     * The host reports reasons as stable codes (`'no-credential'`) so the UI can
     * translate them; anything else it hands over is a provider's own error text
     * and is shown verbatim, because paraphrasing an HTTP failure loses the one
     * detail that helps.
     */
    const REASON_KEYS = Object.freeze({
      'no-credential': 'reasonNoCredential',
      'oauth-credential': 'reasonOauth',
      'origin-mismatch': 'reasonOrigin',
      unsupported: 'reasonUnsupported',
    })

    /** A vendor fact's failure text, or an empty string when there is none. */
    function reasonText(reason) {
      if (reason === undefined || reason === null || reason === '') return ''
      const key = REASON_KEYS[reason]
      return key === undefined ? String(reason) : t(key)
    }

    /** Copy key per plan window, for windows the provider did not name itself. */
    const WINDOW_KEYS = Object.freeze({ '5h': 'window5h', week: 'windowWeek', month: 'windowMonth' })

    /** A plan window's label: the provider's own name when it sent one. */
    function windowName(entry) {
      if (typeof entry.name === 'string' && entry.name !== '') return entry.name
      const key = WINDOW_KEYS[entry.key]
      return key === undefined ? String(entry.key) : t(key)
    }

    /** Currency symbol for the two currencies the balance endpoints report. */
    const CURRENCY_SIGNS = Object.freeze({ CNY: '¥', USD: '$' })

    /** A balance amount with its symbol, falling back to a suffixed code. */
    function moneyText(balance) {
      const raw = balance.totalBalance
      // The vendor endpoints hand back a string already at the currency's
      // precision, but a reminder carries the parsed number. Both must read the
      // same, so a number is rendered the way the card renders one.
      const amount = typeof raw === 'number' && Number.isFinite(raw) ? raw.toFixed(2) : raw
      const sign = CURRENCY_SIGNS[balance.currency]
      return sign === undefined ? `${amount} ${balance.currency}` : `${sign}${amount}`
    }

    /**
     * A reset instant as `HH:MM`, prefixed with `M-D` when it is not today.
     * Accepts what the adapters emit (an ISO string) and raw epoch numbers.
     */
    function formatReset(value) {
      if (value === undefined || value === null) return ''
      const ms = typeof value === 'number' ? value : Date.parse(String(value))
      if (!Number.isFinite(ms)) return ''
      const at = new Date(ms)
      const clock = formatClock(ms)
      if (clock === '') return ''
      return at.toDateString() === new Date().toDateString() ? clock : `${at.getMonth() + 1}-${at.getDate()} ${clock}`
    }

    /** A percentage clamped to the 0-100 a bar can draw. */
    function clampPercent(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 0
      return Math.min(100, Math.max(0, value))
    }

    /**
     * Reminders indexed by provider route.
     *
     * A row asks "am I flagged?" once per render, and a card can hold dozens of
     * rows, so the list is indexed once instead of scanned per row. Malformed
     * entries are dropped rather than throwing: a reminder is decoration on top
     * of the numbers, and it must never be able to take the card down.
     */
    function alertsIndex(alerts) {
      /** @type {Map<string, object[]>} */
      const index = new Map()
      for (const alert of Array.isArray(alerts) ? alerts : []) {
        if (alert === null || typeof alert !== 'object') continue
        if (typeof alert.provider !== 'string' || alert.provider === '') continue
        const list = index.get(alert.provider)
        if (list === undefined) index.set(alert.provider, [alert])
        else list.push(alert)
      }
      return index
    }

    /** One reminder as a sentence, for a dot's tooltip. */
    function alertTitle(alert) {
      if (alert.kind === 'balance') {
        return t('alertBalanceTitle', {
          amount: moneyText({ currency: alert.currency ?? '', totalBalance: alert.amount ?? '' }),
          threshold: String(alert.threshold ?? ''),
        })
      }
      return t('alertWindowTitle', {
        window: windowName({ key: alert.window }),
        remaining: String(Math.round(alert.remaining ?? 0)),
        threshold: String(alert.threshold ?? ''),
      })
    }

    /**
     * The red dot.
     *
     * `title` and `aria-label` both carry the reason, so the mark is legible to
     * a hover and to a screen reader without a second click. It is `role="img"`
     * because a bare span has no semantics to attach a label to.
     */
    function AlertDot(props) {
      return h('span', {
        className: 'dus-dot',
        'data-dsh-part': 'alert-dot',
        role: 'img',
        title: props.title,
        'aria-label': props.title,
      })
    }

    /** The dot's tooltip for a provider, or undefined when it has no reminders. */
    function dotFor(index, provider) {
      const list = index.get(provider)
      if (list === undefined || list.length === 0) return undefined
      return list.map(alertTitle).join('；')
    }

    /**
     * One plan window: label, share bar, percentage, and when it resets.
     *
     * The bar is the same visual as a model's share bar so the two tabs read as
     * one surface; here it means "how much of this window is spent".
     */
    function PlanWindow(props) {
      const { entry } = props
      const percent = typeof entry.percent === 'number' ? entry.percent : undefined
      const label = percent === undefined ? '—' : `${percent < 10 ? percent.toFixed(1) : Math.round(percent)}%`
      return h(
        'div',
        { className: 'dus-window', 'data-dsh-part': 'plan-window' },
        h('span', { className: 'dus-window-name' }, windowName(entry)),
        h('span', { className: 'dus-model-bar' }, h('i', { style: { width: `${clampPercent(percent ?? 0)}%` } })),
        h('span', { className: 'dus-window-percent' }, label),
        h('span', { className: 'dus-window-reset' }, entry.resetsAt === undefined ? '' : t('resetAt', { time: formatReset(entry.resetsAt) })),
      )
    }

    /**
     * The shared shell of the two vendor tabs: a title, when the facts were
     * fetched, and the button that probes every provider right now.
     *
     * Probing is deliberately manual-plus-scheduled: these numbers come from
     * third-party endpoints, so the user always has a way to ask for them on
     * demand instead of waiting out the interval.
     */
    function VendorCard(props) {
      const { title, facts, children } = props
      const stamp = facts === null || facts === undefined || facts.updatedAt === undefined
        ? t('vendorStale')
        : t('vendorUpdated', { time: formatClock(facts.updatedAt) })
      return h(
        'div',
        { className: 'dus-card', 'data-dsh-part': 'vendor-card' },
        h(
          'div',
          { className: 'dus-provider-head' },
          h('span', null, title),
          h('span', { className: 'dus-provider-total' }, stamp),
        ),
        children,
      )
    }

    /**
     * Providers the user has not configured a credential for, as one hint line.
     *
     * Without it an empty tab looks broken rather than unconfigured; with it the
     * user learns which vendors are one API key away. The list is capped: a
     * supported-provider table is long, and a fourteen-name wall stops being a
     * hint and starts being noise.
     */
    function CatalogHint(props) {
      const { facts } = props
      const known = new Set((facts?.providers ?? []).map((row) => row.provider))
      const list = (facts?.catalog?.probeable ?? []).filter((route) => !known.has(route))
      if (list.length === 0) return null
      const shown = list.slice(0, CATALOG_CAP)
      const rest = list.length - shown.length
      const text = t('catalogHint', { list: shown.join('、') })
      return h('div', { className: 'dus-note' }, rest === 0 ? text : `${text}${t('catalogMore', { n: rest })}`)
    }

    /**
     * One `name — value` row of a vendor tab.
     *
     * Shared by both tabs so a provider reads the same wherever it appears, and
     * so the reminder dot has exactly one implementation to change.
     */
    function VendorRow(props) {
      const { name, value, dot, part } = props
      return h(
        'div',
        { className: 'dus-vendor-row', 'data-dsh-part': part },
        dot === undefined ? null : h(AlertDot, { title: dot }),
        h('span', { className: 'dus-vendor-name' }, name),
        h('span', { className: 'dus-vendor-value' }, value),
      )
    }

    /**
     * The 账户 tab: what each provider says about its balance and its quotas.
     *
     * Balance and plan are one tab because they answer one question — "how much
     * have I got left" — and reading them in two places meant hunting for the
     * same vendor twice. A provider is listed once it produced at least one of
     * the two readings; everything that produced nothing (no credential, an
     * endpoint we do not know, a failed call) folds away at the bottom, so the
     * tab leads with facts instead of with errors.
     */
    function AccountTab(props) {
      const { facts, error } = props
      const rows = facts?.providers ?? []
      const alertIndex = alertsIndex(facts?.alerts)
      const hasReading = (row) => row.balance !== undefined || row.plan !== undefined
      // `unsupported` means the vendor publishes no such endpoint, which is a
      // property of the vendor rather than news about this account — so it is
      // the one reason quiet enough not to earn a line of its own.
      const notable = (reason) => reason !== undefined && reason !== 'unsupported'
      const usable = rows.filter(hasReading)
      const rest = rows.filter((row) => !hasReading(row))
      // A provider that could be read but has no key is the one "nothing here"
      // the user can act on, so it earns the one line that says what to do.
      const needsKey = rows.some((row) => row.balanceError === 'no-credential' || row.planError === 'no-credential')

      /** One half of a provider: its reading, or why the half is missing. */
      const half = (row, key) => {
        if (key === 'balance') {
          if (row.balance !== undefined) {
            return h(VendorRow, {
              part: 'balance-row',
              name: t('balanceLabel'),
              value: moneyText(row.balance),
            })
          }
          return notable(row.balanceError)
            ? h('div', { className: 'dus-note' }, `${t('balanceLabel')}：${reasonText(row.balanceError)}`)
            : null
        }
        if (row.plan !== undefined) {
          const windows = row.plan.windows ?? []
          return windows.length === 0
            ? null
            : h('div', { className: 'dus-windows' }, windows.map((entry) => h(PlanWindow, { key: entry.key, entry })))
        }
        return notable(row.planError)
          ? h('div', { className: 'dus-note' }, `${t('planTitle')}：${reasonText(row.planError)}`)
          : null
      }

      /** The vendor block: one reminder dot per provider, on its own header. */
      const vendor = (row) => {
        const dot = dotFor(alertIndex, row.provider)
        return h(
          'div',
          { className: 'dus-plan-block', key: row.provider, 'data-dsh-part': 'account-card' },
          h(
            'div',
            { className: 'dus-provider-head' },
            dot === undefined ? null : h(AlertDot, { title: dot }),
            h('span', null, row.displayName ?? row.provider),
            row.plan?.planName === undefined ? null : h('span', { className: 'dus-badge' }, t('planName', { name: row.plan.planName })),
          ),
          half(row, 'balance'),
          half(row, 'plan'),
        )
      }

      // Everything lives inside the one card, so the fold and the hint share the
      // card's own padding instead of hanging off its left edge.
      return h(
        'div',
        { className: 'dus-stack' },
        h(
          VendorCard,
          { title: t('accountTitle'), facts },
          error !== null && error !== undefined ? h('div', { className: 'dus-note' }, t('error', { error })) : null,
          facts === null
            ? h('div', { className: 'dus-empty' }, t('loadingVendors'))
            : usable.length === 0
              ? h('div', { className: 'dus-empty' }, t('noBalance'))
              : usable.map(vendor),
          needsKey
            ? h('div', { className: 'dus-panel-note', 'data-dsh-part': 'account-howto' }, t('accountHowTo'))
            : null,
          rest.length === 0
            ? null
            : h(
                'details',
                { className: 'dus-fold' },
                h('summary', { className: 'dus-fold-summary' }, `${t('unavailable')} · ${rest.length}`),
                h(
                  'div',
                  { className: 'dus-fold-body' },
                  rest.map((row) => h(VendorRow, {
                    key: row.provider,
                    part: 'unavailable-row',
                    name: row.displayName ?? row.provider,
                    value: reasonText(row.balanceError ?? row.planError) || reasonText('unsupported'),
                  })),
                ),
              ),
          facts === null ? null : h(CatalogHint, { facts }),
        ),
      )
    }

    //#endregion

    /**
     * The 用量统计 settings section: header, tabs, and whichever tab is active.
     *
     * The vendor tabs fetch their own facts lazily — the balance and plan
     * endpoints are third-party and slow, so they are neither polled with the
     * usage numbers nor fetched for a user who never opens those tabs.
     */
    function UsageSection(props) {
      const { store } = props
      const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
      const overview = snapshot.overview
      const [tab, setTab] = useState('usage')
      const [refreshing, setRefreshing] = useState(false)
      const [facts, setFacts] = useState(null)
      const [factsError, setFactsError] = useState(null)
      const [probing, setProbing] = useState(false)

      const refresh = async () => {
        setRefreshing(true)
        try {
          const next = await api.refresh()
          // A fresh `updatedAt` is what makes the range card refetch, so no
          // extra revision counter is needed here.
          store.set({ status: 'ready', overview: next, error: null })
        } catch (error) {
          store.set({ status: 'error', overview: store.getSnapshot().overview, error: error instanceof Error ? error.message : String(error) })
        } finally {
          setRefreshing(false)
        }
      }

      const vendorTab = tab === 'account'

      // Facts are read when a vendor tab is first opened, and re-read on every
      // return to one — cheap (a local HTTP hop) and always fresher than a
      // client-side cache would be.
      useEffect(() => {
        if (!vendorTab) return undefined
        let cancelled = false
        api.providers().then(
          (next) => {
            if (cancelled) return
            setFacts(next)
            setFactsError(null)
          },
          (error) => {
            if (cancelled) return
            setFactsError(error instanceof Error ? error.message : String(error))
          },
        )
        return () => {
          cancelled = true
        }
      }, [vendorTab])

      const probe = async () => {
        setProbing(true)
        try {
          setFacts(await api.probe())
          setFactsError(null)
        } catch (error) {
          setFactsError(error instanceof Error ? error.message : String(error))
        } finally {
          setProbing(false)
        }
      }

      if (overview === null) {
        return h(
          'div',
          { className: 'dus-section', 'data-dsh-plugin': 'usage-stat', 'data-dsh-part': 'settings-section' },
          h('div', { className: 'dus-note' }, snapshot.status === 'error' ? t('error', { error: snapshot.error ?? '' }) : t('loading')),
        )
      }

      const tabs = [
        { id: 'usage', label: t('tabUsage') },
        { id: 'account', label: t('tabAccount') },
        { id: 'settings', label: t('settings') },
      ]

      return h(
        'div',
        { className: 'dus-section', 'data-dsh-plugin': 'usage-stat', 'data-dsh-part': 'settings-section' },
        h(
          'div',
          { className: 'dus-head' },
          // The nav row above reads 「用量统计」 too, but a settings page needs a
          // heading of its own: it is what makes the panel look like a page
          // rather than a bare stack of cards. The heading carries the page
          // title scale of the shell's own settings dialog, and the line under
          // it carries the one fact the nav row cannot show -- how fresh these
          // numbers are.
          h(
            'div',
            { className: 'dus-head-text' },
            h('h2', { className: 'dus-head-title' }, t('title')),
            h('span', { className: 'dus-head-sub' }, t('updated', { time: formatClock(overview.updatedAt) })),
          ),
          h(
            'div',
            { className: 'dus-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dus-button',
                disabled: vendorTab ? probing : refreshing,
                onClick: vendorTab ? probe : refresh,
              },
              vendorTab
                ? (probing ? t('probing') : t('probeNow'))
                : (refreshing ? t('refreshing') : t('refresh')),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dus-tabs', role: 'tablist' },
          tabs.map((entry) => h(
            'button',
            {
              key: entry.id,
              type: 'button',
              role: 'tab',
              className: 'dus-tab',
              'aria-selected': tab === entry.id,
              onClick: () => setTab(entry.id),
            },
            entry.label,
          )),
        ),
        tab === 'usage'
          ? h(UsageTab, { overview })
          : tab === 'account'
            ? h(AccountTab, { facts, error: factsError })
            : h(SettingsTab, {
                overview,
                onConfigSaved: (config) => {
                  store.set({ status: 'ready', overview: { ...overview, config }, error: null })
                },
              }),
      )
    }

    //#endregion

    //#region ----------------------------------------------------------- mounting

    /** Attribute marking the injected foot-card container. */
    const FOOT_SELECTOR = '[data-dsh-usage-stat-foot]'

    /**
     * The sidebar's foot area: the block holding the footer actions and the
     * Settings row. Class names are build hashes, so they are matched by
     * substring rather than by exact name.
     * @returns {HTMLElement|undefined} the foot area, when the sidebar is mounted.
     */
    function footArea() {
      const column = document.querySelector('[class*="sidebarCol"]')
      return column?.querySelector('[class*="footArea"]') ?? undefined
    }

    /**
     * Seat the foot card directly above the Settings row.
     *
     * The foot's only slot is a horizontal action row, so the card is a plain
     * container with its own React root inserted into the foot area — it can
     * never disturb the shell's reconciliation, and a shell re-render that
     * displaces it is repaired by the body observer below.
     * @param {object} store - the shared overview store.
     * @returns {() => void} the disposer.
     */
    function mountFootCard(store) {
      if (typeof document === 'undefined') return () => {}
      // DOM-level idempotency: never mount a second card, whatever path got here.
      if (document.querySelector(FOOT_SELECTOR) !== null) return () => {}

      const container = document.createElement('div')
      container.setAttribute('data-dsh-usage-stat-foot', '')
      const root = ReactDOMClient.createRoot(container)
      root.render(h(FootCard, { store }))

      const place = () => {
        const foot = footArea()
        if (foot === undefined) return false
        const settings = foot.querySelector('[class*="settingsArea"]')
        if (settings !== null) {
          if (container.nextElementSibling !== settings) foot.insertBefore(container, settings)
          return true
        }
        // No Settings seat to anchor against (a shell change): fall back to the tail.
        if (foot.lastElementChild !== container) foot.append(container)
        return true
      }

      // Placement must not depend on some unrelated DOM mutation happening
      // later: a plugin loads during the module phase, which can easily be
      // before React has rendered the sidebar. So retry on a bounded timer
      // until the foot area exists, and let the observer below take over from
      // there for re-seats.
      let placed = place()
      let attempts = 0
      let retry
      const retryPlacement = () => {
        if (placed) return
        placed = place()
        attempts += 1
        // ~5 s of retries: long enough for a cold shell to render, short
        // enough that a shell without a foot area costs nothing afterwards.
        if (!placed && attempts <= 100) retry = window.setTimeout(retryPlacement, 50)
      }
      if (!placed) retry = window.setTimeout(retryPlacement, 50)

      // Coalesce every body mutation into one re-check per frame. Chat token
      // streaming produces many mutations per second, so an uncoalesced
      // observer would run `place()` far more often than the DOM can change.
      let frame
      const observer = new MutationObserver(() => {
        if (frame !== undefined) return
        frame = window.requestAnimationFrame(() => {
          frame = undefined
          place()
        })
      })
      observer.observe(document.body ?? document.documentElement, { childList: true, subtree: true })

      return () => {
        if (retry !== undefined) window.clearTimeout(retry)
        observer.disconnect()
        if (frame !== undefined) window.cancelAnimationFrame(frame)
        root.unmount()
        container.remove()
      }
    }

    //#endregion

    //#region -------------------------------------------------------------- apply

    exports.name = 'dsh-usage-stat'
    /** The one client service this plugin needs; the slot registry provides it. */
    exports.inject = ['slots']

    /**
     * Test seam.
     *
     * The browser half cannot be exercised by the host's test runner without a
     * DOM, so the components and the pure helpers are also exported here. The
     * module loader reads only `apply`, `inject` and `name`, so this surface is
     * inert in the browser, and `test/client.test.mjs` drives it with a small
     * hand-rolled DOM and hook runtime — which is how the missing module
     * envelope (a bundle that threw `exports is not defined` before ever
     * applying) is caught.
     */
    exports.__internals = {
      FootCard,
      SessionBadge,
      SessionPanelBody,
      sessionRows,
      tintOf,
      PROVIDER_TINTS,
      UsageSection,
      UsageTab,
      SettingsTab,
      AccountTab,
      AlertDot,
      VendorRow,
      alertsIndex,
      alertTitle,
      dotFor,
      DayChart,
      peakOf,
      axisTicks,
      chartDays,
      CHART_MAX_DAYS,
      createOverviewStore,
      startPolling,
      formatTokens,
      totalOf,
      zeroTotals,
      shiftDayKey,
      rangeOf,
      RANGE_PRESETS,
      reasonText,
      moneyText,
      formatReset,
      windowName,
      t,
    }

    /**
     * Client plugin body.
     * @param {object} ctx - the client root context.
     */
    exports.apply = function apply(ctx) {
      ensureStyles()
      const store = createOverviewStore()

      ctx.effect(() => startPolling(store, () => {}), 'dsh-usage-stat: overview poll')
      ctx.effect(() => mountFootCard(store), 'dsh-usage-stat: sidebar foot card')

      // No `label` here on purpose: the shipped occupant of this slot
      // (the shell's own stats pills) registers without one, and the pill
      // carries its own text.
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
        { name: 'conversation.composer.dock', id: 'usage-stat-session', order: 10 },
        SessionBadge,
      ))

      ctx.slots.inject('settings.section', () => ctx.slots.register(
        // Order 152: one past the usage plugin this replaces, so the two never
        // fight over position while both are installed and this section stays
        // the last one when the other is removed.
        { name: 'settings.section', id: 'usage-stat', order: 152, label: () => t('title'), inject: () => ({ store }) },
        UsageSection,
      ))
    }

    //#endregion

    return module.exports
  },
})
