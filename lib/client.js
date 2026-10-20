/**
 * dsh-abacus browser half.
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
 *    demand from `/api/abacus/session`.
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
 * @module dsh-abacus/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-abacus',
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
        hourly: '每小时用量',
        hourlyPeak: '最高 {value}（{hour}）',
        noHours: '这一天没有按小时的记录。',
        tabCost: '金额',
        costTitle: '金额折算',
        costTotal: '折算金额',
        costNote: '按价目表的单价折算，未含折扣与套餐。内置的 DeepSeek 价格在工作日高峰时段（9:00-12:00、14:00-18:00）按两倍计。',
        costScope: '统计范围',
        costProvider: '供应商',
        costModel: '模型',
        costAll: '全部供应商',
        costAllModels: '全部模型',
        costBilled: '计费 tokens',
        costUnpriced: '另有 {count} 个模型未定价，{tokens} tokens 未计入。',
        costUnpricedLabel: '未定价 tokens',
        costNoPrice: '未定价',
        costHourly: '每小时金额',
        costHourlyPeak: '最高 {value}（{hour}）',
        costDaily: '每日金额',
        costDailyPeak: '最高 {value}（{day}）',
        pricesTitle: '价目表',
        pricesHint: '只填需要覆盖的模型；没有列出的模型按内置价格计算。单位是元/百万 token。生效日期留空表示从最早算起；缓存写没有单独价格就留空。',
        priceModel: '模型名',
        priceFrom: '生效日期',
        priceAdd: '添加一行',
        priceRemove: '删除这一行',
        pricesBad: '第 {row} 行填得不对：需要模型名，且输入价和输出价不能同时为 0。',
        pricesBadNumber: '第 {row} 行有认不出的数字：价格这一栏只能填数字。',
        pricesBuiltin: '内置价格',
        pricesPeak: '高峰 ×2',
        pricesPeakNote: '工作日 9:00-12:00、14:00-18:00 为高峰，按两倍计；周末与法定节假日全天按上表。',
        total: '总 tokens',
        input: '输入',
        output: '输出',
        cacheRead: '缓存读',
        cacheWrite: '缓存写',
        callCount: '调用次数',
        providers: '供应商与模型',
        settings: '设置',
        enable: '启用插件',
        pollInterval: '更新间隔',
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
        probeInterval: '查询间隔',
        probeHint: '余额与套餐变化较慢，不必像用量那样频繁查询。',
        seconds: '秒',
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
        hourly: 'Per hour',
        hourlyPeak: 'Peak {value} ({hour})',
        noHours: 'No hour-by-hour record for this day.',
        tabCost: 'Cost',
        costTitle: 'Cost estimate',
        costTotal: 'Estimated cost',
        costNote: 'Converted at the rates in the price list; discounts and subscription plans are not applied. The built-in DeepSeek prices bill weekday peak hours (09:00-12:00, 14:00-18:00) at twice the off-peak rate.',
        costScope: 'Scope',
        costProvider: 'Provider',
        costModel: 'Model',
        costAll: 'All providers',
        costAllModels: 'All models',
        costBilled: 'Billed tokens',
        costUnpriced: '{count} more model(s) have no price; {tokens} tokens are not counted.',
        costUnpricedLabel: 'Unpriced tokens',
        costNoPrice: 'No price',
        costHourly: 'Cost per hour',
        costHourlyPeak: 'Peak {value} ({hour})',
        costDaily: 'Cost per day',
        costDailyPeak: 'Peak {value} ({day})',
        pricesTitle: 'Price list',
        pricesHint: 'Fill in only the models you want to override; anything not listed uses the built-in price. Prices are in CNY per million tokens. Leave the date empty for a price that was always in force, and a cache-write cell empty when the model has no price of its own for one.',
        priceModel: 'Model',
        priceFrom: 'From',
        priceAdd: 'Add a row',
        priceRemove: 'Remove this row',
        pricesBad: 'Row {row} will not do: it needs a model name, and input and output cannot both be 0.',
        pricesBadNumber: 'Row {row} has something that is not a number where a price goes.',
        pricesBuiltin: 'Built-in prices',
        pricesPeak: 'peak ×2',
        pricesPeakNote: 'Weekdays 9:00-12:00 and 14:00-18:00 are peak and bill at double; weekends and public holidays bill at the table above all day.',
        total: 'Total tokens',
        input: 'Input',
        output: 'Output',
        cacheRead: 'Cache read',
        cacheWrite: 'Cache write',
        callCount: 'Calls',
        providers: 'Providers and models',
        settings: 'Settings',
        enable: 'Enable plugin',
        pollInterval: 'Refresh interval',
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
        probeInterval: 'Fetch interval',
        probeHint: 'Balances and plan windows move slowly, so they do not need to refresh as often as usage.',
        seconds: 's',
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

    /**
     * A money amount, in the price table's currency.
     *
     * The precision follows the magnitude rather than being fixed, because both
     * ends of the range are real: a whole day can be a few yuan, and a single
     * call in a cheap model is a fraction of a cent. Two decimals everywhere
     * would print every small amount as `¥0.00`, which reads as "free" rather
     * than "small"; thousands separators keep a large total readable.
     * @param {number} value - the amount.
     * @returns {string} the formatted amount.
     */
    function formatMoney(value) {
      const amount = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
      if (amount === 0) return '¥0.00'
      const decimals = amount >= 1 ? 2 : amount >= 0.01 ? 3 : 5
      const [whole, fraction] = amount.toFixed(decimals).split('.')
      const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
      return `¥${fraction === undefined ? grouped : `${grouped}.${fraction}`}`
    }

    /** The four fields of a price row, in the order the editor writes them. */
    const PRICE_FIELDS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite'])

    /** A non-negative finite number, or `undefined` when the field is absent or not one. */
    function priceNumber(value) {
      // An absent field and a zero field mean different things here: "no price
      // for this class" and "this class is free". `Number('')` is 0, so an empty
      // string has to be turned away before it becomes a price.
      if (value === undefined || value === null || value === '') return undefined
      const number = typeof value === 'number' ? value : Number(String(value).trim())
      return Number.isFinite(number) && number >= 0 ? number : undefined
    }

    /** A `YYYY-MM-DD` date, or an empty string. A shape check alone accepts `2026-02-30`. */
    function dateKey(value) {
      if (typeof value !== 'string') return ''
      const key = value.trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return ''
      const parts = key.split('-').map(Number)
      const date = new Date(parts[0], parts[1] - 1, parts[2])
      if (date.getFullYear() !== parts[0] || date.getMonth() !== parts[1] - 1 || date.getDate() !== parts[2]) return ''
      return key
    }

    /** Oldest first, with the undated row — the one that applies from the start — leading. */
    function byFrom(a, b) {
      if (a.from === b.from) return 0
      if (a.from === '') return -1
      if (b.from === '') return 1
      return a.from < b.from ? -1 : 1
    }

    /**
     * Fill in a price row the way the host does.
     *
     * The client re-implements this rather than importing it because a client
     * bundle cannot require plugin code — the host half is not on this side of the
     * wire. `test/client.test.mjs` pins the two together by feeding the same rows
     * to both and comparing the result.
     * @param {object} row - the raw fields.
     * @returns {object|undefined} the filled row, or `undefined` when unusable.
     */
    function priceRow(row) {
      // The same rule the host applies, field for field: a missing price is a
      // zero, and a row is unusable only when it has nothing to charge for. The
      // two halves have to agree here or a row the editor accepts is dropped
      // when the host stores it — the user is told the save worked and the row
      // silently disappears.
      const input = priceNumber(row?.input) ?? 0
      const output = priceNumber(row?.output) ?? 0
      if (input <= 0 && output <= 0) return undefined
      return {
        // The day this price starts to apply. Empty means "from the start", which
        // is what a row the user did not date means: they typed a price, not a
        // price change.
        from: dateKey(row?.from),
        input,
        output,
        cacheRead: priceNumber(row?.cacheRead) ?? 0,
        // No fallback, exactly as the host does it: a model that publishes no
        // cache-write price bills nothing for cache writes, so an empty cell is
        // stored as 0 rather than borrowing the input rate and inventing a charge.
        cacheWrite: priceNumber(row?.cacheWrite) ?? 0,
        // Carried so the two normalizers agree field for field. A row typed here
        // is a flat number, so it is always false; the flag is what tells the
        // host a price book publishes a peak rate on top of its off-peak one.
        offPeak: row?.offPeak === true,
      }
    }

    /** A model name that would land on a prototype rather than in the table. */
    function unsafeModel(model) {
      return model === '__proto__' || model === 'constructor' || model === 'prototype'
    }

    /**
     * A price table as the editor's rows, one per dated row, sorted by model then date.
     *
     * A model can carry several rows — a price change is a second row, not an edit
     * of the first — so the grid shows one line per period. Every cell is a string
     * here because that is what an input holds: a half-typed `0.` must survive a
     * re-render.
     * @param {object|undefined} prices - `{model: row}` or `{model: [row, ...]}`.
     * @returns {object[]} the rows.
     */
    function priceRowsFrom(prices) {
      const table = prices ?? {}
      const rows = []
      for (const model of Object.keys(table).sort()) {
        const entry = table[model]
        for (const raw of Array.isArray(entry) ? entry : [entry]) {
          const row = priceRow(raw)
          if (row === undefined) continue
          rows.push({
            model,
            from: row.from,
            input: String(row.input),
            output: String(row.output),
            cacheRead: String(row.cacheRead),
            cacheWrite: String(row.cacheWrite),
            offPeak: row.offPeak,
          })
        }
      }
      return rows
    }

    /**
     * Read the editor's rows back into a table.
     *
     * A row with nothing in it at all is an empty slot the user has not filled in
     * yet, not a mistake — only a row that has *something* and is still unusable
     * is reported. The bad rows are named by their position so the message can
     * point at the row on screen.
     * @param {object[]} rows - the editor's rows.
     * @returns {{prices: object, errors: object[]}} the table and the failed rows.
     */
    function pricesFromRows(rows) {
      const prices = {}
      const errors = []
      const list = Array.isArray(rows) ? rows : []
      for (let index = 0; index < list.length; index += 1) {
        const row = list[index] ?? {}
        const model = String(row.model ?? '').trim().toLowerCase()
        const values = PRICE_FIELDS.map((field) => priceNumber(row[field]))
        if (model === '' && values.every((value) => value === undefined)) continue
        // A cell with something in it that is not a number is a mistake, not an
        // empty cell. Left alone it would be read as `undefined` and stored as
        // zero, so the user would be billed nothing for a price they can see they
        // typed. Only the four price cells are examined: the model cell is text.
        const unreadable = PRICE_FIELDS.some((field, at) => {
          const raw = row[field]
          const text = raw === undefined || raw === null ? '' : String(raw).trim()
          return text !== '' && values[at] === undefined
        })
        if (unreadable) {
          errors.push({ row: index + 1, kind: 'number' })
          continue
        }
        if (model === '' || unsafeModel(model) || values[0] === undefined || values[1] === undefined) {
          errors.push({ row: index + 1, kind: 'row' })
          continue
        }
        const priced = priceRow({
          from: row.from,
          input: values[0],
          output: values[1],
          cacheRead: values[2],
          cacheWrite: values[3],
        })
        const series = prices[model] ?? []
        // Two rows for one model and one date contradict each other, so the later
        // one wins rather than being sent as a pair the host would have to choose
        // between.
        const at = series.findIndex((entry) => entry.from === priced.from)
        if (at >= 0) series[at] = priced
        else series.push(priced)
        prices[model] = series
      }
      for (const series of Object.values(prices)) series.sort(byFrom)
      return { prices, errors }
    }

    /** A price table's canonical spelling, for comparing two of them. */
    function canonicalPrices(prices) {
      return priceRowsFrom(prices)
        .map((row) => `${row.model} @ ${row.from} = ${row.input}, ${row.output}, ${row.cacheRead}, ${row.cacheWrite}`)
        .join('\n')
    }

    /** An empty editor row, so a fresh table still has somewhere to type. */
    function blankPriceRow() {
      return { model: '', from: '', input: '', output: '', cacheRead: '', cacheWrite: '' }
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

    const STYLE_ID = 'dsh-abacus-styles'

    /**
     * The plugin's whole stylesheet, injected once.
     *
     * Everything is scoped by the `dab-` class prefix and every colour comes
     * from a `--dsw-*` theme token (or `currentColor`), so the card, the pill
     * and the settings page follow the active theme and skin — including a
     * user skin that remaps those tokens — instead of fighting them.
     */
    const CSS = `
.dab-foot{position:relative;box-sizing:border-box;width:100%;margin:2px 0 4px;border:none;border-radius:var(--dsw-radius-sm,10px);background:transparent;color:inherit;transition:background-color 120ms ease}
.dab-foot:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent))}
.dab-foot-main{appearance:none;box-sizing:border-box;display:flex;flex-direction:column;gap:4px;width:100%;padding:8px;border:none;border-radius:var(--dsw-radius-sm,10px);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dab-foot-main:focus-visible{outline:none;box-shadow:0 0 0 var(--dsw-focus-ring-width,2px) color-mix(in srgb,currentColor 45%,transparent)}
.dab-foot-main svg,.dab-foot-title svg{display:block}
/* The three things on this line — the gauge, the label, the figure — are centred
   as boxes and given one shared line box, so their text sits on one baseline.
   Aligning them by baseline instead put the label high: its baseline came from
   the gauge (a replaced element, whose baseline is its bottom edge), not from
   the words next to it. */
.dab-foot-head{display:flex;align-items:center;gap:6px;min-width:0}
.dab-foot-title{display:inline-flex;align-items:center;gap:6px;min-width:0;flex:0 2 auto;overflow:hidden;font-size:12px;line-height:16px;opacity:.65;white-space:nowrap;text-overflow:ellipsis}
.dab-foot-title svg{flex:none}
/* The figure takes the right edge and the chevron trails it, so the line reads
   label-left / value-right like every other row in the sidebar. Pushing the
   chevron instead would strand the number in the middle of the row. The figure
   is one step up from the label (13px against 12px), not a size and a half: at
   15px it read as a heading sitting in a list of rows. */
.dab-foot-value{flex:0 1 auto;margin-left:auto;min-width:0;max-width:100%;overflow:hidden;font-size:13px;line-height:16px;font-weight:600;font-variant-numeric:tabular-nums;white-space:nowrap;text-overflow:ellipsis}
.dab-foot-chevron{flex:none;display:inline-flex;align-items:center;opacity:.45;transition:transform 140ms ease}
.dab-foot:hover .dab-foot-chevron{opacity:.75}
/* The icon flips its own path, so there is no transform here: rotating it as
   well cancelled the flip and left the chevron pointing down in both states. */
.dab-foot-line{font-size:11px;opacity:.7;font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dab-foot-meta{font-size:10px;opacity:.5;font-variant-numeric:tabular-nums}
.dab-foot-detail{display:flex;flex-direction:column;gap:10px;margin-top:2px;padding-top:7px;border-top:.5px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 12%,transparent))}
.dab-row{display:flex;align-items:baseline;gap:6px;font-size:11px;line-height:14px;min-width:0}
.dab-row-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dab-row-value{flex:none;font-variant-numeric:tabular-nums;opacity:.85}
.dab-row-provider .dab-row-name{font-weight:500}
/* A provider is a block — its line, its share bar, its models — so the groups
   stay legible in a rail this narrow. The bar is full width rather than an
   inline stub: at 34px it read as a stray dash sitting in front of the name. */
.dab-foot-provider{display:flex;flex-direction:column;gap:4px}
.dab-share{display:block;height:3px;border-radius:999px;background:color-mix(in srgb,currentColor 12%,transparent);overflow:hidden}
.dab-share > i{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary,currentColor);opacity:.5}
.dab-foot-models{display:flex;flex-direction:column;gap:3px;padding-left:9px;border-left:.5px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 12%,transparent))}
.dab-row-model{opacity:.62}
.dab-foot-more{font-size:10px;opacity:.5}

/* Collapsed rail: the 56px sidebar has no room for a card. */
[data-sidebar-collapsed] .dab-foot{display:none}

/* Composer dock pill: matches the shell's own stats pills exactly, because it
   sits in the same flex row and any deviation reads as a seam. The font size
   and line height are restated rather than inherited: the shell sets them on
   its own stats container, which is a sibling of this entry, not an ancestor. */
.dab-pill{box-sizing:border-box;corner-shape:round;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));font-variant-numeric:tabular-nums;white-space:nowrap;background:0 0;border:none;border-radius:999px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}
.dab-pill:hover,.dab-pill[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dab-pill svg{display:block;flex:none}
.dab-pill-value{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}

/* The pill's own box in the dock row. The row's flex gap lands here now that
   the pill is wrapped with its panel, so this has to be the flex item. */
.dab-meter-root{position:relative;flex:none;display:inline-flex;min-width:0}

/* The panel the composer pill opens. Every value here is the one the shell's
   own context meter uses on its panel — same menu fill, same backdrop filter,
   same prominent elevation, same radius and metrics — because these two panels
   can be open at the same moment and any deviation would read as a seam. */
.dab-meter{position:fixed;z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2,currentColor));width:min(264px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter,none);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent,0 8px 24px rgb(0 0 0/.18));color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:12px;font-size:12px;line-height:20px;max-height:calc(100vh - 24px);overflow-y:auto;overscroll-behavior:contain}
.dab-meter-head{align-items:center;gap:6px;display:flex}
.dab-meter-title{color:var(--dsw-alias-label-tertiary)}
.dab-meter-figures{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin-left:auto;font-weight:500}
.dab-meter-bar{corner-shape:round;background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;gap:1px;height:4px;margin:10px 0 12px;display:flex;overflow:hidden}
.dab-meter-segment{background:var(--dab-tint,var(--dsw-alias-label-tertiary));border-radius:1px;flex:none;min-width:2px;height:100%}
.dab-meter-rows{margin:6px 0 0}
.dab-meter-row{justify-content:space-between;align-items:center;gap:12px;padding:2px 0;display:flex}
.dab-meter-row dt{color:var(--dsw-alias-label-secondary);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dab-meter-row dd{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);margin:0;flex:none}
.dab-meter-model dt{color:var(--dsw-alias-label-tertiary);padding-left:14px}
.dab-meter-model dd{color:var(--dsw-alias-label-secondary)}
.dab-meter-swatch{background:var(--dab-tint,var(--dsw-alias-label-tertiary));vertical-align:baseline;border-radius:2px;width:8px;height:8px;margin-right:6px;display:inline-block}
.dab-meter-note{color:var(--dsw-alias-label-tertiary);padding:2px 0;word-break:break-word}
/* Bar and swatch tints. The shell ships one hue per semantic family, so the
   *order* is what keeps neighbouring rows apart. It used to run deepseek-450
   then blue-450 — #5686fe and #4d93f8, two mid-blues that read as the same
   colour on an 8px swatch — which is exactly what "the providers are not
   colour-coded" meant. The second row takes amber, the two blues are separated
   by a green, and the fifth slot is a grey so a six-provider panel does not end
   on a second blue. Each falls back to a label colour, so a renamed static
   token degrades to a readable monochrome meter instead of an invisible one. */
.dab-tint-0{--dab-tint:var(--dsw-static-deepseek-450,var(--dsw-alias-label-secondary))}
.dab-tint-1{--dab-tint:var(--dsw-static-amber-400,var(--dsw-alias-label-secondary))}
.dab-tint-2{--dab-tint:var(--dsw-static-green-500,var(--dsw-alias-label-secondary))}
.dab-tint-3{--dab-tint:var(--dsw-static-blue-600,var(--dsw-alias-label-secondary))}
.dab-tint-4{--dab-tint:var(--dsw-static-neutral-bluish-400,var(--dsw-alias-label-secondary))}
.dab-tint-5{--dab-tint:var(--dsw-static-red-400,var(--dsw-alias-label-secondary))}

/* Settings section */
.dab-section{display:flex;flex-direction:column;gap:16px;min-width:0;color:var(--dsw-alias-label-primary)}
.dab-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
/* Title and freshness stack as one lockup, so the button beside them lines up
   with the title's own cap height instead of floating in the middle of the
   pair. The shape is the shell settings dialog's page title (a heading above a
   dimmed line of metadata), carried one step heavier than the dialog's own
   16px/500: the cards under it title themselves at 14px/500, and a heading that
   sits that close to its own card titles reads as another card title. */
.dab-head-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.dab-head-title{font-size:18px;font-weight:600;line-height:26px;letter-spacing:.01em;color:var(--dsw-alias-label-primary)}
.dab-head-sub{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dab-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:none}
.dab-button{appearance:none;box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;height:32px;padding:0 14px;border:.5px solid var(--dsw-alias-border-l3,color-mix(in srgb,currentColor 22%,transparent));border-radius:var(--dsw-radius-md,10px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;transition:background-color 120ms ease,border-color 120ms ease}
.dab-button:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent))}
.dab-button:focus-visible{outline:none;box-shadow:0 0 0 var(--dsw-focus-ring-width,2px) color-mix(in srgb,currentColor 45%,transparent)}
.dab-button[disabled]{opacity:.4;cursor:default}
/* The save button is the only filled control on the page: the shell reserves
   its primary fill for the one action it wants the reader to take. */
.dab-button-primary{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,currentColor));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-label-primary))}
.dab-button-primary:hover{background:var(--dsw-alias-button-primary-hover,var(--dsw-alias-brand-primary,currentColor))}
.dab-button-primary[disabled]{background:var(--dsw-alias-button-primary-fill,var(--dsw-alias-brand-primary,currentColor))}
.dab-tabs{display:flex;align-items:center;gap:4px;border-bottom:.5px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 12%,transparent))}
.dab-tab{appearance:none;position:relative;padding:8px 12px;border:none;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;border-radius:var(--dsw-radius-sm,8px) var(--dsw-radius-sm,8px) 0 0}
.dab-tab:hover{color:var(--dsw-alias-label-secondary)}
.dab-tab[aria-selected="true"]{color:var(--dsw-alias-brand-text,var(--dsw-alias-label-primary))}
/* The selected tab's mark spans the tab exactly and sits on the row's own
   hairline, so the two read as one line that thickens and takes the brand
   colour rather than as two bars of different lengths. The radius and the
   un-bolded weight follow dsh's own settings tabs (ui-settings-plugins). */
.dab-tab[aria-selected="true"]::after{content:"";position:absolute;left:0;right:0;bottom:-1px;height:2px;border-radius:2px 2px 0 0;background:var(--dsw-alias-brand-primary,currentColor)}
.dab-tab:focus-visible{outline:none;box-shadow:0 0 0 var(--dsw-focus-ring-width,2px) color-mix(in srgb,currentColor 45%,transparent)}
.dab-card{display:flex;flex-direction:column;gap:12px;padding:12px 16px;border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 14%,transparent)));border-radius:var(--dsw-radius-xl,16px);background:var(--dsw-alias-settings-card-fill,transparent)}
.dab-card-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dab-card-title{font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}
.dab-card-note{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.dab-select{appearance:none;height:26px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 18%,transparent));border-radius:var(--dsw-radius-xs,6px);background:var(--dsw-alias-bg-layer-2,transparent);color:inherit;font:inherit;font-size:12px;cursor:pointer}
/* The summary strip. Six figures strung along the left of a wide card read as
   cramped and leave the right half of the card empty, so each one owns an equal
   column and a hairline separates them: the figures then describe the whole card
   instead of huddling in its corner.
   The gutter and the figure size are what make six of them fit: at the settings
   dialog's width the strip is ~518px, so six columns leave ~86px each. A 14px
   gutter and a 20px figure needed 56px of text room for a figure that is 44-56px
   wide, and every column but the first was ellipsised — the numbers were
   unreadable, which is worse than a tighter gutter. */
.dab-metrics{display:flex;align-items:flex-start;padding:14px 0 2px;border-top:.5px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 10%,transparent))}
.dab-metric{display:flex;flex-direction:column;gap:3px;flex:1 1 0;min-width:0;padding:0 8px}
.dab-metric:first-child{padding-left:0}
.dab-metric + .dab-metric{border-left:.5px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 10%,transparent))}
.dab-metric-value{font-size:18px;font-weight:600;font-variant-numeric:tabular-nums;line-height:24px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dab-metric-label{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dab-list{display:flex;flex-direction:column;gap:10px}
.dab-provider{display:flex;flex-direction:column;gap:6px}
.dab-provider-head{display:flex;align-items:baseline;gap:8px;font-size:12px}
.dab-badge{flex:none;padding:0 5px;border-radius:4px;background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 10%,transparent));color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:15px}
/* The low-quota reminder dot. It is the one place this plugin deliberately
   leaves the shell's own palette: a warning that inherits the theme's ink would
   not read as a warning. The static red token is a shell token, so it still
   follows the theme, and the fallback keeps the dot visible if the token is
   ever renamed rather than silently dropping the mark. */
.dab-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-static-red-400,currentColor);align-self:center}
.dab-provider-total{margin-left:auto;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
/* One grid per model row, but a *fixed* name column, so every bar on the card
   starts on the same x no matter how long the model name is. A flex row sized
   its own leading column per row, which pushed each bar to a different left
   edge. */
.dab-model{display:grid;grid-template-columns:var(--dab-model-name,132px) minmax(0,1fr) 52px;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dab-model-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dab-model-bar{height:4px;border-radius:999px;background:color-mix(in srgb,currentColor 10%,transparent);overflow:hidden;min-width:20px}
.dab-model-bar > i{display:block;height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary,currentColor);opacity:.55}
.dab-model-total{font-variant-numeric:tabular-nums;text-align:right}
/* The money breakdown: two columns and no bar. A share bar would say "how much
   of the bill", which the number beside it already says, and the row is narrow
   enough that a bar would be the only thing the eye lands on. */
.dab-cost-row{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:baseline;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dab-cost-row-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dab-cost-row-value{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
/* Balance rows and plan windows: a name column, a value column, and the same
   4px share bar the usage tab draws, so all three tabs read as one surface. */
.dab-stack{display:flex;flex-direction:column;gap:12px}
.dab-vendor-row{display:flex;align-items:baseline;gap:8px;font-size:12px}
.dab-vendor-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dab-vendor-value{margin-left:auto;flex:none;max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
/* One grid per provider, not one flex row per window: the columns then line up
   across the windows of that provider no matter how long each reset stamp is.
   The last column is auto, which grid resolves once for the whole container —
   that is the part a per-row flex box cannot do. */
.dab-windows{display:grid;grid-template-columns:60px minmax(0,1fr) 40px auto;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dab-window{display:contents}
.dab-window-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.dab-window-percent{text-align:right;font-variant-numeric:tabular-nums}
.dab-window-reset{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.dab-plan-block{display:flex;flex-direction:column;gap:8px;padding-top:10px;border-top:.5px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 12%,transparent))}
.dab-plan-block:first-child{padding-top:0;border-top:none}
/* The collapsed tail of the account tab: every provider whose facts could not
   be fetched. A disclosure rather than a card, because it answers "why is my
   provider missing" — it is not a number anyone reads twice. */
.dab-fold{border-top:.5px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 12%,transparent))}
.dab-fold-summary{display:flex;align-items:center;gap:6px;padding-top:8px;font-size:12px;color:var(--dsw-alias-label-tertiary);cursor:pointer;list-style:none}
.dab-fold-summary::-webkit-details-marker{display:none}
.dab-fold-summary::before{content:"▸";flex:none;font-size:10px;transition:transform 140ms ease}
.dab-fold[open] > .dab-fold-summary::before{transform:rotate(90deg)}
.dab-fold-body{display:flex;flex-direction:column;gap:8px;padding-top:8px}
/* Settings panels. The shell's own settings pages put one topic in one card,
   name the topic on its own line, and give every setting a row underneath:
   what it is on the left, the control on the right, the explanation under the
   name. These classes are that shape, at the dialog's own metrics
   (--dsw-radius-xl card, 40px rows, 32px controls, .5px border-l4 inputs). */
.dab-panel{display:flex;flex-direction:column;padding:12px 16px;border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 14%,transparent)));border-radius:var(--dsw-radius-xl,16px);background:var(--dsw-alias-settings-card-fill,transparent)}
.dab-panel-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:32px}
.dab-panel-title{font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}
.dab-panel-note{padding:2px 0 4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dab-form-row{display:grid;grid-template-columns:1fr auto;align-items:center;gap:16px;min-height:40px;padding:6px 0}
.dab-form-text{display:flex;flex-direction:column;gap:2px;min-width:0}
.dab-form-label{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}
.dab-form-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dab-form-control{display:flex;align-items:center;justify-content:flex-end;gap:6px}
.dab-suffix{flex:none;width:12px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dab-trend{display:flex;flex-direction:column;gap:8px}
.dab-trend-axis{display:flex;justify-content:space-between;font-size:10px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
/* Per-day bars for the selected range. Each column is a flex child so a
   180-day window stays legible by simply getting thinner, with no scrolling.
   The row never overflows: a window longer than CHART_MAX_DAYS is drawn from
   its most recent days only, so the columns keep a floor width. */
.dab-chart{display:flex;align-items:flex-end;gap:2px;height:104px;padding-top:4px;overflow:hidden;border-bottom:.5px solid var(--dsw-alias-border-l1,color-mix(in srgb,currentColor 10%,transparent))}
.dab-chart-col{flex:1;min-width:2px;height:100%;display:flex;align-items:flex-end;border-radius:2px}
.dab-chart-col:hover{background:color-mix(in srgb,currentColor 8%,transparent)}
.dab-chart-bar{width:100%;min-height:2px;border-radius:2px;background:var(--dsw-alias-brand-primary,currentColor);opacity:.6}
.dab-chart-col:hover .dab-chart-bar{opacity:.9}
.dab-ranges{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dab-range{appearance:none;height:26px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 18%,transparent));border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.dab-range:hover{background:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 8%,transparent))}
/* The picked range is the one filled control on the page, so its label takes
   the on-brand foreground. It used to take --dsw-alias-brand-text, which is the
   brand colour *as ink* — the same near-black the fill is — and the label
   vanished on a stock theme (only a skin that remaps the brand colour hid the
   mistake). --dsw-alias-label-primary-foreground is the token that means "text
   on a brand fill". */
.dab-range[aria-pressed="true"]{background:var(--dsw-alias-brand-primary,color-mix(in srgb,currentColor 16%,transparent));border-color:transparent;color:var(--dsw-alias-label-primary-foreground,var(--dsw-static-neutral-bluish-00,#fff));font-weight:600}
.dab-range:focus-visible{outline:none;box-shadow:0 0 0 var(--dsw-focus-ring-width,2px) color-mix(in srgb,currentColor 45%,transparent)}
.dab-range-dates{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dab-empty{padding:10px 0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dab-field{display:flex;align-items:center;gap:10px;font-size:12px}
.dab-field-label{flex:1;min-width:0;color:var(--dsw-alias-label-secondary)}
.dab-input{box-sizing:border-box;width:132px;height:32px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4,color-mix(in srgb,currentColor 26%,transparent));border-radius:var(--dsw-radius-md,10px);background:var(--dsw-alias-bg-layer-1,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;font-variant-numeric:tabular-nums}
.dab-input:focus{border-color:var(--dsw-alias-state-business-primary,currentColor);outline:none;box-shadow:0 0 0 var(--dsw-focus-ring-width,2px) color-mix(in srgb,currentColor 22%,transparent)}
/* The price editor: one row per model, five cells and a remove button. The
   columns are fixed so the cells line up into a table, and the model name takes
   whatever is left — it is the only field whose length is unpredictable. */
.dab-prices{display:flex;flex-direction:column;gap:6px;padding:4px 0 2px}
.dab-price-head,.dab-price-row{display:grid;grid-template-columns:minmax(0,1fr) 112px 58px 58px 58px 58px 22px;gap:6px;align-items:center}
.dab-price-head{padding:0 2px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dab-price-head > span:not(:first-child){text-align:center}
.dab-price-row .dab-input{width:100%;height:28px;padding:0 6px;font-size:12px;line-height:20px;text-align:center}
.dab-price-row .dab-price-model{text-align:left;font-variant-numeric:normal}
.dab-price-row .dab-price-from{text-align:left;font-variant-numeric:normal;font-size:11px;padding:0 4px}
.dab-price-actions{display:flex;justify-content:center;padding:2px 0 0}
.dab-price-builtin{display:grid;grid-template-columns:auto 1fr auto;gap:2px 8px;align-items:center;margin-top:2px;padding:8px 10px;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-layer-2,color-mix(in srgb,currentColor 4%,transparent));font-size:11px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dab-price-builtin-title{grid-column:1 / -1;color:var(--dsw-alias-label-secondary)}
.dab-price-builtin-row{display:contents}
.dab-price-builtin-model{font-variant-numeric:normal;color:var(--dsw-alias-label-secondary)}
.dab-price-builtin-cell{font-variant-numeric:tabular-nums}
.dab-price-builtin-peak{color:var(--dsw-alias-label-secondary)}
.dab-price-builtin-note{grid-column:1 / -1;margin-top:2px}
.dab-price-remove{display:flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:none;border-radius:var(--dsw-radius-xs,6px);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:14px;line-height:1;cursor:pointer}
.dab-price-remove:hover{background:var(--dsw-alias-bg-layer-2,color-mix(in srgb,currentColor 10%,transparent));color:var(--dsw-alias-label-primary)}
/* A select needs the input's box but not its fixed width or its tabular
   figures, and the shell draws no arrow of its own for one. */
.dab-select{width:auto;min-width:160px;max-width:100%;font-variant-numeric:normal}
/* Two boxes side by side need a fixed width each: a select sizes itself to its
   longest option, so without one the pair ate the label standing beside them,
   and with only a ceiling the row jumped every time the choice changed. */
.dab-scope-select{width:172px;min-width:0}
/* Numbers sit on the right edge of their control so the digits line up down
   the column, which is the whole point of a column of numbers. */
.dab-form-row .dab-input{text-align:right}
/* A choice reads from the left, even though it borrows the input's box: a
   centred name in a box this wide reads as a value rather than a pick, and the
   open list inherits the alignment, so its entries would stagger too. */
.dab-form-row .dab-select{text-align:left}
.dab-check{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary,currentColor);cursor:pointer}
.dab-note{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:16px}
.dab-version{margin-right:auto;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-dimmed));font-variant-numeric:tabular-nums}
.dab-note code{font-family:var(--dsw-font-markdown-code-font-family,monospace);font-size:11px;padding:1px 4px;border-radius:4px;background:var(--dsw-alias-markdown-inline-code,color-mix(in srgb,currentColor 10%,transparent))}
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

    /**
     * A timeout signal, optionally raced with the caller's own.
     *
     * `AbortSignal.any` is recent, so an older page simply keeps the timeout: the
     * request still cannot hang, it just cannot be cancelled early.
     * @param {AbortSignal} [signal] - the caller's own signal, when it has one.
     * @returns {AbortSignal} the signal to hand to `fetch`.
     */
    function timed(signal) {
      const timeout = AbortSignal.timeout(20_000)
      if (signal === undefined || typeof AbortSignal.any !== 'function') return timeout
      return AbortSignal.any([timeout, signal])
    }

    const api = {
      /** @returns {Promise<object>} the overview document. */
      async overview() {
        const response = await fetch('api/abacus/overview', { signal: timed() })
        if (!response.ok) throw new Error(`overview ${response.status}`)
        return field(await response.json(), 'overview')
      },
      /**
       * @param {string} date - a `YYYY-MM-DD` local date.
       * @returns {Promise<object>} that day's detail.
       */
      async day(date) {
        const response = await fetch(`api/abacus/day?date=${encodeURIComponent(date)}`, { signal: timed() })
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
        const response = await fetch(`api/abacus/range?${query}`, { signal: timed() })
        if (!response.ok) throw new Error(`range ${response.status}`)
        return field(await response.json(), 'range')
      },
      /** @returns {Promise<object>} a freshly assembled overview. */
      async refresh() {
        const response = await fetch('api/abacus/refresh', { method: 'POST', signal: AbortSignal.timeout(20_000) })
        if (!response.ok) throw new Error(`refresh ${response.status}`)
        return field(await response.json(), 'overview')
      },
      /**
       * One conversation's totals and its own per-provider, per-model
       * breakdown. Fetched on demand — the composer badge only asks when its
       * panel is opened, so a closed panel costs nothing.
       * @param {string} sessionId - the session id from the slot's props.
       * @param {AbortSignal} [signal] - lets the caller drop the request when the
       *   panel closes or the conversation moves on to another reading.
       * @returns {Promise<object>} the session view.
       */
      async session(sessionId, signal) {
        const response = await fetch(`api/abacus/session?id=${encodeURIComponent(sessionId)}`, { signal: timed(signal) })
        if (!response.ok) throw new Error(`session ${response.status}`)
        return field(await response.json(), 'session')
      },
      /** @returns {Promise<object>} the cached vendor facts. */
      async providers() {
        const response = await fetch('api/abacus/providers', { signal: timed() })
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
        const response = await fetch('api/abacus/probe', { method: 'POST', signal: AbortSignal.timeout(60_000) })
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
        const response = await fetch('api/abacus/backfill', { method: 'POST', signal: AbortSignal.timeout(60_000) })
        if (!response.ok) throw new Error(`backfill ${response.status}`)
        return field(await response.json(), 'backfill')
      },
      /**
       * @param {object} patch - the partial config update.
       * @returns {Promise<object>} the config after the update.
       */
      async saveConfig(patch) {
        const response = await fetch('api/abacus/config', {
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

    //#region ------------------------------------------------- storage migration

    /**
     * Preferences this plugin wrote before 2.0.0, when it was called
     * `dsh-usage-stat`, paired with the keys this build reads.
     *
     * Spelled out rather than derived from a prefix scan: the DOM stand-in the
     * tests drive offers `getItem`/`setItem` only, and three named keys say
     * more than a loop over a fake storage. The current keys are declared where
     * they are used (the card, the range picker); these are the stale ones, and
     * nothing else in the bundle may reference them.
     */
    const LEGACY_STORAGE_KEYS = [
      ['dsh-usage-stat.foot-card.expanded', 'dsh-abacus.foot-card.expanded'],
      ['dsh-usage-stat.range-preset', 'dsh-abacus.range-preset'],
      ['dsh-usage-stat.range-custom', 'dsh-abacus.range-custom'],
    ]

    /**
     * Carry the pre-rename preferences across, once.
     *
     * Only an absent destination is written, so a choice made after the rename
     * is never overwritten by the stale copy, and the old keys are left in
     * place — they are three short strings, and a downgrade would otherwise
     * lose them silently. Blocked or full storage leaves the defaults, which
     * are what a new install sees anyway.
     */
    function migrateStoredKeys() {
      try {
        const store = window.localStorage
        for (const [from, to] of LEGACY_STORAGE_KEYS) {
          if (store.getItem(to) !== null) continue
          const value = store.getItem(from)
          if (value !== null) store.setItem(to, value)
        }
      } catch {
        // Storage unavailable; nothing to migrate and nothing to report.
      }
    }

    //#endregion

    //#region ----------------------------------------------------------- foot card

    /** localStorage key holding the card's expanded flag. */
    const FOOT_EXPANDED_KEY = 'dsh-abacus.foot-card.expanded'

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
        { className: `dab-row${props.variant === undefined ? '' : ` ${props.variant}`}` },
        props.dot === undefined ? null : h(AlertDot, { title: props.dot }),
        h('span', { className: 'dab-row-name', title: props.title ?? props.name }, props.name),
        h('span', { className: 'dab-row-value' }, props.value),
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
          { className: 'dab-foot', 'data-dsh-plugin': 'abacus', 'data-dsh-part': 'foot-card' },
          h('div', { className: 'dab-foot-main', style: { cursor: 'default' } },
            h('span', { className: 'dab-foot-head' },
              h('span', { className: 'dab-foot-title' }, h(GaugeIcon), t('title')),
              h('span', { className: 'dab-foot-value' }, '—')),
            h('span', { className: 'dab-foot-line' }, t('hostOff'))),
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
            { className: 'dab-foot-detail' },
            providers.length === 0
              ? h('span', { className: 'dab-foot-line' }, t('noData'))
              : providers.map((provider) => {
                  const value = totalOf(provider.totals)
                  const models = (provider.models ?? []).slice(0, FOOT_MODEL_CAP)
                  return h(
                    'div',
                    { key: provider.provider, className: 'dab-foot-provider' },
                    h(UsageRow, {
                      name: provider.displayName ?? provider.provider,
                      value: formatTokens(value),
                      variant: 'dab-row-provider',
                      dot: dotFor(alertIndex, provider.provider),
                    }),
                    h('span', { className: 'dab-share' }, h('i', { style: { width: `${Math.round((value / heaviest) * 100)}%` } })),
                    models.length === 0 ? null : h(
                      'div',
                      { className: 'dab-foot-models' },
                      models.map((model) => h(UsageRow, {
                        key: `${provider.provider}:${model.model}`,
                        name: model.model,
                        value: formatTokens(totalOf(model.totals)),
                        variant: 'dab-row-model',
                      })),
                    ),
                  )
                }),
            hiddenProviders > 0 ? h('span', { className: 'dab-foot-more' }, t('more', { n: hiddenProviders })) : null,
          )
        : null

      return h(
        'div',
        { className: 'dab-foot', 'data-dsh-plugin': 'abacus', 'data-dsh-part': 'foot-card' },
        h(
          'button',
          {
            type: 'button',
            className: 'dab-foot-main',
            'data-dsh-part': 'foot-card-main',
            'aria-expanded': expanded,
            'aria-label': expanded ? t('collapse') : t('expand'),
            title: headline,
            onClick: toggle,
          },
          h(
            'span',
            { className: 'dab-foot-head' },
            h('span', { className: 'dab-foot-title' }, h(GaugeIcon), t('today')),
            h('span', { className: 'dab-foot-value' }, `${formatTokens(total)} tokens`),
            // The chevron is the header row's only affordance and it only
            // toggles. An icon that opened the settings panel instead read as a
            // second account button, which is not what a chevron promises.
            h('span', { className: 'dab-foot-chevron', 'data-expanded': expanded }, h(ChevronIcon, { expanded })),
          ),
          detail,
          // The call count and the fold time are detail, so the rail keeps the
          // one number that answers "how much today" and nothing else. The
          // count is still in the button's tooltip, for a hover without a click.
          expanded
            ? h(
                'span',
                { className: 'dab-foot-meta' },
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
    const PROVIDER_TINTS = ['dab-tint-0', 'dab-tint-1', 'dab-tint-2', 'dab-tint-3', 'dab-tint-4', 'dab-tint-5']

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
     * then rather than flashing at the origin. It re-measures when the panel
     * changes size and when the page scrolls, and `.dab-meter` caps its own
     * height at `100vh - 2 * PANEL_MARGIN`, so a long body scrolls inside the
     * panel rather than leaving the window.
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
        // The panel's body arrives after it opens — the facts come back from the
        // host a moment later — so the height measured at open is the height of
        // the loading state. Placing once let the grown panel extend past the
        // trigger and off the bottom of the window. Re-place whenever the panel
        // changes size, and follow the trigger when anything scrolls.
        window.addEventListener('scroll', place, true)
        let observer
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(place)
          if (panelRef.current !== null && panelRef.current !== undefined) observer.observe(panelRef.current)
          // The trigger moves too, and without being scrolled: typing a second
          // line into the composer pushes the whole row up. Watching only the
          // panel left it sitting where the trigger used to be.
          if (anchorRef.current !== null && anchorRef.current !== undefined) observer.observe(anchorRef.current)
        }
        return () => {
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
          if (observer !== undefined) observer.disconnect()
        }
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
          { className: 'dab-meter-head', key: 'head' },
          h('span', { className: 'dab-meter-title' }, t('session')),
          h('span', { className: 'dab-meter-figures' }, `${formatTokens(total)} tokens`),
        ),
        h(
          'div',
          { className: 'dab-meter-bar', key: 'bar' },
          segments.map((segment) => h('div', {
            key: segment.key,
            className: `dab-meter-segment ${segment.tint}`,
            'data-dsh-part': 'session-segment',
            style: { width: `${segment.share}%` },
          })),
        ),
        h(
          'dl',
          { className: 'dab-meter-rows', key: 'rows' },
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
        return [h('div', { className: 'dab-meter-note', key: 'loading' }, t('loading'))]
      }
      if (props.error !== '') {
        return [h('div', { className: 'dab-meter-note', key: 'error' }, `${t('error')} · ${props.error}`)]
      }
      const facts = props.facts
      if (facts === null || facts === undefined) {
        return [h('div', { className: 'dab-meter-note', key: 'idle' }, t('loading'))]
      }
      const providers = facts.providers ?? []
      if (providers.length === 0) {
        // The pill only renders when the projection reports usage, so an empty
        // breakdown means this conversation was recorded before the breakdown
        // existed — say so rather than implying the tokens are unattributed.
        return [h('div', { className: 'dab-meter-note', key: 'none' }, t('sessionNoBreakdown'))]
      }
      const rows = []
      providers.forEach((row, index) => {
        rows.push(h(
          'div',
          { className: 'dab-meter-row', key: `p-${row.provider}` },
          h('dt', null, h('span', { className: `dab-meter-swatch ${tintOf(index)}`, 'data-dsh-part': 'session-swatch', 'aria-hidden': true }), row.displayName ?? row.provider),
          h('dd', null, formatTokens(totalOf(row.totals))),
        ))
        for (const model of row.models ?? []) {
          rows.push(h(
            'div',
            { className: 'dab-meter-row dab-meter-model', key: `m-${row.provider}-${model.model}` },
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
        // Closing the panel, or a new settlement moving `total`, makes the answer
        // on its way worthless — so stop asking rather than wait out the timeout.
        const controller = new AbortController()
        setLoading(true)
        setError('')
        api.session(sessionId, controller.signal).then(
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
          controller.abort()
        }
      }, [open, sessionId, total])

      if (total <= 0) return null

      const label = `${t('session')} · ${formatTokens(total)} tokens`
      const trigger = h(
        'button',
        {
          type: 'button',
          ref: rootRef,
          className: 'dab-pill',
          'data-dsh-plugin': 'abacus',
          'data-dsh-part': 'session-pill',
          'aria-label': label,
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          disabled: sessionId === '',
          onClick: () => setOpen(!open),
        },
        h(GaugeIcon, { size: 12 }),
        h('span', null, t('session')),
        h('span', { className: 'dab-pill-value' }, `${formatTokens(total)} tokens`),
      )

      if (sessionId === '') return trigger

      const panel = open
        ? ReactDOM.createPortal(
            h(
              'div',
              {
                ref: panelRef,
                className: 'dab-meter',
                style: position === null ? { visibility: 'hidden', left: 0, top: 0 } : position,
                role: 'dialog',
                'aria-label': t('session'),
                'data-dsh-plugin': 'abacus',
                'data-dsh-part': 'session-panel',
              },
              h(SessionPanelBody, { facts, error, loading, fallbackTotal: total }),
            ),
            document.body,
          )
        : null

      return h('span', { className: 'dab-meter-root' }, trigger, panel)
    }

    //#endregion

    //#region ------------------------------------------------------ settings view

    /** One labelled number in the metrics strip. */
    function Metric(props) {
      return h(
        'div',
        { className: 'dab-metric' },
        h('div', { className: 'dab-metric-value' }, props.value),
        h('div', { className: 'dab-metric-label' }, props.label),
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
        { className: 'dab-provider' },
        h(
          'div',
          { className: 'dab-provider-head' },
          h('span', null, row.displayName ?? row.provider),
          // Only the live route is badged. Marking every row would make the
          // badge carry no information — and it is only meaningful on today's
          // card, so a past day passes `current: undefined`.
          current !== undefined && current === row.provider ? h('span', { className: 'dab-badge' }, t('current')) : null,
          h('span', { className: 'dab-provider-total' }, `${formatTokens(totalOf(row.totals))} · ${t('calls', { n: row.totals.calls ?? 0 })}`),
        ),
        (row.models ?? []).map((model) => h(
          'div',
          { className: 'dab-model', key: model.model },
          h('span', { className: 'dab-model-name', title: model.model }, model.model),
          h('span', { className: 'dab-model-bar' }, h('i', { style: { width: `${Math.round((totalOf(model.totals) / Math.max(1, scale)) * 100)}%` } })),
          h('span', { className: 'dab-model-total' }, formatTokens(totalOf(model.totals))),
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
    const RANGE_KEY = 'dsh-abacus.range-preset'

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

    /** localStorage key holding the custom window's two dates. */
    const RANGE_CUSTOM_KEY = 'dsh-abacus.range-custom'

    /**
     * The remembered custom window, or `null`.
     *
     * Only the preset name used to be remembered, so leaving the tab reset the
     * dates to the default week while the pill still said 自定义 — and only one
     * tab is mounted at a time, so the window is rebuilt on every switch.
     */
    function readRangeCustom() {
      try {
        const stored = JSON.parse(window.localStorage.getItem(RANGE_CUSTOM_KEY) ?? 'null')
        if (stored === null || typeof stored !== 'object') return null
        const from = dateKey(stored.from)
        const to = dateKey(stored.to)
        if (from === undefined || to === undefined) return null
        return { from, to }
      } catch {
        return null
      }
    }

    /** Remember the custom window's dates. */
    function writeRangeCustom(from, to) {
      if (dateKey(from) === undefined || dateKey(to) === undefined) return
      try {
        window.localStorage.setItem(RANGE_CUSTOM_KEY, JSON.stringify({ from, to }))
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
        { className: 'dab-chart' },
        days.map((day) => {
          const value = totalOf(day.totals)
          return h(
            'div',
            {
              key: day.date,
              className: 'dab-chart-col',
              'data-dsh-part': 'chart-col',
              title: `${day.date} · ${formatTokens(value)} tokens · ${t('callsShort', { n: day.totals?.calls ?? 0 })}`,
            },
            h('div', {
              className: 'dab-chart-bar',
              'data-dsh-part': 'chart-bar',
              style: { height: `${Math.max(2, Math.round((value / top) * 100))}%` },
            }),
          )
        }),
      )
    }

    /**
     * One day's hours as chart columns: all twenty-four of them, so the chart
     * reads as a clock rather than as a list of the hours that happened to be
     * busy. An hour that recorded nothing keeps its column and draws no bar —
     * a zero-height bar and a missing bar say different things, and only one of
     * them is true.
     * @param {{ hours?: Array<{ hour: number, totals: object }> }} view - the day's hour view.
     * @returns {Array<{ hour: number, totals: object }>} twenty-four entries, midnight first.
     */
    function chartHours(view) {
      const known = new Map()
      for (const row of view?.hours ?? []) {
        if (row === null || typeof row !== 'object') continue
        if (typeof row.hour === 'number') known.set(row.hour, row.totals)
      }
      /** @type {Array<{ hour: number, totals: object }>} */
      const out = []
      for (let hour = 0; hour < 24; hour += 1) out.push({ hour, totals: known.get(hour) ?? zeroTotals() })
      return out
    }

    /**
     * The day's heaviest hour — what the hour chart scales to, and the figure
     * the card names. The daily chart's twin; see {@link peakOf}.
     * @param {Array<{ hour: number, totals: object }>} hours - the chart's columns.
     * @returns {{ value: number, hour: number }} - `0` / `-1` when nothing was recorded.
     */
    function peakHourOf(hours) {
      let value = 0
      let hour = -1
      for (const row of hours ?? []) {
        const total = totalOf(row.totals)
        if (total > value) {
          value = total
          hour = row.hour
        }
      }
      return { value, hour }
    }

    /**
     * An hour of the day as a clock label, e.g. `14:00`.
     * @param {number} hour - the hour, 0 through 23.
     * @returns {string} the label.
     */
    function clockLabel(hour) {
      return `${String(hour).padStart(2, '0')}:00`
    }

    /**
     * The hours the hour chart labels. Six-hourly places any bar on the clock
     * without four labels colliding in a narrow column.
     * @type {number[]}
     */
    const HOUR_TICKS = [0, 6, 12, 18]

    /**
     * The chart's geometry, shared by every bar chart: one column per entry,
     * scaled to the tallest, each column carrying its own tooltip. An entry
     * worth nothing keeps its column and draws no bar — a zero-height bar and a
     * missing bar say different things, and only one of them is true.
     * @param {{ columns: Array<{ key: number|string, part: string, value: number, title: string }> }} props - the columns.
     */
    function BarColumns(props) {
      const columns = props.columns ?? []
      let top = 1
      for (const column of columns) top = Math.max(top, column.value)
      return h(
        'div',
        { className: 'dab-chart' },
        columns.map((column) => h(
          'div',
          { key: column.key, className: 'dab-chart-col', 'data-dsh-part': column.part, title: column.title },
          column.value > 0
            ? h('div', {
                className: 'dab-chart-bar',
                'data-dsh-part': 'chart-bar',
                style: { height: `${Math.max(2, Math.round((column.value / top) * 100))}%` },
              })
            : null,
        )),
      )
    }

    /**
     * One bar per hour of the day, scaled to the day's own peak: the daily
     * chart one resolution finer, answering "when in the day" rather than
     * "which day".
     * @param {{ hours: Array<{ hour: number, totals: object }> }} props - the day's hours.
     */
    function HourChart(props) {
      return h(BarColumns, {
        columns: (props.hours ?? []).map((row) => {
          const value = totalOf(row.totals)
          return {
            key: row.hour,
            part: 'chart-hour',
            value,
            title: `${clockLabel(row.hour)} · ${formatTokens(value)} tokens · ${t('callsShort', { n: row.totals?.calls ?? 0 })}`,
          }
        }),
      })
    }

    /**
     * The same clock as {@link HourChart}, in money: the hours converted at the
     * price table instead of counted.
     *
     * It takes a column per day just as readily — the cost tab charts a day by
     * the hour and a longer window by the day — so a column with a `date` is
     * drawn as a day and one with an `hour` as an hour.
     * @param {{ columns: Array<{ hour?: number, date?: string, value: number }> }} props - the columns and their cost.
     */
    function MoneyChart(props) {
      return h(BarColumns, {
        columns: (props.columns ?? []).map((column) => (
          column.date === undefined
            ? {
                key: column.hour,
                part: 'chart-hour',
                value: column.value,
                title: `${clockLabel(column.hour)} · ${formatMoney(column.value)}`,
              }
            : {
                key: column.date,
                part: 'chart-col',
                value: column.value,
                title: `${shortDate(column.date)} · ${formatMoney(column.value)}`,
              }
        )),
      })
    }

    /**
     * The heaviest column of a money chart, and which hour or day it was.
     * @param {Array<{ hour?: number, date?: string, value: number }>} columns - the chart's columns.
     * @returns {{ value: number, hour: number, date: string }} - `0`, `-1` and `''` when nothing was recorded.
     */
    function peakColumn(columns) {
      let value = 0
      let hour = -1
      let date = ''
      for (const column of columns ?? []) {
        if (column.value > value) {
          value = column.value
          hour = column.hour ?? -1
          date = column.date ?? ''
        }
      }
      return { value, hour, date }
    }

    /**
     * Narrow a cost tree to one provider, or to one model of one provider.
     *
     * The cost view arrives whole — every provider, every model, and each one's
     * own price status — because the price table is the host's business. The
     * narrowing happens here so the total, the billed-token count and the
     * unpriced warning are recomputed from the same rows and cannot disagree:
     * re-fetching at a different granularity would let them.
     * @param {object|null|undefined} cost - the window's cost view.
     * @param {string} provider - a provider key, or `''` for all of them.
     * @param {string} model - a model name, or `''` for all of the provider's.
     * @returns {object|null} the narrowed view, or `null` when there is nothing.
     */
    function costScope(cost, provider, model) {
      if (cost === null || cost === undefined) return null
      if (provider === '') return cost
      const row = (cost.providers ?? []).find((entry) => entry.provider === provider)
      if (row === undefined) return null
      const models = model === '' ? (row.models ?? []) : (row.models ?? []).filter((entry) => entry.model === model)
      let total = 0
      let tokens = 0
      let pricedTokens = 0
      let unpricedTokens = 0
      const unpriced = []
      for (const entry of models) {
        total += entry.cost ?? 0
        tokens += entry.tokens ?? 0
        if (entry.priced === true) {
          pricedTokens += entry.tokens ?? 0
        } else {
          unpricedTokens += entry.tokens ?? 0
          unpriced.push({ model: entry.model, tokens: entry.tokens ?? 0 })
        }
      }
      return {
        currency: cost.currency,
        total,
        tokens,
        pricedTokens,
        unpricedTokens,
        unpricedCount: unpriced.length,
        unpriced,
        providers: [{ ...row, models }],
      }
    }

    /**
     * A day's hours converted to money, one entry per hour of the clock.
     * @param {object|undefined} hourView - the range view's hour block.
     * @param {string} provider - the scope's provider, or `''`.
     * @param {string} model - the scope's model, or `''`.
     * @returns {Array<{ hour: number, value: number }>} twenty-four entries, midnight first.
     */
    function costColumns(hourView, provider, model) {
      const known = new Map()
      for (const row of hourView?.hours ?? []) {
        if (row === null || typeof row !== 'object' || typeof row.hour !== 'number') continue
        known.set(row.hour, costScope(row.cost ?? null, provider, model)?.total ?? 0)
      }
      const out = []
      for (let hour = 0; hour < 24; hour += 1) out.push({ hour, value: known.get(hour) ?? 0 })
      return out
    }

    /**
     * The window's days, keyed by date, each with the money the host worked out
     * for that day.
     *
     * `chartDays` only carries token totals, so the per-day money is indexed
     * separately and looked up by date — a day with no cost is a zero column, not
     * a missing one.
     * @param {object|null|undefined} range - the range view.
     * @returns {Map<string, object|null>} date to cost view.
     */
    function costOfDays(range) {
      const out = new Map()
      for (const row of range?.days ?? []) {
        if (row === null || typeof row !== 'object' || typeof row.date !== 'string') continue
        out.set(row.date, row.cost ?? null)
      }
      return out
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
      const window = useRangeWindow(overview)
      const { today, preset, from, to, range, rangeError, backwards } = window

      const totals = range?.totals ?? zeroTotals()
      const providers = range?.providers ?? []
      const days = range?.days ?? []
      // A one-day window is charted across the clock: one bar per day would be a
      // single bar, which says nothing. The host sends the hours only for such a
      // window, so their presence is the switch.
      const hourView = range?.hours
      const hourly = from === to && hourView !== undefined && hourView.date === from
      const hours = hourly ? chartHours(hourView) : []
      const hourPeak = peakHourOf(hours)
      // The daily chart covers the picked window, not just the days that happen
      // to hold usage, so its axis and the numbers above it agree.
      const chart = hourly ? [] : chartDays(from, to, days)
      const peak = peakOf(chart)
      // The card names what its bars scale to, whichever resolution it drew:
      // "how tall is the tallest bar" is otherwise unanswerable.
      const chartNote = hourly
        ? (hourPeak.hour < 0
            ? null
            : t('hourlyPeak', { value: formatTokens(hourPeak.value), hour: clockLabel(hourPeak.hour) }))
        : (peak.date === ''
            ? null
            : t('dailyPeak', { value: formatTokens(peak.value), date: shortDate(peak.date) }))
      const scale = heaviestModel(providers)
      // The live route is only worth marking when the window actually covers
      // today; on a past window it says nothing about the numbers shown.
      const currentProvider = from <= today && to >= today ? overview.current?.provider : undefined

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dab-card' },
          h(
            'div',
            { className: 'dab-card-head' },
            h('span', { className: 'dab-card-title' }, t('overview')),
            h(RangePills, { preset, onPick: window.pick }),
          ),
          preset === 'custom'
            ? h(RangeDates, {
                from: window.customFrom,
                to: window.customTo,
                onFrom: window.setCustomFrom,
                onTo: window.setCustomTo,
              })
            : null,
          h(RangeStatus, { backwards, error: rangeError, loaded: range !== null, from, to }),
          rangeError === null && range !== null
            ? h(
                'div',
                { className: 'dab-metrics' },
                h(Metric, { value: formatTokens(totalOf(totals)), label: t('total') }),
                h(Metric, { value: formatTokens(totals.inputTokens), label: t('input') }),
                h(Metric, { value: formatTokens(totals.outputTokens), label: t('output') }),
                h(Metric, { value: formatTokens(totals.cacheReadTokens), label: t('cacheRead') }),
                // Cache writes are real (Anthropic-style providers bill them) but
                // several providers never report one. A tile that is always zero
                // is noise, so it only appears when the window actually has
                // writes; the number is still folded and still shown once it
                // exists.
                totals.cacheWriteTokens > 0
                  ? h(Metric, { value: formatTokens(totals.cacheWriteTokens), label: t('cacheWrite') })
                  : null,
                h(Metric, { value: String(totals.calls ?? 0), label: t('callCount') }),
              )
            : null,
        ),
        h(
          'div',
          { className: 'dab-card' },
          h('div', { className: 'dab-card-head' }, h('span', { className: 'dab-card-title' }, t('providers'))),
          providers.length === 0
            ? h('div', { className: 'dab-empty' }, t('noProviders'))
            : h('div', { className: 'dab-list' }, providers.map((row) => h(ProviderBlock, { key: row.provider, row, scale, current: currentProvider }))),
        ),
        h(
          'div',
          { className: 'dab-card' },
          h(
            'div',
            { className: 'dab-card-head' },
            h('span', { className: 'dab-card-title' }, t(hourly ? 'hourly' : 'daily')),
            chartNote === null ? null : h('span', { className: 'dab-card-note' }, chartNote),
          ),
          hourly
            ? (hourPeak.hour < 0
                ? h('div', { className: 'dab-empty' }, t(hourView?.available === false ? 'noHours' : 'noProviders'))
                : h(
                    React.Fragment,
                    null,
                    h(HourChart, { hours }),
                    h(
                      'div',
                      { className: 'dab-trend-axis' },
                      HOUR_TICKS.map((hour) => h('span', { key: hour }, clockLabel(hour))),
                    ),
                  ))
            : (chart.length === 0
                ? h('div', { className: 'dab-empty' }, t('noProviders'))
                : h(
                    React.Fragment,
                    null,
                    h(DayChart, { days: chart }),
                    h(
                      'div',
                      { className: 'dab-trend-axis' },
                      axisTicks(chart).map((date) => h('span', { key: date }, shortDate(date))),
                    ),
                  )),
        ),
      )
    }

    //#region ----------------------------------------------------------- the cost tab

    /**
     * The window a range-driven tab is showing: which preset is picked, the two
     * dates when the preset is `custom`, and the view the host returned for it.
     *
     * Two tabs read the same window (用量 and 金额) and they have to agree, so the
     * preset lives in one place and both refetch when the polled overview
     * advances — otherwise a stale window could sit next to a live one.
     * @param {object} overview - the plugin's overview snapshot.
     * @returns {object} the window and the ways to change it.
     */
    function useRangeWindow(overview) {
      const today = todayKey()
      const availableDays = overview.usage?.availableDays ?? []
      const [preset, setPreset] = useState(readRangePreset)
      const [customFrom, setCustomFrom] = useState(() => readRangeCustom()?.from ?? shiftDayKey(todayKey(), -6))
      const [customTo, setCustomTo] = useState(() => readRangeCustom()?.to ?? todayKey())
      // The fetched window is stamped with the window it belongs to. Rendering it
      // only when the stamp matches is what keeps a new date label from wearing
      // the previous window's numbers, and what makes a failed fetch leave an
      // error and nothing else instead of a complete, plausible breakdown for a
      // window the user is no longer looking at.
      const [loaded, setLoaded] = useState(null)
      const [rangeError, setRangeError] = useState(null)

      const picked = preset === 'custom' ? { from: customFrom, to: customTo } : rangeOf(preset, today, availableDays)
      const from = picked.from
      const to = picked.to
      const backwards = from !== '' && to !== '' && from > to
      const fetchable = from !== '' && to !== '' && !backwards
      const key = `${from}|${to}`
      const range = loaded !== null && loaded.key === key ? loaded.value : null

      useEffect(() => {
        if (!fetchable) {
          setLoaded(null)
          setRangeError(null)
          return undefined
        }
        let cancelled = false
        api.range(from, to).then(
          (value) => {
            if (!cancelled) {
              setLoaded({ key, value })
              setRangeError(null)
            }
          },
          (error) => {
            if (!cancelled) {
              // Nothing stale is left behind: the error is the whole answer.
              setLoaded(null)
              setRangeError(error instanceof Error ? error.message : String(error))
            }
          },
        )
        return () => {
          cancelled = true
        }
      }, [key, from, to, fetchable, overview.updatedAt])

      const pick = (value) => {
        setPreset(value)
        writeRangePreset(value)
      }

      const pickFrom = (value) => {
        setCustomFrom(value)
        writeRangeCustom(value, customTo)
      }

      const pickTo = (value) => {
        setCustomTo(value)
        writeRangeCustom(customFrom, value)
      }

      return {
        today,
        preset,
        pick,
        customFrom,
        setCustomFrom: pickFrom,
        customTo,
        setCustomTo: pickTo,
        from,
        to,
        range,
        rangeError,
        backwards,
        fetchable,
      }
    }

    /**
     * The preset pills a range card carries in its head.
     * @param {{ preset: string, onPick: Function }} props - the current preset and its setter.
     */
    function RangePills(props) {
      return h(
        'div',
        { className: 'dab-ranges', role: 'group', 'aria-label': t('range') },
        RANGE_PRESETS.map((value) => h(
          'button',
          {
            key: value,
            type: 'button',
            className: 'dab-range',
            'data-dsh-part': `range-${value}`,
            'aria-pressed': props.preset === value,
            onClick: () => props.onPick(value),
          },
          t(RANGE_LABELS[value]),
        )),
      )
    }

    /**
     * The two date boxes the `custom` preset reveals. Each box bounds the other,
     * so an impossible window cannot be typed in the first place.
     * @param {{ from: string, to: string, onFrom: Function, onTo: Function }} props - the dates and their setters.
     */
    function RangeDates(props) {
      return h(
        'div',
        { className: 'dab-range-dates' },
        h(
          'label',
          { className: 'dab-field', style: { flex: 'none' } },
          h('span', { className: 'dab-field-label' }, t('rangeFrom')),
          h('input', {
            className: 'dab-input',
            type: 'date',
            'data-dsh-part': 'range-from',
            value: props.from,
            ...(props.to === '' ? {} : { max: props.to }),
            onChange: (event) => props.onFrom(event.target.value),
          }),
        ),
        h(
          'label',
          { className: 'dab-field', style: { flex: 'none' } },
          h('span', { className: 'dab-field-label' }, t('rangeTo')),
          h('input', {
            className: 'dab-input',
            type: 'date',
            'data-dsh-part': 'range-to',
            value: props.to,
            ...(props.from === '' ? {} : { min: props.from }),
            onChange: (event) => props.onTo(event.target.value),
          }),
        ),
      )
    }

    /**
     * The line under a range card's head: which window is on screen, or why it
     * is not. Both range-driven tabs say it the same way, because it is the same
     * fact.
     * @param {{ backwards: boolean, error: string|null, loaded: boolean, from: string, to: string }} props - the window's state.
     */
    function RangeStatus(props) {
      if (props.backwards) return h('div', { className: 'dab-note' }, t('rangeBad'))
      if (props.error !== null) return h('div', { className: 'dab-note' }, t('error', { error: props.error }))
      if (!props.loaded) return h('div', { className: 'dab-note' }, t('loading'))
      return h('div', { className: 'dab-note' }, props.from === props.to ? props.from : `${props.from} → ${props.to}`)
    }

    /**
     * One provider's money, and its models' money under it.
     *
     * A model with no price is labelled rather than shown as `¥0.00`: the two
     * mean opposite things — "free" and "unknown" — and a total that quietly
     * treats the second as the first is the one number on this page a reader
     * would trust wrongly.
     * @param {{ row: object }} props - the provider's cost row.
     */
    function CostBlock(props) {
      const { row } = props
      return h(
        'div',
        { className: 'dab-provider', 'data-dsh-part': 'cost-provider' },
        h(
          'div',
          { className: 'dab-provider-head' },
          h('span', { className: 'dab-provider-name' }, row.displayName ?? row.provider),
          h('span', { className: 'dab-provider-total' }, formatMoney(row.cost)),
        ),
        (row.models ?? []).map((entry) => h(
          'div',
          { className: 'dab-cost-row', key: entry.model, 'data-dsh-part': 'cost-model' },
          h('span', { className: 'dab-cost-row-name', title: entry.model }, entry.model),
          h(
            'span',
            { className: 'dab-cost-row-value' },
            entry.priced === true ? formatMoney(entry.cost) : t('costNoPrice'),
          ),
        )),
      )
    }

    /**
     * The 金额 tab: the same window as 用量, converted to money.
     *
     * It is a tab of its own rather than a line on the usage card because it
     * answers a different question from a different input. The usage numbers are
     * measured; the money is derived from a price table the user can edit, and a
     * derived number sitting beside a measured one invites the reader to treat
     * the two as equally solid.
     */
    function CostTab(props) {
      const { overview } = props
      const window = useRangeWindow(overview)
      const { from, to, range, rangeError, backwards } = window
      const [scope, setScope] = useState({ key: '', provider: '', model: '' })

      // The narrowing is stored together with the window it was chosen in. A new
      // window is a new set of providers, so the choice is dropped by derivation
      // rather than by an effect that clears it: keeping it would leave the select
      // naming a provider this window has no rows for, which renders as its first
      // option (全部) while the totals underneath say zero.
      const windowKey = `${from}|${to}`
      const chosen = scope.key === windowKey ? scope : { key: windowKey, provider: '', model: '' }

      const whole = range?.cost ?? null
      const providerRows = whole?.providers ?? []
      // Even inside one window a provider can drop out of the tree, so the
      // narrowing only applies while it still names something the window holds.
      const activeProvider = providerRows.some((row) => row.provider === chosen.provider) ? chosen.provider : ''
      const modelRows = providerRows.find((row) => row.provider === activeProvider)?.models ?? []
      const activeModel = modelRows.some((row) => row.model === chosen.model) ? chosen.model : ''
      const scoped = costScope(whole, activeProvider, activeModel)
      // The host sends the hours only for a one-day window, so their presence is
      // the switch — the same rule the usage tab's chart follows.
      const hourView = range?.hours
      const hourly = from === to && hourView !== undefined && hourView.date === from
      // A day is charted across the clock; a longer window is charted day by day,
      // the way the usage tab charts it — one bar per day of the same window.
      const dayCosts = costOfDays(range)
      const filled = chartDays(from, to, range?.days)
      const columns = hourly
        ? costColumns(hourView, activeProvider, activeModel)
        : filled.map((row) => ({
            date: row.date,
            value: costScope(dayCosts.get(row.date), activeProvider, activeModel)?.total ?? 0,
          }))
      const peak = peakColumn(columns)
      // Two boxes rather than one list of "provider" and "provider · model"
      // entries: the model box only makes sense once a provider is chosen, and
      // one flat list made the reader scan past every model of every provider to
      // find the provider they wanted.

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dab-card' },
          h(
            'div',
            { className: 'dab-card-head' },
            h('span', { className: 'dab-card-title' }, t('costTitle')),
            h(RangePills, { preset: window.preset, onPick: window.pick }),
          ),
          window.preset === 'custom'
            ? h(RangeDates, {
                from: window.customFrom,
                to: window.customTo,
                onFrom: window.setCustomFrom,
                onTo: window.setCustomTo,
              })
            : null,
          h(RangeStatus, { backwards, error: rangeError, loaded: range !== null, from, to }),
          rangeError === null && range !== null
            ? h(
                React.Fragment,
                null,
                h(
                  'div',
                  { className: 'dab-metrics' },
                  h(Metric, { value: formatMoney(scoped?.total ?? 0), label: t('costTotal') }),
                  h(Metric, { value: formatTokens(scoped?.pricedTokens ?? 0), label: t('costBilled') }),
                  scoped !== null && scoped.unpricedTokens > 0
                    ? h(Metric, { value: formatTokens(scoped.unpricedTokens), label: t('costUnpricedLabel') })
                    : null,
                ),
                h('div', { className: 'dab-note' }, t('costNote')),
                scoped !== null && scoped.unpricedCount > 0
                  ? h(
                      'div',
                      { className: 'dab-note', 'data-dsh-part': 'cost-unpriced' },
                      t('costUnpriced', { count: scoped.unpricedCount, tokens: formatTokens(scoped.unpricedTokens) }),
                    )
                  : null,
                providerRows.length === 0
                  ? null
                  : h(
                      'div',
                      { className: 'dab-form-row' },
                      h(
                        'div',
                        { className: 'dab-form-text' },
                        h('span', { className: 'dab-form-label' }, t('costScope')),
                      ),
                      h(
                        'div',
                        { className: 'dab-form-control' },
                        h(
                          'select',
                          {
                            className: 'dab-input dab-select dab-scope-select',
                            'data-dsh-part': 'cost-scope-provider',
                            'aria-label': t('costProvider'),
                            value: activeProvider,
                            onChange: (event) => {
                              // The model list belongs to the chosen provider, so
                              // carrying a model across would narrow to nothing.
                              setScope({ key: windowKey, provider: event.target.value, model: '' })
                            },
                          },
                          h('option', { value: '' }, t('costAll')),
                          providerRows.map((row) => h('option', { key: row.provider, value: row.provider }, row.displayName ?? row.provider)),
                        ),
                        h(
                          'select',
                          {
                            className: 'dab-input dab-select dab-scope-select',
                            'data-dsh-part': 'cost-scope-model',
                            'aria-label': t('costModel'),
                            value: activeModel,
                            disabled: activeProvider === '',
                            onChange: (event) => setScope({ key: windowKey, provider: activeProvider, model: event.target.value }),
                          },
                          h('option', { value: '' }, t('costAllModels')),
                          modelRows.map((entry) => h('option', { key: entry.model, value: entry.model }, entry.model)),
                        ),
                      ),
                    ),
              )
            : null,
        ),
        h(
          'div',
          { className: 'dab-card' },
          h('div', { className: 'dab-card-head' }, h('span', { className: 'dab-card-title' }, t('providers'))),
          (scoped?.providers ?? []).length === 0
            ? h('div', { className: 'dab-empty' }, t('noProviders'))
            : h('div', { className: 'dab-list' }, (scoped?.providers ?? []).map((row) => h(CostBlock, { key: row.provider, row }))),
        ),
        h(
          'div',
          { className: 'dab-card' },
          h(
            'div',
            { className: 'dab-card-head' },
            h('span', { className: 'dab-card-title' }, t(hourly ? 'costHourly' : 'costDaily')),
            peak.value <= 0
              ? null
              : h(
                  'span',
                  { className: 'dab-card-note' },
                  hourly
                    ? t('costHourlyPeak', { value: formatMoney(peak.value), hour: clockLabel(peak.hour) })
                    : t('costDailyPeak', { value: formatMoney(peak.value), day: shortDate(peak.date) }),
                ),
          ),
          peak.value <= 0
            ? h('div', { className: 'dab-empty' }, t(hourly && hourView?.available === false ? 'noHours' : 'noProviders'))
            : h(
                React.Fragment,
                null,
                h(MoneyChart, { columns }),
                h(
                  'div',
                  { className: 'dab-trend-axis' },
                  hourly
                    ? HOUR_TICKS.map((hour) => h('span', { key: hour }, clockLabel(hour)))
                    : axisTicks(filled).map((date) => h('span', { key: date }, shortDate(date))),
                ),
              ),
        ),
      )
    }

    //#endregion

    /**
     * What the settings form shows when the host has not sent a config: an older
     * host half, or one that is still starting. These are the host's own
     * defaults, so the form reads as a working form rather than a blank one.
     */
    const FORM_DEFAULTS = Object.freeze({
      enabled: true,
      pollIntervalSec: 60,
      probeEnabled: true,
      probeIntervalSec: 300,
      alertEnabled: true,
      alertBalanceBelow: 0,
      alertWindow5h: 0,
      alertWindowWeek: 0,
      alertWindowMonth: 0,
      prices: Object.freeze({}),
    })

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
      // The price table is edited as a grid, one model per row: four numbers
      // with four different meanings are not something a person should have to
      // keep in the right order in their head. A row is added and removed by
      // hand, which is why the state is a list rather than a map.
      const [priceRows, setPriceRows] = useState(() => {
        const rows = priceRowsFrom(overview.config?.prices)
        return rows.length === 0 ? [blankPriceRow()] : rows
      })

      // An older host half, or one still starting, sends no config at all. Falling
      // back to the host's own defaults keeps the form usable instead of blanking
      // the pane on a `config.enabled` read, and a save from here sends a complete
      // config rather than a partial one.
      const config = draft ?? overview.config ?? FORM_DEFAULTS
      const edit = (patch) => setDraft({ ...config, ...patch })
      const priceErrors = pricesFromRows(priceRows).errors
      const priceDirty = canonicalPrices(pricesFromRows(priceRows).prices) !== canonicalPrices(config.prices)
      // The host sends the built-in table so the editor can name the models the
      // user did *not* have to fill in. Older hosts do not send it, in which
      // case the footnote is simply absent rather than wrong.
      const builtinRows = overview.builtinPrices === undefined ? [] : priceRowsFrom(overview.builtinPrices)
      const editPriceRow = (index, field, value) => setPriceRows((rows) => rows.map(
        (row, at) => (at === index ? { ...row, [field]: value } : row),
      ))

      // The grid is a copy of the host's table, so the copy has to follow the
      // host. Without this, a table changed elsewhere — another window, or the
      // daily price refresh — leaves this grid holding an older one, which reads
      // as an unsaved edit that the user never made; saving any unrelated field
      // then posts the stale table over the newer one. A local edit in progress
      // is kept, because that is the one case where this copy is the newer one.
      const storedPrices = canonicalPrices(config.prices)
      useEffect(() => {
        if (priceDirty) return
        const rows = priceRowsFrom(config.prices)
        setPriceRows(rows.length === 0 ? [blankPriceRow()] : rows)
        // `storedPrices` is the table's value, not its identity: a poll that
        // returns the same prices must not reshuffle the grid under the cursor.
      }, [storedPrices])

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
            prices: pricesFromRows(priceRows).prices,
          })
          setDraft(null)
          // Re-render the grid from what the host accepted, so it shows the
          // canonical spelling of what was actually stored. An empty table still
          // gets a blank row: an empty grid has no place to type.
          const stored = priceRowsFrom(saved.prices)
          setPriceRows(stored.length === 0 ? [blankPriceRow()] : stored)
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
        { className: 'dab-form-row', key },
        h(
          'div',
          { className: 'dab-form-text' },
          h('span', { className: 'dab-form-label' }, label),
          hint === undefined ? null : h('span', { className: 'dab-form-hint' }, hint),
        ),
        h('div', { className: 'dab-form-control' }, control),
      )

      const checkBox = (part, label, checked, patch) => h('input', {
        className: 'dab-check',
        'data-dsh-part': part,
        type: 'checkbox',
        checked,
        title: label,
        'aria-label': label,
        onChange: (event) => edit(patch(event.target.checked)),
      })

      const numberBox = (part, value, min, max, patch, suffix) => [
        h('input', {
          className: 'dab-input',
          'data-dsh-part': part,
          type: 'number',
          min,
          max,
          value,
          // A cleared box — or a half-typed one like `-` or `1e` — reports an
          // empty value, and `Number('')` is 0. Writing that 0 through would
          // disarm a reminder (or clamp an interval to its floor) the moment the
          // user cleared the field to retype it, and the save that followed would
          // report success. An unreadable box leaves the value alone instead.
          onChange: (event) => {
            const raw = event.target.value
            if (raw.trim() === '') return
            const next = Number(raw)
            if (!Number.isFinite(next)) return
            edit(patch(next))
          },
        }),
        suffix === undefined ? null : h('span', { className: 'dab-suffix', 'data-dsh-part': 'form-unit' }, suffix),
      ]

      return h(
        'div',
        { className: 'dab-stack' },
        h(
          'div',
          { className: 'dab-panel' },
          formRow('enable', t('enable'), checkBox('enable-check', t('enable'), config.enabled === true, (next) => ({ enabled: next }))),
        ),
        h(
          'div',
          { className: 'dab-panel' },
          h('div', { className: 'dab-panel-head' }, h('span', { className: 'dab-panel-title' }, t('tabUsage'))),
          formRow(
            'poll',
            t('pollInterval'),
            numberBox('setting-input', config.pollIntervalSec, 5, 600, (next) => ({ pollIntervalSec: next }), t('seconds')),
            t('pollHint'),
          ),
        ),
        h(
          'div',
          { className: 'dab-panel' },
          h(
            'div',
            { className: 'dab-panel-head' },
            h('span', { className: 'dab-panel-title' }, t('balanceTitle')),
            checkBox('probe-check', t('probeEnabled'), config.probeEnabled === true, (next) => ({ probeEnabled: next })),
          ),
          formRow(
            'probe',
            t('probeInterval'),
            numberBox('setting-input', config.probeIntervalSec, 60, 3600, (next) => ({ probeIntervalSec: next }), t('seconds')),
            t('probeHint'),
          ),
        ),
        h(
          'div',
          { className: 'dab-panel' },
          h(
            'div',
            { className: 'dab-panel-head' },
            h('span', { className: 'dab-panel-title' }, t('alertEnabled')),
            checkBox('alert-check', t('alertEnabled'), config.alertEnabled === true, (next) => ({ alertEnabled: next })),
          ),
          h('div', { className: 'dab-panel-note' }, t('alertHint')),
          // The balance line is an amount and the three window lines are
          // percentages of what is *left*, which is why they are two different
          // kinds of input rather than four of the same. Every numeric row in
          // this panel keeps a unit mark after its box, so all six boxes (these
          // four and the two intervals above) end on the same right edge
          // instead of the ones without a mark sitting a suffix further right.
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
          { className: 'dab-panel' },
          h('div', { className: 'dab-panel-head' }, h('span', { className: 'dab-panel-title' }, t('pricesTitle'))),
          h('div', { className: 'dab-panel-note' }, t('pricesHint')),
          h(
            'div',
            { className: 'dab-prices', 'data-dsh-part': 'prices-input' },
            h(
              'div',
              { className: 'dab-price-head' },
              h('span', null, t('priceModel')),
              h('span', { key: 'from' }, t('priceFrom')),
              PRICE_FIELDS.map((field) => h('span', { key: field }, t(field))),
              h('span', { key: 'remove' }, ''),
            ),
            priceRows.map((row, index) => h(
              'div',
              { className: 'dab-price-row', key: index, 'data-dsh-part': 'price-row' },
              h('input', {
                className: 'dab-input dab-price-model',
                'data-dsh-part': 'price-model',
                type: 'text',
                spellCheck: false,
                value: row.model,
                'aria-label': t('priceModel'),
                onChange: (event) => editPriceRow(index, 'model', event.target.value),
              }),
              h('input', {
                className: 'dab-input dab-price-from',
                'data-dsh-part': 'price-from',
                type: 'date',
                value: row.from,
                'aria-label': t('priceFrom'),
                onChange: (event) => editPriceRow(index, 'from', event.target.value),
              }),
              PRICE_FIELDS.map((field) => h('input', {
                key: field,
                className: 'dab-input dab-price-cell',
                'data-dsh-part': 'price-field',
                type: 'number',
                min: 0,
                step: 'any',
                value: row[field],
                'aria-label': t(field),
                onChange: (event) => editPriceRow(index, field, event.target.value),
              })),
              h('button', {
                type: 'button',
                className: 'dab-price-remove',
                'data-dsh-part': 'price-remove',
                title: t('priceRemove'),
                'aria-label': t('priceRemove'),
                onClick: () => setPriceRows((rows) => rows.filter((_, at) => at !== index)),
              }, '×'),
            )),
          ),
          h(
            'div',
            { className: 'dab-price-actions' },
            h('button', {
              type: 'button',
              className: 'dab-button',
              'data-dsh-part': 'price-add',
              onClick: () => setPriceRows((rows) => [...rows, blankPriceRow()]),
            }, t('priceAdd')),
          ),
          builtinRows.length === 0
            ? null
            : h(
                'div',
                { className: 'dab-price-builtin', 'data-dsh-part': 'prices-builtin' },
                h('span', { className: 'dab-price-builtin-title' }, t('pricesBuiltin')),
                ...builtinRows.map((row) => h(
                  'span',
                  { className: 'dab-price-builtin-row', key: `${row.model}${row.from}` },
                  h('span', { className: 'dab-price-builtin-model' }, row.model),
                  h('span', { className: 'dab-price-builtin-cell' }, `${row.input} / ${row.output} / ${row.cacheRead} / ${row.cacheWrite}`),
                  row.offPeak === true ? h('span', { className: 'dab-price-builtin-peak' }, t('pricesPeak')) : null,
                )),
                h('span', { className: 'dab-price-builtin-note' }, t('pricesPeakNote')),
              ),
          // A row that cannot be read is named rather than silently dropped: the
          // good rows still save, and the message points at the row on screen.
          priceErrors.length === 0
            ? null
            : h(
                'div',
                { className: 'dab-note', 'data-dsh-part': 'prices-bad' },
                priceErrors.map((entry) =>
                  h('div', { key: entry.row }, t(entry.kind === 'number' ? 'pricesBadNumber' : 'pricesBad', { row: entry.row })),
                ),
              ),
        ),
        h(
          'div',
          { className: 'dab-panel' },
          h(
            'div',
            { className: 'dab-panel-head' },
            h('span', { className: 'dab-panel-title' }, t('historyTitle')),
            h('button', {
              type: 'button',
              className: 'dab-button',
              'data-dsh-part': 'backfill-button',
              disabled: backfill.status === 'running',
              onClick: runBackfill,
            }, backfill.status === 'running' ? t('historyRunning') : t('historyRun')),
          ),
          h('div', { className: 'dab-panel-note' }, t('historyHint')),
          h(
            'div',
            { className: 'dab-form-row' },
            h('div', { className: 'dab-form-text' }, h('span', { className: 'dab-form-label', 'data-dsh-part': 'history-state' }, historyText())),
          ),
        ),
        h(
          'div',
          { className: 'dab-actions' },
          // Which build is live, at the far end of the row so it never competes
          // with the save button. The host reads it out of the manifest.
          typeof overview?.version === 'string' && overview.version !== ''
            ? h('span', { className: 'dab-version' }, t('version', { version: overview.version }))
            : null,
          saveState.status === 'saved' ? h('span', { className: 'dab-note' }, t('saved')) : null,
          saveState.status === 'error' ? h('span', { className: 'dab-note' }, t('saveFailed', { error: saveState.error ?? '' })) : null,
          h('button', { type: 'button', className: 'dab-button dab-button-primary', 'data-dsh-part': 'config-save', disabled: saveState.status === 'saving' || priceErrors.length > 0 || (draft === null && !priceDirty), onClick: save },
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
        className: 'dab-dot',
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
        { className: 'dab-window', 'data-dsh-part': 'plan-window' },
        h('span', { className: 'dab-window-name' }, windowName(entry)),
        h('span', { className: 'dab-model-bar' }, h('i', { style: { width: `${clampPercent(percent ?? 0)}%` } })),
        h('span', { className: 'dab-window-percent' }, label),
        h('span', { className: 'dab-window-reset' }, entry.resetsAt === undefined ? '' : t('resetAt', { time: formatReset(entry.resetsAt) })),
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
        { className: 'dab-card', 'data-dsh-part': 'vendor-card' },
        h(
          'div',
          { className: 'dab-provider-head' },
          h('span', null, title),
          h('span', { className: 'dab-provider-total' }, stamp),
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
      return h('div', { className: 'dab-note' }, rest === 0 ? text : `${text}${t('catalogMore', { n: rest })}`)
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
        { className: 'dab-vendor-row', 'data-dsh-part': part },
        dot === undefined ? null : h(AlertDot, { title: dot }),
        h('span', { className: 'dab-vendor-name' }, name),
        h('span', { className: 'dab-vendor-value' }, value),
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
      // `null` is what an older host half sends for a plan it cannot read, so a
      // row with a null plan has no reading and must not reach the renderer that
      // walks `plan.windows`.
      const hasReading = (row) =>
        row.balance !== undefined || (row.plan !== undefined && row.plan !== null)
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
            ? h('div', { className: 'dab-note' }, `${t('balanceLabel')}：${reasonText(row.balanceError)}`)
            : null
        }
        if (row.plan !== undefined && row.plan !== null) {
          const windows = row.plan.windows ?? []
          return windows.length === 0
            ? null
            : h('div', { className: 'dab-windows' }, windows.map((entry) => h(PlanWindow, { key: entry.key, entry })))
        }
        return notable(row.planError)
          ? h('div', { className: 'dab-note' }, `${t('planTitle')}：${reasonText(row.planError)}`)
          : null
      }

      /** The vendor block: one reminder dot per provider, on its own header. */
      const vendor = (row) => {
        const dot = dotFor(alertIndex, row.provider)
        return h(
          'div',
          { className: 'dab-plan-block', key: row.provider, 'data-dsh-part': 'account-card' },
          h(
            'div',
            { className: 'dab-provider-head' },
            dot === undefined ? null : h(AlertDot, { title: dot }),
            h('span', null, row.displayName ?? row.provider),
            row.plan?.planName === undefined ? null : h('span', { className: 'dab-badge' }, t('planName', { name: row.plan.planName })),
          ),
          half(row, 'balance'),
          half(row, 'plan'),
        )
      }

      // Everything lives inside the one card, so the fold and the hint share the
      // card's own padding instead of hanging off its left edge.
      return h(
        'div',
        { className: 'dab-stack' },
        h(
          VendorCard,
          { title: t('accountTitle'), facts },
          error !== null && error !== undefined ? h('div', { className: 'dab-note' }, t('error', { error })) : null,
          facts === null
            ? h('div', { className: 'dab-empty' }, t('loadingVendors'))
            : usable.length === 0
              ? h('div', { className: 'dab-empty' }, t('noBalance'))
              : usable.map(vendor),
          needsKey
            ? h('div', { className: 'dab-panel-note', 'data-dsh-part': 'account-howto' }, t('accountHowTo'))
            : null,
          rest.length === 0
            ? null
            : h(
                'details',
                { className: 'dab-fold' },
                h('summary', { className: 'dab-fold-summary' }, `${t('unavailable')} · ${rest.length}`),
                h(
                  'div',
                  { className: 'dab-fold-body' },
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
          { className: 'dab-section', 'data-dsh-plugin': 'abacus', 'data-dsh-part': 'settings-section' },
          h('div', { className: 'dab-note' }, snapshot.status === 'error' ? t('error', { error: snapshot.error ?? '' }) : t('loading')),
        )
      }

      const tabs = [
        { id: 'usage', label: t('tabUsage') },
        { id: 'cost', label: t('tabCost') },
        { id: 'account', label: t('tabAccount') },
        { id: 'settings', label: t('settings') },
      ]

      return h(
        'div',
        { className: 'dab-section', 'data-dsh-plugin': 'abacus', 'data-dsh-part': 'settings-section' },
        h(
          'div',
          { className: 'dab-head' },
          // The nav row above reads 「用量统计」 too, but a settings page needs a
          // heading of its own: it is what makes the panel look like a page
          // rather than a bare stack of cards. The heading carries the page
          // title scale of the shell's own settings dialog, and the line under
          // it carries the one fact the nav row cannot show -- how fresh these
          // numbers are.
          h(
            'div',
            { className: 'dab-head-text' },
            h('h2', { className: 'dab-head-title' }, t('title')),
            h('span', { className: 'dab-head-sub' }, t('updated', { time: formatClock(overview.updatedAt) })),
          ),
          h(
            'div',
            { className: 'dab-actions' },
            h(
              'button',
              {
                type: 'button',
                className: 'dab-button',
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
          { className: 'dab-tabs', role: 'tablist' },
          tabs.map((entry) => h(
            'button',
            {
              key: entry.id,
              type: 'button',
              role: 'tab',
              className: 'dab-tab',
              'aria-selected': tab === entry.id,
              onClick: () => setTab(entry.id),
            },
            entry.label,
          )),
        ),
        tab === 'usage'
          ? h(UsageTab, { overview })
          : tab === 'cost'
            ? h(CostTab, { overview })
            : tab === 'account'
              ? h(AccountTab, { facts, error: factsError })
              : h(SettingsTab, {
                  overview,
                  onConfigSaved: (config) => {
                    // Merge into what the store holds *now*, not into the
                    // overview this render closed over: a save can take seconds,
                    // and a poll landing in between would otherwise be rolled
                    // back — the foot card's clock going backwards, a reminder
                    // that just armed disappearing — until the next poll.
                    const live = store.getSnapshot().overview ?? overview
                    store.set({ status: 'ready', overview: { ...live, config }, error: null })
                  },
                }),
      )
    }

    //#endregion

    //#region ----------------------------------------------------------- mounting

    /** Attribute marking the injected foot-card container. */
    const FOOT_SELECTOR = '[data-dsh-abacus-foot]'

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
      container.setAttribute('data-dsh-abacus-foot', '')
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

    exports.name = 'dsh-abacus'
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
      CostTab,
      CostBlock,
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
      HourChart,
      chartHours,
      peakHourOf,
      clockLabel,
      HOUR_TICKS,
      BarColumns,
      MoneyChart,
      peakColumn,
      costScope,
      costColumns,
      formatMoney,
      priceRowsFrom,
      pricesFromRows,
      canonicalPrices,
      blankPriceRow,
      priceRow,
      dateKey,
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
      migrateStoredKeys()
      ensureStyles()
      const store = createOverviewStore()

      ctx.effect(() => startPolling(store, () => {}), 'dsh-abacus: overview poll')
      ctx.effect(() => mountFootCard(store), 'dsh-abacus: sidebar foot card')

      // No `label` here on purpose: the shipped occupant of this slot
      // (the shell's own stats pills) registers without one, and the pill
      // carries its own text.
      ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
        { name: 'conversation.composer.dock', id: 'abacus-session', order: 10 },
        SessionBadge,
      ))

      ctx.slots.inject('settings.section', () => ctx.slots.register(
        // Order 152: one past the usage plugin this replaces, so the two never
        // fight over position while both are installed and this section stays
        // the last one when the other is removed.
        { name: 'settings.section', id: 'abacus', order: 152, label: () => t('title'), inject: () => ({ store }) },
        UsageSection,
      ))
    }

    //#endregion

    return module.exports
  },
})
