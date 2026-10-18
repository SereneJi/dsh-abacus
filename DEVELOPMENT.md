# 开发与维护

面向维护者。用户视角的说明在 [README.md](README.md)。

- [数据从哪来](#数据从哪来)
- [为什么是「替换」而不是「累加」](#为什么是替换而不是累加)
- [状态文件与配置](#状态文件与配置)
- [HTTP 接口](#http-接口)
- [代码结构](#代码结构)
- [刻意的设计取舍](#刻意的设计取舍)
- [开发](#开发)
- [预览台](#预览台)
- [回退](#回退)
- [为什么客户端有测试缝](#为什么客户端有测试缝)
- [升级路径](#升级路径)

## 数据从哪来

唯一的来源是宿主端的 `ctx.on('session/event', (session, event) => …)`：

- 用量取 `assistant/message` 事件里的 `data.usage`（`inputTokens` / `outputTokens` /
  `cacheReadTokens` / `cacheWriteTokens`，`totalTokens` 可能缺省）。`assistant/attempt`
  也可以从 `data.stream` 里最后一个 `{type:'chunk', chunk:{type:'usage'}}` 取到同一份数字。
- **归属取每一次调用自己的路由**：`data.message.source = {kind:'model', provider, model}`，
  而不是「这个会话用的是什么」。同一段对话换模型、换供应商，账本会分别记在各自名下。
- **时间取事件的 `time`**，折算成本地日期键，所以跨午夜的调用落在它真正发生的那一天。

## 为什么是「替换」而不是「累加」

朴素地把每个 `assistant/message` 加起来会**重复计数**：同一次调用在流错误后重试时会再报一次
结算，坐标 `(turn, step)` 相同。DSH 自己的 token 投影为此维护「每个会话最后一个样本」，
本插件沿用同一套语义：

- 账本里保留每个会话最后一个样本（`samples`），同 `(turn, step)` 再报时**先减掉旧的、
  再加上新的**，所以重试算一次调用而不是两次。
- `llm/retry-started` 事件会清掉对应槽位，让重试从零开始计。
- 样本自带 `dayKey` / `provider` / `model`，所以替换发生在「原来那一天的原来那个桶」里，
  跨午夜重试也不会把用量搬到第二天。
- 会话桶与每日账本出自**同一批事件、同一条先减后加路径**，不是从聊天记录反推的第二份真相。

两个配套的正确性细节：

- **`seq` 重放保护**：每个会话记住最后处理过的事件序号，序号不大于它的直接丢弃。
  历史补录与实时流因此可以安全地重叠。
- **原子写**：状态文件先写临时文件再 `rename`，进程被中断也不会留下半个 JSON。

## 状态文件与配置

| 路径 | 内容 |
|---|---|
| `$DSH_HOME/usage-stat/usage.json` | 账本：`days`（按日期/供应商/模型）、`sessions`（按会话）、`samples`（替换槽位）、`history`（补录书签） |
| `$DSH_HOME/usage-stat/providers.json` | 供应商余额与套餐快照（带 `updatedAt`，重启后仍然可用） |
| `$DSH_HOME/usage-stat/config.json` | 插件配置 |

`$DSH_HOME` 默认是 `~/.dsh`，可用环境变量覆盖。配置也可以直接改文件（改完刷新页面即可；
宿主端每次读文件都会做一次范围校验）：

```json
{
  "enabled": true,
  "pollIntervalSec": 60,
  "probeEnabled": true,
  "probeIntervalSec": 300,
  "alertEnabled": true,
  "alertBalanceBelow": 0,
  "alertWindow5h": 0,
  "alertWindowWeek": 0,
  "alertWindowMonth": 0
}
```

字段含义、范围与默认值见 [README 的配置表](README.md#配置)。

## HTTP 接口

前缀 `/api/usage-stat`。**宿主端注册时带前导斜杠，浏览器请求时不带**：GUI 用
`<base href="./">` 提供服务，不带斜杠才会在子路径部署下解析到入口目录而不是站点根。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/overview` | 浏览器轮询的那一份文档：配置、今日明细、可用日期、供应商列表、当前余量提醒、版本号、补录状态 |
| GET | `/day?date=YYYY-MM-DD` | 某个保留日的明细；非法日期返回 400 |
| GET | `/range?from=&to=` | 一个统计窗口的合计、供应商明细与逐日序列；空串表示「一直回溯到保留边界」，`from > to` 返回 400 |
| GET | `/session?id=<sessionId>` | 某个会话的累计用量，含它自己的分供应商、分模型明细 |
| GET | `/providers` | 供应商余额与套餐快照 + 可探测路由目录 |
| POST | `/probe` | 立刻重查一遍供应商（不等下一个周期） |
| POST | `/backfill` | 立刻把 DSH 已保存的会话日志重放一遍（不等启动时那一次） |
| POST | `/config` | 局部更新配置（有界 body + 逐字段校验） |
| POST | `/refresh` | 落盘并返回一份重新组装的 overview |

窗口聚合（`/range`）**不在** `/overview` 里：它取决于用户选了哪段时间，不属于每 60 秒
轮询一次的那份文档。设置页打开时按所选范围单独请求，并跟着 `overview.updatedAt` 一起刷新。

`/probe` 是唯一会主动打供应商端点的路由，而且只在账户页打开时才被前端调用。

所有路由都过一道信任栅栏：回环地址（桌面端）直接放行，装了配对服务时已配对设备的
cookie 也放行，其余 403。响应一律 `cache-control: no-store`。

### 余额与套餐的凭据从哪来

宿主端调 DSH 的 `credentials` 服务（`ctx.get('credentials')`），顺序是：

1. 记录 `llm-pi-ai/<路由>`：`kind === 'api-key'` 取 `key`；`kind === 'grant'` 取
   `payload.access`（Codex 另取 `payload.chatgpt_account_id`）。
2. 否则读 `llm-pi-ai` 命名空间里该路由的 `apiKeyEnv`（DeepSeek 路由回退到
   `llm-deepseek.apiKeyEnv ?? 'DEEPSEEK_API_KEY'`），再用 `credentials.resolve(名字)`。
3. 都没有 → `{kind: 'none'}`，界面显示「未配置 API Key」。

`credentials` 服务的 API 接受纯字符串（`credentialRef` / `credentialKey` 只是编译期品牌，
运行时就是原字符串），所以宿主端仍然不 import 任何 `@deepseek-ai/*` 包。

### 历史补录的实现

DSH 的会话日志是 `$DSH_HOME/sessions/**/session.v4.jsonl.zstd`，**多个 zstd 帧拼在一起**，
`zstdDecompressSync` 只解第一帧、流式解压会在第二帧报 `prefix_unknown`。所以
`lib/host/history.js` 按魔数 `28 b5 2f fd` 切帧后逐帧解压，再按行解析成与实时事件同形状的
信封，交给同一套折叠逻辑。补录落盘一个书签（`doc.history`），启动时只在没有书签时才扫全量；
扫到的每一个会话都复用 `seq` 重放保护，所以补录与实时流重叠也不会重复计数。

## 代码结构

```
dsh-usage-stat/
├─ package.json          # 包契约：exports{"." , "./client"} + dsh{bundle,client}
├─ cordis.patch.yml      # 一行 insert，把本插件挂进 profile 的插件名册
├─ icon.svg
├─ lib/
│  ├─ index.js           # 宿主端插件体：建服务、注册路由、跨 fiber 单实例保护
│  ├─ dsh-home.js        # $DSH_HOME 解析
│  ├─ client.js          # 浏览器端（ModuleLoader 格式，无构建步骤）
│  ├─ core/
│  │  ├─ totals.js       # 桶算术（emptyTotals / addTotals / totalTokens）
│  │  ├─ document.js     # 持久化文档 + 替换折叠 + 汇总 + 剪枝 + 反序列化
│  │  ├─ samples.js      # 会话事件 → 样本（用量、归属、坐标、重试边界）
│  │  ├─ adapters.js     # 余额/套餐的端点表与纯解析函数（无网络）
│  │  ├─ alerts.js       # 余量提醒的阈值判定（纯函数，无 I/O）
│  │  ├─ providers.js    # 供应商显示名兜底表（纯装饰）
│  │  └─ types.js        # 跨线传输的形状（JSDoc typedef）
│  └─ host/
│     ├─ usage-service.js  # 账本服务：订阅、折叠、视图、配置、持久化、历史回放
│     ├─ probe-service.js  # 供应商探测：凭据 → 请求 → 快照（失败保留上一次成功值）
│     ├─ credentials.js    # 凭据解析（记录 → 环境引用 → 无），纯字符串调 credentials 服务
│     ├─ history.js        # 逐帧解压 DSH 的会话日志（拼接 zstd）并还原成事件
│     ├─ version.js        # 从 package.json 读版本号，供界面显示
│     ├─ routes.js         # 九个路由 + 统一的栅栏/405 处理
│     ├─ config.js         # 默认值、范围、校验、局部更新
│     ├─ access.js         # 回环 + 配对设备信任栅栏
│     └─ http.js           # 有界 JSON body 读取 + JSON 写回
├─ tools/
│  ├─ check-tokens.mjs     # 审计客户端用到的 --dsw-* 主题 token 是否仍被 shell 定义
│  ├─ verify-served.mjs    # 核验运行中的宿主端是否在服务当前这份 lib/client.js
│  ├─ preview.mjs          # 把真实组件渲染成静态页并截图，用于离线视觉评审
│  ├─ bump.mjs             # 升版本：改 package.json、开一节本地 CHANGELOG、同步 README 徽章
│  └─ rollback.mjs         # 一条命令退回改版前的标签
├─ preview/                # preview.mjs 的产物（png + 缓存的 tokens.css；html 不入库）+ 说明各图的 README
├─ .github/workflows/
│  └─ test.yml             # CI：每次 push 跑 npm test（不跑需要活宿主的两支脚本）
└─ test/
   ├─ harness.mjs          # 假 DOM、假 hook 运行时、loadBundle 与夹具（测试与预览台共用）
   ├─ document.test.mjs   # 纯折叠的单元测试（替换语义、跨午夜、剪枝、脏数据）
   ├─ service.test.mjs    # 账本服务 + 路由的集成测试（真事件、真 handler、真落盘）
   ├─ probe.test.mjs      # 适配器表、凭据解析、探测服务（注入假 fetch，不碰网络）
   ├─ alerts.test.mjs     # 余量提醒阈值（0 = 关、低于才命中、读不到就不猜）
   ├─ history.test.mjs    # 多帧 zstd 的解帧、事件解析、日志发现
   ├─ client.test.mjs     # 浏览器端的接线与渲染测试（手写 DOM + hook 运行时）
   ├─ plugin.test.mjs     # lib/index.js 本身：九个路由、单次订阅、跨 fiber 挂载保护
   └─ tools.test.mjs      # tools/ 里各脚本的判定逻辑（纯函数 + 一次真仓库干跑）
```

## 刻意的设计取舍

- **没有构建步骤**。`lib/client.js` 就是浏览器加载的那份产物，宿主端是普通 ESM。
  代价是客户端不能写 JSX、也不能从其他文件 import；收益是「改完即生效」，
  以及升级 DSH 时不需要重装工具链。客户端 CSS 以字符串形式内联注入一次。
- **没有 schemastery `Config`**。用宿主端设置表单意味着插件要跟着宿主设置面板的版本走，
  而且用户改不了插件的私有状态。所以配置放在插件自己的 JSON 里，由
  `POST /api/usage-stat/config` 编辑、由 `normalizeConfig` 每次校验。
  代价：改配置不会重挂插件行（好处是服务与路由不会中断）。
- **只用 `--dsw-*` 语义 token 上色**，不写死颜色，所以跟随主题，也跟随用户皮肤对这些
  token 的重映射。
- **左下角那张卡是 DOM 注入的**。侧边栏 foot 唯一的 slot（`sidebar.footer.action`）是
  一行横向 action，放不下整块卡片。所以卡片是自带 React root 的独立容器，插在 foot 区
  Settings 行之前，并由一个按帧合并的 body MutationObserver 在 shell 重渲染后重新就位。
- **「本次对话」胶囊走正规 slot**（`conversation.composer.dock`）。关闭态直接读该 slot
  环境自带的 `useProjection('tokenUsage')`，所以**不需要任何 HTTP 请求**，也不可能和正文里
  每轮的用量行对不上；**点开**时才按需向 `/api/usage-stat/session` 取这块对话自己的分供应商、
  分模型明细。面板用 portal 挂在 `document.body` 上，样式与定位逻辑照着 shell 自己的
  「上下文已用 N%」面板写（`--dsw-*` token 与同一套排版），所以它看起来是 GUI 的一部分。
  悬停提示被刻意去掉了：一个重复面板内容、且只有一行字的 tooltip 是面板更差的副本。
- **余额与套餐没有本地估算**。这两个数字只可能来自供应商的接口，所以插件宁可显示
  「为什么没有」也不显示一个猜出来的数：查不到就写原因，凭据没了就**丢掉**上次的事实
  （而不是留着一个无法再验证的数字），请求失败则保留上一次成功值并标注可能已过期。
- **探测有独立的开关与周期**（`probeEnabled` / `probeIntervalSec`）。记账是本地的、
  廉价的；探测是要出门的、可能被限流的。把两者绑在一个开关上，会让「我只想统计用量」
  变成「我得允许插件打供应商端点」。
- **提醒在读取时判定，不写进快照**。红点是拿当前阈值去量当前快照算出来的，所以改完阈值
  立刻生效、不需要重查一次供应商；也正因如此，红点不可能指向一个卡片上没有的读数。
  代价是每次读取都要算一遍，但那是几个数的比较。
- **红点是唯一刻意偏离 shell 配色的地方**。它用的是 shell 的静态色 token
  （`--dsw-static-red-400`，带 `currentColor` 兜底），而不是语义 token —— 一个跟随主题
  墨色的警示标记读起来不像警示。除此之外整份 CSS 只用语义 token。

## 开发

```bash
# 语法检查
node --check lib/host/usage-service.js

# 测试（--test-isolation=none 让八个文件在同一个进程里跑；
# `node --test test/` 会为每个文件 spawn 子进程，在受限沙箱里带管道 stdio 的 spawn 会 EPERM）
npm test

# 主题 token 审计：客户端用到的 --dsw-* 是否仍被正在运行的 shell 定义
# （shell 改名/删除 token 会让卡片静默裸奔，所以这条要能失败）
node tools/check-tokens.mjs

# 产物核验：正在运行的宿主端是否真的在服务当前这份 lib/client.js
# （客户端是热替换的，但「我改了文件」和「页面跑的是改后的」是两件事）
node tools/verify-served.mjs

# 视觉评审：把真实组件渲染成 preview/*.html 并用无头 Chrome 截图
node tools/preview.mjs

# 升版本：改 package.json、在本地 CHANGELOG 里开一节、同步 README 里的版本徽章
# （CHANGELOG.md 在 .gitignore 里：发布出去的仓库只有第一个提交，改动明细留在本机）
npm run bump -- minor

# 调试：让被吞掉的会话事件异常抛出来
export DSH_USAGE_STAT_DEBUG=1
```

`test/probe.test.mjs` 全部注入假 `fetch` 与假 ctx，**不碰网络**：供应商端点的解析、
凭据解析、以及探测服务的失败/过期语义都能在没有网络、没有凭据的机器上验证。

`test/tools.test.mjs` 测的是 `tools/` 里各脚本**做决定的那一半**，所以它们的判断不再只能
靠在装好的环境上跑一次来验证。凡是需要「正在运行的 DSH」的检查（`check-tokens`、
`verify-served`）都不在 CI 里：它们审计的是装好的 shell，不是这个仓库。

改 `lib/client.js` 后刷新页面（HMR 轮询约 0.5 秒）；改宿主端任何文件后重启 DSH。

## 预览台

改样式最难的一步是「看一眼」。桌面端的 DevTools 端口不对外，插件也拿不到应用窗口的
截图，所以 `tools/preview.mjs` 换了条路：用**测试台那套 hook 运行时**把真实的
`UsageSection` 与侧边栏那张卡渲染出来，前者套进一个明确标注为 mock 的设置对话框
外壳、后者套进一个 248px 宽的侧边栏替身，写成 `preview/*.html`，再用无头 Chrome 截成
`preview/*.png`（`usage` / `account` / `settings` / `foot` / `foot-collapsed`）。样式表
逐字取自 `lib/client.js`，`--dsw-*` 取值实时从正在运行的 shell 抓（拿不到时用
`preview/tokens.css` 缓存）。

它因此能看到真实排版，代价是**看不到 hover、焦点环、动画和真实滚动**，也不证明
插件在 DSH 里挂得上 —— 那是 `verify-served.mjs` 的事。

每张图的画布是**按内容量出来的**，不是固定尺寸：页面在 load 时把
`document.documentElement.scrollHeight` 写进 `<html data-preview-height>`，`shoot()` 先
用 `--dump-dom` 读回这个值，再按它设窗口高度。以前所有截图共用一个 860×1120 的窗口，
侧边栏那张卡（248px 宽的一列）因此落在多半是空白的画布上，放进 README 里就成了一大段
空白间隔。

两个无头 Chrome 的坑，写在这里免得下次再踩：

- **Windows 上窗口宽度有 500px 下限**。要 328px 宽的侧边栏截图，实际布局仍按 500px 走，
  而 `--screenshot` 只截左上角你要的那块 —— 所以侧边栏替身是**左对齐**而不是居中的：
  居中会把它推出被截取的区域，截出来只剩右半张卡。
- **量高度时要用很矮的窗口**（`contentHeight` 用 200px）。窗口给多高，
  `scrollHeight` 至少就是多高，量出来的会是窗口而不是内容。

样例数据里的时间是**写死的**（`FIXED_NOW`）、版本号是从 `package.json` 读的，所以连跑两次
得到的 `preview/*.png` 逐字节相同 —— `preview/*.png` 出现 diff 就说明设计真的动了，而不是
时钟又走了一格。这两处以前分别是 `Date.now()` 和写死的 `0.8.0`。

侧边栏替身里那几行会话标题是**编的**（`RAIL_ROWS`），不是任何人的真实对话列表：这些图会
进仓库、进 README，`test/tools.test.mjs` 把这个列表钉住，改它必须是有意为之。

`--client=<路径> --tag=<名字>` 可以渲染另一份 bundle，用来做前后对比：

```bash
git show baseline-0.6.2:lib/client.js > /tmp/before.js
node tools/preview.mjs --client=/tmp/before.js --tag=before
```

`--cache-write=<tokens>` 给窗口塞进缓存写。只有 Anthropic 那类供应商会报这个数字，
所以默认样例里它是 0、那一格不显示 —— 想知道「有缓存写时长什么样」就得显式打开：

```bash
node tools/preview.mjs --cache-write=860000 --tag=cache-write
```

## 回退

改版前打了标签，不满意可以整份退回：

```bash
node tools/rollback.mjs                       # 先看会撤掉哪些改动（不动文件）
node tools/rollback.mjs --yes                 # 退回最近一次打标签的版本
node tools/rollback.mjs --tag=baseline-0.6.2 --yes   # 或指定更早的标签
```

不带 `--tag=` 时退回到**最新的** `baseline-*` 标签（按版本号比大小，不是按字符串），
也就是「把上一次改版收回去」；想一路退到最初的设计就显式点名 `baseline-0.6.2`。
客户端是热替换的，退回后刷新页面即生效。想看差异：
`git diff baseline-0.6.2 -- lib/client.js`；想再回到新版：`git checkout HEAD -- .`。

**`baseline-*` 标签只存在于本地仓库，刻意不推送到 GitHub**：它们是给「不满意就退回去」
用的工作标签，不是发布版本。远端只有 `main` 分支。

## 仓库里为什么只有一个提交

发布出去的仓库看上去是**第一版**：一个 `main`、一个提交、没有 changelog、没有版本演进。
开发过程完整地留在本机，不随发布出去：

| 留在本地 | 是什么 |
| --- | --- |
| `CHANGELOG.md` | 逐版本的改动明细；在 `.gitignore` 里，`tools/bump.mjs` 照常维护它 |
| 分支 `history` | 真正的开发历史（所有中间提交） |
| `baseline-*` 标签 | 每次改版前的回退点 |
| `../dsh-usage-stat-history.bundle` | 上面三者的整包备份（`git bundle`，可异地还原） |

也就是说：`main` 是一个孤提交，只用来发布；想知道「这行代码是怎么变成现在这样的」就去
`history` 分支。新增改动时直接提交到 `main`（发布会把整棵树推上去），或者照下面的办法重新
压成一个提交：

```bash
git branch -f history main        # 开发历史先落地
git checkout --orphan fresh       # 无父提交的新根
git add -A && git commit -m "Initial release <version>"
git branch -M fresh main
```

**推送前确认 `git log --oneline` 只有一行**；`git push --force origin main` 会重写远端，
这一步要先得到用户明确同意。

## 为什么客户端有测试缝

`lib/client.js` 的末尾导出了 `exports.__internals`，里面是几个组件和纯函数。
模块加载器只读 `apply` / `inject` / `name`，所以这个面在浏览器里是惰性的；
它的唯一用途是让 `test/client.test.mjs` 能在 Node 里把真正的产物跑起来。

这不是洁癖。这一版最严重的一个 bug 就在这里：factory 往一个**从未声明过的 `exports`**
上写东西，于是浏览器一执行 bundle 就抛 `exports is not defined`，插件从未 apply，
三处界面全空 —— 而宿主端一切正常，日志干净，路由 200。宿主侧的任何测试都抓不到它。
现在那个测试文件会把手写的假 DOM、假 `require`、假 React hook 运行时塞给真实的
`lib/client.js`，断言 bundle 能执行、能导出 `apply`、`apply` 不抛、两个 slot 注册正确、
卡片插在 Settings 行之前、以及各组件的渲染输出。

## 升级路径

- 账本文档带 `version` 字段。**加字段可以不改版本**（反序列化会忽略不认识的键）；
  **改已有字段的含义必须同时加读取迁移**。
- 事件契约只依赖 DSH 稳定面：`session/event` 的 `assistant/message` / `assistant/attempt` /
  `request/header` / `request/context` / `llm/retry-started`，以及 `session.id`、`event.seq`、
  `event.time`。这些都在 `@deepseek-ai/dsh-session` 的已知事件表里。
- 客户端只依赖三个**加载器已种下的**模块：`react` 的 `createElement`、`react-dom` 的
  `createPortal`、`react-dom/client` 的 `createRoot`，外加 `slots` 服务。
  **不从 `@deepseek-ai/dsh-client-*` 运行时 import**（DSH 明确不建议），
  只把 `useProjection`、`sessionId` 当普通 props 用。假 `require` 会拒绝任何其他 id，
  所以这条约束由测试守着。
- 主题 token 是唯一无法靠类型挡住的耦合，所以交给 `tools/check-tokens.mjs` 每次升级后跑一遍。
- 侧边栏落位依赖 shell 的 `[class*="sidebarCol"]` / `[class*="footArea"]` /
  `[class*="settingsArea"]` 三个真实存在的类名，对策是**有界重试 + MutationObserver 自我复位**
  （命中不了就退化到 foot 末尾，不崩）。
- 供应商端点表（`lib/core/adapters.js`）是**外部契约**，会随供应商改版而失效。
  它的每一行都是纯数据 + 纯解析函数，所以改起来是改数据而不是改流程；
  失效时的表现是那一行显示「查询失败：HTTP …」，而不是崩溃或显示错数。
