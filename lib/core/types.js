/**
 * Wire-facing view shapes. Every type here crosses the browser boundary as
 * JSON, so the host only ever serves plain data — never a class instance, a
 * Date, or a Map — and the browser needs no revival step.
 *
 * These are JSDoc typedefs rather than TypeScript declarations: this package
 * ships exactly the JavaScript it runs (no build step), and the typedefs give
 * editors and readers the same contract without a compile.
 *
 * @module dsh-abacus/core/types
 */

/**
 * One disjoint token bucket set, summed over model calls.
 * @typedef {object} TokenTotals
 * @property {number} inputTokens - uncached input tokens (the session projection's `uncachedInputTokens`).
 * @property {number} outputTokens - output tokens, reasoning included.
 * @property {number} cacheReadTokens - prompt tokens served from the provider cache.
 * @property {number} cacheWriteTokens - prompt tokens written into the provider cache.
 * @property {number} reasoningTokens - reasoning tokens, when the provider reported them (inside `outputTokens`).
 * @property {number} calls - model calls that reported usage.
 */

/**
 * One provider row of a day or range summary.
 * @typedef {object} ProviderSummary
 * @property {string} provider - the provider route key (`opencode-go`, `deepseek`, ...).
 * @property {string} displayName - a legible name, falling back to the route key.
 * @property {TokenTotals} totals - the provider's summed buckets.
 * @property {ModelSummary[]} models - per-model rows, heaviest first.
 */

/**
 * One model row inside a provider summary.
 * @typedef {object} ModelSummary
 * @property {string} model - the provider-owned model id.
 * @property {TokenTotals} totals - the model's summed buckets.
 */

/**
 * One local day aggregated per provider and model.
 * @typedef {object} DayView
 * @property {string} date - local-date key `YYYY-MM-DD`.
 * @property {TokenTotals} totals - the day's grand total.
 * @property {ProviderSummary[]} providers - per-provider rows, heaviest first.
 */

/**
 * One day of the trend line.
 * @typedef {object} DaySummary
 * @property {string} date - local-date key `YYYY-MM-DD`.
 * @property {TokenTotals} totals - that day's grand total.
 * @property {CostView} [cost] - what that day's calls cost, in the range view.
 */

/**
 * An aggregated window of the ledger (the trend, or the whole retention).
 * @typedef {object} WindowSummary
 * @property {string} from - first local-date key in the window.
 * @property {string} to - last local-date key in the window.
 * @property {TokenTotals} totals - the window's grand total.
 * @property {ProviderSummary[]} providers - per-provider rows, heaviest first.
 */

/**
 * The route the newest model call ran on — what the settings header shows.
 * @typedef {object} CurrentRoute
 * @property {string} [provider] - the route key, absent before the first call this boot.
 * @property {string} [model] - the model id.
 * @property {string} [displayName] - resolved provider display name.
 * @property {'live'|'ledger'|'default'} source - how the route was picked: a call seen this boot, the newest ledger row, or nothing at all.
 * @property {TokenTotals} [today] - today's totals for that provider, when the ledger has any.
 */

/**
 * One provider the runtime knows about.
 * @typedef {object} ProviderInfo
 * @property {string} id - the route key.
 * @property {string} displayName - legible name.
 * @property {boolean} live - whether the LLM runtime currently serves requests on this route.
 * @property {TokenTotals} [today] - today's totals recorded for this provider.
 */

/**
 * The plugin's own live configuration, as the settings card edits it.
 * @typedef {object} UsageConfig
 * @property {boolean} enabled - whether the host folds usage and the browser renders any surface.
 * @property {number} pollIntervalSec - browser refresh cadence, 5-600.
 * @property {boolean} probeEnabled - whether the host queries vendor balance and plan endpoints.
 * @property {number} probeIntervalSec - vendor probe cadence, 60-3600.
 * @property {boolean} alertEnabled - master switch for the low-quota reminder dots.
 * @property {number} alertBalanceBelow - balance below this amount raises a reminder, 0-1000000; 0 is off.
 * @property {number} alertWindow5h - reminder when this window's *remaining* share is below it, 0-100; 0 is off.
 * @property {number} alertWindowWeek - as `alertWindow5h`, for the weekly window.
 * @property {number} alertWindowMonth - as `alertWindow5h`, for the monthly window.
 * @property {Record<string, { input: number, output: number, cacheRead: number, cacheWrite: number }>} prices - the user's own price rows, CNY per million tokens, keyed by model id.
 */

/**
 * One low-quota reminder: a vendor fact that fell below a threshold the user set.
 *
 * Two kinds, because the two facts are not the same kind of thing. A window
 * reminder carries the spent share and the remaining share it was judged on; a
 * balance reminder carries the amount and its currency, and no conversion is
 * ever applied.
 *
 * @typedef {object} ReminderView
 * @property {string} provider - the provider route key.
 * @property {string} displayName - legible name.
 * @property {'window'|'balance'} kind - which fact is below the line.
 * @property {string} [window] - the window key, for a window reminder.
 * @property {number} [percent] - the window's spent share, for a window reminder.
 * @property {number} [remaining] - the window's remaining share, for a window reminder.
 * @property {string} [currency] - the balance's currency, for a balance reminder.
 * @property {number} [amount] - the balance amount, for a balance reminder.
 * @property {number} threshold - the line that was crossed.
 */

/**
 * A provider account balance, as one vendor endpoint reported it.
 * @typedef {object} BalanceView
 * @property {string} currency - the ISO code the endpoint sent (`CNY`, `USD`).
 * @property {string} totalBalance - the amount, verbatim from the endpoint.
 * @property {number} updatedAt - epoch ms of the successful probe.
 */

/**
 * One rolling window of a coding plan.
 * @typedef {object} PlanWindowView
 * @property {string} key - window identity (`5h`, `week`, `month`, or a vendor-specific key).
 * @property {string} [name] - the vendor's own label, when it sent one.
 * @property {number} [percent] - spent share, 0-100.
 * @property {string} [resetsAt] - ISO instant the window resets, omitted when unknown.
 */

/**
 * A provider's coding-plan quotas.
 * @typedef {object} PlanView
 * @property {string} [planName] - the subscription tier, when the vendor named it.
 * @property {PlanWindowView[]} windows - the windows, in vendor order.
 * @property {number} updatedAt - epoch ms of the successful probe.
 */

/**
 * One provider's vendor facts: what we asked, what came back, and why not.
 *
 * `balanceSupported` / `planSupported` are what the tabs branch on. A fact can
 * be absent while supported — that means the last probe failed, and
 * `balanceError` / `planError` says why. Codes (`'no-credential'`,
 * `'oauth-credential'`, `'origin-mismatch'`, `'unsupported'`) are translated by
 * the browser; anything else is a vendor's own message, shown verbatim.
 * @typedef {object} ProviderSnapshotView
 * @property {string} provider - the provider route key.
 * @property {string} displayName - legible name.
 * @property {'none'|'api-key'|'oauth'} credential - what kind of credential was resolved.
 * @property {string} [credentialSource] - where it came from (a record key, or an env reference name).
 * @property {boolean} balanceSupported - whether a balance endpoint applies to this route.
 * @property {boolean} planSupported - whether a plan endpoint applies to this route.
 * @property {BalanceView} [balance] - the last successful balance, kept across failed probes.
 * @property {string} [balanceError] - why there is no fresh balance.
 * @property {PlanView} [plan] - the last successful plan, kept across failed probes.
 * @property {string} [planError] - why there is no fresh plan.
 * @property {number} [updatedAt] - epoch ms of the last successful probe for either fact.
 */

/**
 * The vendor-facts document: `api/abacus/providers` and the forced probe.
 * @typedef {object} VendorFactsView
 * @property {number} updatedAt - epoch ms this document was assembled.
 * @property {boolean} probing - whether a probe sweep is in flight.
 * @property {number} intervalSec - the configured probe cadence.
 * @property {ProviderSnapshotView[]} providers - every provider with a supported fact, plus probed ones.
 * @property {ReminderView[]} alerts - facts currently below the user's thresholds.
 * @property {object} catalog - what the plugin *could* query, for the unconfigured hint.
 * @property {string[]} catalog.probeable - route keys with a known balance or plan endpoint.
 */

/**
 * The current conversation's usage, as the composer badge and its click-open
 * panel render it.
 * @typedef {object} SessionUsageView
 * @property {string} sessionId - the session the totals belong to.
 * @property {TokenTotals} totals - that session's summed buckets.
 * @property {number} updatedAt - epoch ms of the last fold for this session.
 * @property {ProviderSummary[]} providers - that session's own per-provider, per-model breakdown (empty for a row recorded before the breakdown existed).
 * @property {string} [provider] - the route the session last ran on.
 * @property {string} [model] - the model the session last ran on.
 */

/**
 * The document the browser polls: everything the card, the badge and the
 * settings section need, in one response.
 * @typedef {object} UsageOverviewView
 * @property {number} updatedAt - epoch ms this document was assembled.
 * @property {string} version - the plugin version the host is running, read from its manifest.
 * @property {UsageConfig} config - the live configuration.
 * @property {CurrentRoute} current - the route the settings header names.
 * @property {ProviderInfo[]} providers - every provider the runtime knows, plus ledger-only ones.
 * @property {ReminderView[]} alerts - facts currently below the user's thresholds, from the probe cache.
 * @property {object} usage - the usage windows.
 * @property {DayView} usage.today - today's per-provider per-model detail.
 * @property {string[]} usage.availableDays - every retained day that recorded usage, ascending.
 */

/**
 * One caller-chosen window, aggregated. Produced by
 * `UsageService.rangeView` and served by `api/abacus/range`, so the
 * settings picker can ask for any window without the polled overview growing.
 * @typedef {object} RangeView
 * @property {string} from - the first local-date key in the window, inclusive.
 * @property {string} to - the last local-date key in the window, inclusive.
 * @property {TokenTotals} totals - the window's summed buckets.
 * @property {ProviderSummary[]} providers - the window per provider, heaviest first.
 * @property {DaySummary[]} days - per-day totals inside the window, ascending, days without usage omitted.
 * @property {CostView} cost - what those tokens would cost at the current price table.
 * @property {HourView} [hours] - the hour breakdown, present only when the window is a single day.
 */

/**
 * One model's money, at the price table in force when the view was assembled.
 * @typedef {object} CostModel
 * @property {string} model - the model id as the provider reported it.
 * @property {number} cost - the converted amount, 0 when the model is unpriced.
 * @property {number} tokens - the tokens this row bills for.
 * @property {number} calls - the model calls behind them.
 * @property {boolean} priced - whether the price table knew this model; false means `cost` is 0 because nothing was known, not because it was free.
 */

/**
 * One provider's money, with its models.
 * @typedef {object} CostProvider
 * @property {string} provider - the provider route key.
 * @property {number} cost - the provider's converted total.
 * @property {number} tokens - the provider's billed tokens.
 * @property {number} pricedTokens - how many of them the table could price.
 * @property {number} unpricedTokens - the rest.
 * @property {CostModel[]} models - per-model rows, dearest first.
 */

/**
 * A token-to-money conversion over one window.
 *
 * Recomputed on every read rather than stored, so a corrected price corrects the
 * money reported for calls that already happened. The unpriced models are named
 * rather than dropped: a total that silently omits half the tokens would be a
 * worse answer than no total.
 *
 * @typedef {object} CostView
 * @property {string} currency - the ISO code every row is quoted in.
 * @property {number} total - the converted amount, over priced tokens only.
 * @property {number} tokens - all billed tokens in the window.
 * @property {number} pricedTokens - the tokens the table could price.
 * @property {number} unpricedTokens - the tokens it could not.
 * @property {number} unpricedCount - how many distinct models went unpriced.
 * @property {Array<{ model: string, tokens: number }>} unpriced - the heaviest of them, so the UI can name what to price next.
 * @property {CostProvider[]} providers - per-provider rows, dearest first.
 */

/**
 * One day broken down by clock hour. Produced by `UsageService.hourView` and
 * carried by a single-day {@link RangeView}, so the settings chart can show the
 * shape of a day instead of one bar per day.
 * @typedef {object} HourView
 * @property {string} date - the local-date key the hours belong to.
 * @property {boolean} available - whether this ledger has hour resolution at all; false on a ledger written before hours were recorded.
 * @property {CostView} cost - the day's conversion, the same one the range carries.
 * @property {Array<{ hour: number, totals: TokenTotals, cost: CostView }>} hours - the hours that recorded something, ascending, empty hours omitted.
 */

export {}
