# DECISIONS

每条记录：选了什么 · 为什么 · 放弃了什么 · 日后如何替换。按主题分组，新决策追加在对应分组末尾并注明日期。

---

## 0. 外部事实核实（2026-10-24，Phase 1 开工前）

| 指令 §3 的说法 | 官方文档现状 | 处理 |
|---|---|---|
| search.list 每次 100 units，与其他接口共用 10,000 units/天 | **已变**：2026-06-01 起分桶。search.list 独立 "Search Queries" 桶，默认 **100 次/天，每次计 1**；其他接口共用 10,000 units/天；均在太平洋时间零点重置（[配额计算器](https://developers.google.com/youtube/v3/determine_quota_cost)、[修订记录](https://developers.google.com/youtube/v3/revision_history)） | 已向用户汇报。用户确认：**单次口令 ≤ 3 次 search**（对应原"≤300 units"的本意），通用桶单次 ≤ 50 units；两个桶分开记账、分开显示 |
| 多数读取接口 1 unit | 一致；`videos.list?myRating=like` 最多只能翻到最近 1000 条 | 同步上限可设，硬上限 1000 |
| relevanceLanguage 只影响相关性 | 一致 | 语言约束 = relevanceLanguage + 后置过滤，回显注明 |
| 不提供观看历史 | 一致 | 画像只用订阅 + 喜欢的视频 |
| X 帖子 $0.005/条、Trends $0.010/条、当天去重 | 帖子一致（按 UTC 日去重）；**Trends 是 $0.010/次请求**，不是每条；按量付费月上限 300 万条帖子读取 | Phase 3 才用，届时按此实现 |
| Web Speech 本地识别实验特性 | `SpeechRecognition.available()` / `install()` / `processLocally`（Chrome 139+）| 检测后使用，见 §5 |
| 侧边栏拿麦克风无直通路径 | 确认：侧边栏不显示权限框，直接 `Permission dismissed` | 单独的授权页（标签页）授权一次 |
| chrome.identity 需固定扩展 ID | 一致；且 Google 已不推荐直接用隐式授权流，`launchWebAuthFlow` 官方定位为"非 Google 身份提供方" | 用户确认使用 `getAuthToken`，见 §3；后因 Comet 等非 Chrome 浏览器无法使用，改为 `launchWebAuthFlow`，见 §25 |

## 1. 工程与工具链

**语言：TypeScript（strict + noUncheckedIndexedAccess）。** 静态类型、换会话也容易接手。放弃纯 JS。

**打包：esbuild（直接调用，`scripts/build.mjs` 约 150 行）。** 依赖最少、速度快、行为透明；多入口 + ESM 代码分割正好匹配 MV3（service worker 用 `type: module`）。放弃 WXT / Plasmo / CRXJS：框架魔法多、升级耦合大。替换：入口与 manifest 生成都集中在 build.mjs，换成 Vite 只需改这一个文件。

**UI：Preact 10（成熟版本线）。** 3KB、类型完善、hooks 写法与 React 相同。放弃 React（体积）、Svelte/Vue（需要编译插件）、原生 DOM（回显编辑、结果卡状态较多，手写易乱）。没选 Preact 11：发布仅 3 周。

**测试：Vitest 4.1（单元/服务层）+ Playwright 1.64（真实 Chromium 加载扩展的 e2e）。** Vitest 5 要求 Node ≥ 22，本机是 Node 20。Playwright 必须用自带 Chromium：品牌 Chrome 137+ 已不支持 `--load-extension`。

**LLM SDK：@anthropic-ai/sdk 1.2、openai 6.49（官方 SDK）。** 类型化错误、重试、结构化输出都现成。openai 7.x 要求 Node ≥ 22，所以选 6.x。注意：Anthropic SDK 1.x 默认发送 `anthropic-version: 2026-10-21`，并以 `Authorization: Bearer` 发送 Key。替换：`src/services/llm.ts` 是唯一接触 SDK 的文件。

**TypeScript 7.0（原生编译器）。** 已发布 3 个半月，当前稳定线。如遇问题可降到 6.0.3，配置无需改动。

**不初始化 git。** 指令没要求，目录也不是仓库。已备好 `.gitignore`（排除 `local/`、`dist*/`）。

## 2. 架构

**分层：`core/`（纯函数）→ `services/`（注入依赖：存储、fetch、时钟、授权）→ `ui/`。** 核心逻辑全部可以不出网单测；服务层用内存存储 + 假 fetch 跑完整流程。

**页面直接调用服务，service worker 只管"点图标开侧边栏"和"首次安装打开设置页"。** Phase 1 没有后台任务，不需要消息传递。Phase 2 的定时任务（chrome.alarms + 启动时补算）会在 SW 里复用同一批 `core/`、`services/` 模块。放弃"SW 当后端 + 消息传递"：现阶段只增加复杂度。

**存储：`chrome.storage.local` + `unlimitedStorage`，按键分区（settings / secrets / profile / clusters / rankingModel / ratings / adjustments / corrections / quotaLedger / searchCache / searchSessions）。** 所有上下文可读、改动有 `onChanged` 事件（侧边栏与设置页自动同步）。跨上下文读改写用 Web Locks（同属扩展 origin）。放弃 IndexedDB/Dexie：数据量小（几 MB），多一个依赖不值。替换：`services/storage.ts` 的 `KV` 接口。

**配置集中：数值在 `src/config/defaults.ts`，网络出口在 `src/config/endpoints.ts`。** manifest 的 `host_permissions` 与 CSP `connect-src` 由构建脚本从 endpoints 生成，出口只有一个来源。

## 3. YouTube 授权

> **已被 §25 取代**（2026-10-24）：改为 `launchWebAuthFlow` + "Web 应用"类型客户端。下面保留原始决策供对照；"固定扩展 ID"与"只申请 `youtube.readonly`、不设 YouTube API Key"两条仍然有效。

**`chrome.identity.getAuthToken` + "Chrome 扩展"类型 OAuth 客户端 + manifest `key` 固定扩展 ID。**（用户 2026-10-24 确认）
- 为什么：Chrome/Google 官方路径；Chrome 管理令牌缓存与刷新；不需要 client secret；只申请 `youtube.readonly`。
- 代价：(1) 用登录 Chrome 的 Google 账号授权；(2) **OAuth Client ID 必须写进 manifest**（Chrome 的硬性要求，运行时无法传入），所以由构建脚本从本地不入库的 `local/config.json` 注入。Client ID 是公开标识，不是密钥。
- 固定 ID：`npm run setup` 在本机生成 RSA 密钥对，公钥写进 manifest `key`，私钥留在 `local/`（不入库、不进产物）。每位使用者有自己的扩展 ID。
- 放弃：`launchWebAuthFlow` + 隐式流（Google 标为仅供旧代码兼容）；`launchWebAuthFlow` + 授权码 + client secret（要自管刷新令牌，测试状态下刷新令牌 7 天过期）。
- 替换：`services/auth.ts` 的 `AuthProvider` 接口。
- 所有 YouTube 调用都用 OAuth 令牌，不另设 YouTube API Key（少一个密钥要管）。

## 4. 理解：口令 → 约束 → 计划

**LLM 只做"抽取"，落实方式由确定性代码决定。** LLM 用 JSON Schema 结构化输出返回扁平约束列表（每条带原文片段 span）；`core/constraints.ts` 规范化（无效字段降级为"其他要求"并注明，绝不丢弃）；`core/planner.ts` 把每个约束映射成一条或多条落实方式：API 参数 / 检索词 / 后置过滤 / 排序因子 / 数量 / 仅作参考 / 无法满足，并给出覆盖状态（已落实 / 近似 / 部分 / 仅参考 / 无法满足）。
- 为什么：落实逻辑可单测、可解释；LLM 换模型不影响执行语义。

**"不丢约束"的两道本地守卫（`core/coverage.ts`）：**
1. 规则提取器（时效、时长、语言、字幕、Shorts、形式、清晰度、数量、播放量……中英文）：识别到但 LLM 没覆盖的约束，以"本地规则补充"补入；
2. 原句覆盖检查：去掉所有约束片段与口语填充词后仍有意义的片段，以"未识别片段 · 仅作参考"补入。
- 放弃：完全依赖 LLM 自觉（无法验证）；纯规则解析（覆盖不了开放表达）。

**硬/软约束。** 可校验的约束（语言、时长、时效、字幕、播放量、清晰度）为"硬"时做后置过滤，为"软"（"最好…"）时改为排序加分。回显里可以逐条切换。

**"最新"不用 `order=date`。** 官方文档提示非相关度排序配合时间过滤可能结果不全；改为放大新鲜度权重，并在回显里注明。

**Shorts 判定：时长 ≤ 60 秒，或 ≤ 3 分钟且带 #shorts。** API 没有 Shorts 标记，回显注明规则。

**字幕只认上传者字幕（`contentDetails.caption`）。** 自动字幕无法经 API 查询；要求特定语言字幕时标注"无法满足"（需 captions.list，每次 50 units）。

**结构化输出用"空值哨兵"（""、0、[]、"none"）而非 null。** 两家对 null/联合类型的支持细节不同，哨兵最稳。

## 5. 找片、配额、缓存

**每条检索词 1 次 search（maxResults=50），之后 videos.list / channels.list 每 50 个 id 各 1 unit。** 过滤后不足展示条数时，在单次预算内对第一条检索词追加翻页（会在回显标明"含追加翻页"）。

**单次预算由 `OperationBudget` 在每次请求前扣减，超出立即抛错（不悄悄多花）；今日剩余不足时先请用户确认"缩减到 N 条检索词"。** 官方返回 `quotaExceeded` 时本地账本标记耗尽。界面注明"本地估算"：API 不提供剩余配额，同一 GCP 项目的其他调用不在统计内。

**缓存键 = 会产生 API 调用的那部分计划（检索词 + API 参数，时间窗按相对小时记），TTL 30 分钟。** 因此只改过滤/排序的编辑会命中缓存、不耗配额；命中时结果区标"缓存"。

## 6. 排序与推荐理由

**可解释的线性打分：7 个 0–1 因子（检索相关度 RRF、主题命中、个人品味、热度与质量、新鲜度、形式匹配、频道偏好）× 权重。** 口令里的"最新/热门/形式"临时放大对应因子。推荐理由由贡献最大的因子确定性生成，不调用 LLM、不编造；卡片上的"✓ 徽标"来自已通过的硬过滤。每条结果可展开"排序明细"。
- 放弃：LLM 重排/生成理由（成本高、不可复现、理由可能与真实排序依据不符）；向量嵌入相似度（要么新增嵌入服务出口，要么本地模型体积大）。

## 7. 评分与"可见的改进"

- **低分（≤5）先归因**：理解错了 / 找错排错了 / 不归因。高分直接视为"找对了"。
- **找错/排错或高分 → 调排序参数**：频道偏好 ±0.4/次；因子权重按"评分相对中性分的偏离 × 该条在各因子上相对同批平均的偏离"微调（学习率 0.15，权重夹在 [0.02, 0.6] 并归一化）；命中的兴趣簇权重 ±0.15。
  - 2026-10-24 修正：最初用"评分 − 排名预期"作误差，e2e 发现给排在第 9 位的片子打 3 分会被当成"惊喜"而调高其特征权重，改为以中性分 5.5 为基准。
- **理解错了 → 不碰排序参数**，记一条"理解纠正"（被误解的约束 + 用户说明），之后解析口令时作为参考发给 LLM；回显显示"参考了 N 条理解纠正"。
- 每次调整都写进"改进记录"，逐条可撤销（施加反向增量）；改分会先撤销上一次的调整。文案只说"调整了参数/记录了纠正"，不出现"重新训练"。
- 可在设置中关闭"自动调整排序"与"参考理解纠正"。

## 8. 兴趣簇

**LLM 归纳 4–10 个簇（名称、描述、关键词、频道），频道用本地短编号（c1、c2…）引用，真实频道 ID 不发给 LLM。** 用户编辑过的簇自动锁定，重新生成时保留。簇用于"个人品味"因子与意图消歧（只把簇名与关键词发给意图解析）。放弃确定性聚类（topicCategories + 关键词）：标签质量差，用户难以理解。

## 9. 语音

Web Speech API。检测 `SpeechRecognition.available({processLocally:true})`：可用且设置偏好本地 → `processLocally = true`；可下载 → 提供"下载本地语音包"；否则用浏览器云端服务，侧边栏常驻显示"云端识别（音频发往 Google）"。转写只回填输入框，用户点"找片"才执行。麦克风授权走单独的 `mic-permission.html`（标签页）。

## 10. 安全与隐私

- CSP：`script-src 'self'`，`connect-src` 只含 endpoints 生成的 4 个 API 源；`img-src` 加 `https://i.ytimg.com`（用户 2026-10-24 同意加载缩略图）。
- 所有展示给用户的错误先经 `core/redact.ts` 脱敏；构建脚本扫描产物，发现疑似 Key/令牌或测试地址即构建失败。
- 导出不含 API Key（避免密钥随文件扩散）；清空需两步确认（输入"清空"），并让 Chrome 忘掉本扩展的授权。
- e2e 构建（`dist-e2e/`）用插件整体替换 `endpoints.ts`、`auth.ts`，正式构建不含任何测试代码（构建自检会拦）。

## 11. 偏差与未做

- 未实现（Phase 1 时）：Takeout 导入、观看追踪、每日总结、导师提醒、X 热点、新博主。前四项已在 Phase 2 实现（见下文 §12 起），X 热点与新博主属于 Phase 3。
- 默认模型：Anthropic `claude-opus-5-5`（解析用 effort=low）；OpenAI `gpt-6.1-sol`（推理模型发 `reasoning.effort`）。均可在设置中改。Anthropic 请求默认带服务端拒答回退 `fallbacks: "default"`（beta `server-side-fallback-2026-07-01`；不支持的模型上等同不回退）。

---

# Phase 2（2026-10-24）

## 12. 观看追踪

**后台标签页的播放：计入，标为"后台收听"。**（用户 2026-10-24 确认）会话分别累计前台/后台时长；后台时长 > 前台时长的记录标"后台收听"，在总结概览里单独计数；学习/娱乐占比照常计入。

**内容脚本只读本地播放器状态。** 每秒采样一次：地址里的视频 ID、`<video>` 的 currentTime / duration / paused / ended / playbackRate、播放器是否处于广告（`#movie_player` 的 `ad-showing` 类）、`document.visibilityState`。不读页面文字（标题、频道由后台经 videos.list 获取，每 50 个视频 1 unit），不改 DOM，不发网络请求——构建脚本会扫描 `content-tracker.js`，出现 fetch / XHR / WebSocket / innerHTML 赋值 / appendChild 即构建失败。
- 广告检测依赖 YouTube 播放器的 `ad-showing` 类（未公开的实现细节）。YouTube 改版后可能失效：失效时广告时间会被算进有效观看，但完成率不受影响（广告和正片的进度轴不同，跳变会被当作拖动）。替换：`src/content/tracker.ts` 的 `readSample()`。

**有效观看与完成率（`core/watch.ts`）。** 有效观看 = 正在播放且不是广告时的墙钟时间（倍速播放按真实时间算）。完成率 = 实际播放过的内容区间并集 ÷ 时长：每次采样的进度增量不超过"墙钟 × 倍速 + 1.5 秒"才计入区间，否则视为拖动，所以拖进度条刷不了完成率。两次采样间隔超过 75 秒（休眠/挂起）不计。同一天同一视频的多段会话合并为一条记录（区间取并集、时长相加）。

**判定按规格字面顺序。** 瞥一眼 = 完成率 < 15% 或有效观看 < 30 秒；看完 = 完成率 ≥ 85%；其余为部分观看。推论：时长不足 30 秒的视频即使看完也算"瞥一眼"。阈值可在设置中改，改后已有记录会重新判定。

**上报幂等。** 内容脚本每 15 秒、切换视频（含站内跳转）、标签页转入后台、页面关闭时，把会话的**累计值**发给后台；后台按会话 ID 覆盖、丢弃乱序的旧数据，再重算当天该视频的汇总。原始会话保留 3 天，汇总记录长期保留。

## 13. 学习 / 娱乐判定

可解释打分（`core/nature.ts`），每条依据写成人话：兴趣簇倾向（±2，频道在簇内全额、仅关键词命中减半）、YouTube 分类（±1.5，教育/科技/DIY/纪录片为学习，游戏/娱乐/喜剧/音乐等为娱乐，其余中性）、标题/标签关键词（±1）、Shorts（−1）。总分 ≥ +1 为学习，≤ −1 为娱乐，否则"其他"。**用户纠正永远优先**：单条纠正 > 频道纠正 > 信号；纠正可撤销。兴趣簇新增 `nature` 字段：生成时由 LLM 给初值，"画像"页可改；Phase 1 生成的簇没有这个字段，按"说不清"处理。
- 放弃：让 LLM 逐条判定（每条都要花钱、结果不稳定、难以纠正）。

占比按有效观看时长、滚动 7 天（含今天）计算。

## 14. 每日总结与补算

- LLM 只写"今日学了什么 / 值得回看 / 与近期目标的关联"和一句标题；"只是路过"（全部瞥一眼）与所有数字由代码给出。LLM 引用了不存在的条目时丢弃并在总结里注明。只看了"瞥一眼"的日子不调用 LLM。
- 近期目标：设置页新增"近期学习目标"文本框；没填时 LLM 会根据最近几天的主题推断方向，并说明这是推断。
- 连续性：带上前 7 天总结的标题与"学了什么"。
- **调度**：`chrome.alarms` 一个 30 分钟的例行闹钟加一个"下一次 23:00"的一次性闹钟，都设 `persistAcrossSessions: true`。service worker 每次启动、浏览器启动、侧边栏打开时都执行"补算"：对最近 7 天里"总结时刻已过、有观看、却没有总结（或只有到点前手动生成的预览）"的日子逐个生成。多个上下文同时触发时由 Web Locks 串行化。长任务期间每 20 秒调用一次扩展 API，避免 service worker 在等待 LLM 时被回收。
- 失败不静默：失败原因（如没填 Key）记在 `jobState`，在"记录"页显示；同一轮里 LLM 类错误出现一次就不再继续尝试，避免重复失败。
- 手动生成：可以在"记录"页随时生成今天的总结（标"预览"）；到点后会按完整的一天重新生成。
- 导出：单日 Markdown；"记忆库"把全部每日总结与周报按日期倒序拼成一个 Markdown 文件。

## 15. 导师提醒

`core/reminder.ts`：滚动 7 天娱乐占比 > 70% 且学习占比 < 15% 时触发；两次至少间隔 3 天（关闭横幅不影响间隔）；可静音 7 天或永久关闭，设置页可恢复。只在侧边栏顶部显示一条可关闭横幅，不弹窗、不发系统通知。
- **新增参数"观看少于 10 分钟不评估"**（可改，可设 0）：避免只看了一两个短视频就被提醒。属于规格外的小补充，已在设置页明示。
- 台阶：优先取"学习"兴趣簇里权重最高的订阅频道（或你标为学习的频道）的最新上传（channels.list + playlistItems.list，约 2 units）；取不到时给一句找片口令，点了只填进输入框，不自动搜索。
- 文案只陈述数据加一个台阶，不评判、不说教。

## 16. 每周自省报告

默认周日、在每日总结时间生成。LLM 只分析本周低分（≤5）案例的共性（标题、频道、分数、归因、当时的口令、用户说明），没有低分就不调用 LLM。"本周已自动调整了什么"由代码按未撤销调整的净变化汇总：频道偏好、因子权重、兴趣簇权重、新增理解纠正、撤销次数。

## 17. Takeout 导入（可选）

只在本机解析 `watch-history.json`：跳过广告条目与已删除视频，去掉"Watched / 观看了"等前缀。只保存按频道的观看次数（前 300 个频道）和最近 300 条，原始明细不保存。用途：(1) 排序的"个人品味"因子新增"看过该频道 N 个视频"（本扩展的观看记录与 Takeout 合并计数）；(2) 生成兴趣簇时附上常看频道的名称与次数（最多 50 个，只有名称）。不调用任何 API。

## 18. 权限变化

新增 `alarms` 权限；新增内容脚本，只匹配 `https://www.youtube.com/*`。仍然没有 `tabs`、`scripting` 或宽泛的 host 权限。

---

# Phase 3（2026-10-24）

## 19. 外部事实核实（X API）

- 接口：`GET https://api.x.com/2/tweets/search/recent`，支持 App-only Bearer Token。`max_results` 取 10–100，`start_time` 只能在最近 7 天内；按量付费账号的查询串上限 512 字符；支持 `-is:retweet`、`-is:reply`、`lang:` 等运算符。字段参数现名 `post.fields`。
- 计费（官方定价页）：帖子读取 $0.005/条、用户对象 $0.010/个，按"返回的资源条数"计；同一资源在同一 **UTC 日**内重复读取只计一次。Trends 是 $0.010/**次请求**（不是每条，Phase 1 已汇报）。按量付费账号每个计费周期最多读取 300 万条帖子。
- 余额不足或达到花费上限时的错误：官方文档没写明，第三方资料显示为 HTTP 402。代码按"余额不足或达到你在 X 后台设置的花费上限"给出人话提示。**未用真实账号验证**。

## 20. X 热点

- **来源：用兴趣簇关键词检索最近 24 小时的高互动帖子，不用 Trends。** 理由：Trends 是全站（或某地区）热门话题，与你的兴趣无关，也没有原文链接；而规格要求"与我兴趣相关、每条带原文链接"。代价：看不到与兴趣无关的大事件。替换：`core/hotspots.ts` 的 `chooseTopics` / `topicQuery`。
- 主题：按兴趣簇权重取前 `maxTopics`（默认 4）个；没有兴趣簇时用最近的找片主题。每个主题一条检索式（关键词取 OR，排除转发与回复，≤ 512 字符），每个主题读 `postsPerTopic`（默认 15）条。按互动（点赞、转发×2、引用、回复，对数压缩并按时间衰减）挑候选，交给 LLM 归纳成 5–8 条，每条必须引用至少一条真实读到的帖子（原文链接 `https://x.com/i/web/status/<id>`）并给出一句找片口令；引用不存在的条目一律丢弃。
- **不展开作者**（不用 `expansions=author_id`）：用户对象按 $0.010/个另计费，会让成本翻倍以上。原文链接不需要用户名。
- 缓存 6 小时。默认在你打开"发现"页、且缓存过期时自动刷新一次（可在设置里关）。**后台不会自动花 X 的钱**：没有任何定时任务调用 X。
- 一键找片：点"用这句找片"会切到"找片"页并直接发起搜索（这是你的一次明确点击，不是自动行为）。

## 21. X 预算护栏

- 本地账本按 **UTC 日**记账（与 X 的去重窗口一致，界面上注明本地重置时间），对同一 UTC 日内重复读到的帖子不重复计费，与 X 的计费规则一致。
- 每次请求前按"最坏情况：全部是新帖子"估算：剩余预算不够读 10 条（X 的最小值，$0.05）就**不发请求**，并提示"已停止调用"与还没查的主题；够读但不够读满时，自动缩小 `max_results`。
- X 返回余额不足或达到上限（402）后，当天不再尝试；界面提供"我已处理，重试"。
- 顶部常驻显示今日 X 花费，达到 80% 变成警示色；"发现"页同时显示文字提示。预算用完后"刷新热点"按钮不可点。
- 本地账本是估算，X 后台账单为准。README 建议同时在 X 后台设置花费上限作为双重保险。

## 22. 新博主发现

- 每周一次（与"每周自省"同一周期，在例行任务里自动运行；也可以手动"现在发现"），最多 5 个；**每周为此消耗的 search.list ≤ 8 次**，单独按周记账（同时计入当日 search 配额），用完明确拒绝，直到下周。
- 流程：学习类兴趣簇优先，每个兴趣一次 `search.list`（type=video，最近 30 天，关键词用 `|` 取或）→ 按频道聚合 → 排除已订阅、4 周内推荐过、你标过"不感兴趣"、你打过低分（频道偏好 < −0.15）的频道 → 粗排后取前 10 个读频道信息与最近上传（channels.list + playlistItems.list，约 12 units）→ 30 天内没有更新的不推荐 → 打分。
- 理由全部确定性生成（不经 LLM）：在哪个兴趣的检索里出现几次、最近 30 天更新了几个视频、订阅数、你是否给它打过高分、你是否看过但没订阅。附最近 3 个视频标题（点击在当前标签页打开）。
- 只有"打开频道"（当前标签页）和"不感兴趣"两个按钮，**没有订阅按钮**。

## 23. 其他

- X Bearer Token 与其他密钥一样只存本机、不进导出文件；脱敏规则与构建自检新增了 X Token 的格式。
- 网络出口白名单由 `endpoints.ts` 生成，新增 `https://api.x.com`；冒烟测试会校验白名单只包含 5 个官方 API 源。

## 24. Anthropic 工作区 ID（上线后修复）

- 起因：手测时 Anthropic 返回 400 *This API key is not scoped to a workspace…*。核对官方文档（`platform.claude.com/docs/en/manage-claude/authentication#select-a-workspace`）：个人 Key / 服务账号 Key 创建时可以不限定工作区，这类 Key 的**每个请求都必须带 `anthropic-workspace-id` 请求头**；限定到某个工作区的 Key 可以省略。SDK 不会自动带，需要调用方传。
- 做法：设置页新增可选的"Anthropic 工作区 ID"，格式校验 `wrkspc_` 开头；填了就通过 SDK 的 `defaultHeaders` 随每个 Anthropic 请求发送，只发往 `api.anthropic.com`，不进提示词，OpenAI 路径不发。
- 存放在 `secrets`（与 Key 同处）而不是 `settings`：它是账号标识，跟 Key 绑定使用；这样不进导出文件，"清空"时一并删除。它不是密钥，所以设置页照常显示已保存的值。
- 报错：识别官方的三种工作区错误（未带头 400、格式不对 400、工作区不存在或无权 404），分别给出人话原因和解法；404 不再被误报成"模型不存在"。其余 400 改为显示服务方返回的原因文本（不再截断成 JSON 片段），提示语不再默认指向模型名。
- 放弃的方案：自动调用 List Workspaces 帮用户选工作区——那是组织管理接口（Admin API），会让扩展碰到组织级数据、扩大访问面，超出规格。

## 25. YouTube 授权改版：launchWebAuthFlow + "Web 应用"客户端（取代 §3）

- **起因**：用户日常使用 Comet（Chromium 内核，非 Google Chrome）。`getAuthToken` 依赖浏览器级 Google 登录（Chrome 的"允许登录 Chrome"/ 账号体系），Comet 没有对应设置，这条路走不通。用户指定改为 `launchWebAuthFlow` + "Web 应用"类型客户端、回跳 URL 中直接取 `access_token`（隐式授权）。
- **外部事实核实**（2026-10-24）：
  - Google 文档仍提供隐式授权（`response_type=token`），但标注"仅为兼容旧系统与排障保留，因安全隐患强烈不推荐"，推荐授权码 + PKCE；没有给出停用日期。
  - 那些安全隐患针对网页单页应用（令牌出现在地址栏、浏览历史、Referer，以及回跳页被注入脚本）。扩展里的回跳地址 `https://<扩展ID>.chromiumapp.org/` 由浏览器直接截获、从不作为网页加载，这几类风险基本不适用。剩下的 CSRF 用随机 `state` 校验防住：不匹配就整个丢弃，连回跳里的错误信息也不采信。
  - 隐式授权没有刷新令牌，访问令牌约 1 小时有效（`expires_in`）；支持 `prompt=none` 静默获取。
  - 没有找到 Comet 对 `chrome.identity` 的任何说明，需要用户实测。
- **做法**：
  - 授权地址只带 `client_id / redirect_uri / response_type=token / scope=youtube.readonly / state / prompt`。不带 `include_granted_scopes`，避免顺带拿到以前授过的其他范围。回跳后校验 `state`，并确认范围里包含 `youtube.readonly`。
  - 交互授权用 `prompt=select_account`：浏览器里登录了多个 Google 账号时，让用户挑测试账号。
  - 令牌和过期时间存在 `chrome.storage.local`（`youtubeAuth`），不进导出，"清空"时一并删除。令牌提前 2 分钟视为过期。
  - **过期处理（不静默失败）**：
    1. 后台或页面需要令牌时，先用 `prompt=none` 做一次静默续期，不弹窗，最多等 10 秒。这需要浏览器里网页版 Google 账号仍在登录。
    2. 静默续期失败：明确报"授权已过期，自动续期没有成功"，状态变为 `expired`，侧边栏顶部出现"重新授权"按钮，设置页也会显示。
    3. 失败后 15 分钟内不再静默重试，避免反复开隐藏窗口。
    4. 后台任务（补元数据、提醒里的推荐视频、新博主）在 `expired` 状态下仍会尝试；失败会记入"记录"页的失败原因，不会跳过而不说。
  - **规格之外的补充**：用户原话是"过期后重新弹窗授权"，我加了一层 `prompt=none` 静默续期。原因是每小时弹一次窗不现实，而且 23:00 的总结等后台任务无法弹窗。静默失败时仍按用户要求，请用户重新弹窗授权。
  - 断开：令牌仍有效时向 `oauth2.googleapis.com/revoke` 吊销（令牌放在请求体里），然后删除本地记录。令牌已过期时不发请求，界面如实说明没有吊销，并给出去 Google 账号「第三方应用和服务」里移除的路径。
  - Client ID 仍由 `local/config.json` 在构建时注入，改为 esbuild `define` 注入代码，不再写 manifest `oauth2`，因为那一项只给 `getAuthToken` 用。授权页地址 `accounts.google.com` 由浏览器授权窗口打开、扩展不对它 fetch，所以不进 CSP / `host_permissions`。
  - 删除了只适用于 Chrome 的报错指引（"允许登录 Chrome"、"Chrome 没有登录"），改为按 Google 授权窗口里的实际错误分别指引：403 access_denied → 测试用户；redirect_uri_mismatch → 回跳地址；invalid_client → 客户端类型或 ID。设置页和 `npm run setup` / `npm run build` 都会显示回跳地址。
- **测试**：
  - 纯逻辑（拼地址、解析回跳、有效期）与授权服务（弹窗、复用、静默续期、并发只续一次、续期失败冷却、401 作废、断开吊销）全部用注入的假 `launchWebAuthFlow` 做单测。
  - e2e 不再替换授权模块，而是真实调用 `launchWebAuthFlow`：mock 授权页 302 回跳到 chromiumapp.org，测试断言授权请求只申请 `youtube.readonly`、带随机 `state`，拿到的令牌只发往 YouTube。
- **放弃**：
  - 授权码 + PKCE。Google 的"Web 应用"客户端换令牌必须带 client secret，要么把 secret 放进扩展，要么让用户填。而且要自己管理刷新令牌，测试状态下刷新令牌 7 天就过期，相比隐式授权得不偿失。
  - 继续用 `getAuthToken`：Comet 上不可用。
- **以后怎么换**：若 Google 停用隐式授权，在 `services/auth.ts` 的 `webAuthFlowAuth` 里把 `runFlow` 换成授权码流程即可，`AuthProvider` 接口与调用方不用动。


## 26. 发给大模型的文本：不劈开 emoji（上线后修复）

- 起因：手测"生成兴趣簇"时 Anthropic 返回 400 *The request body is not valid JSON: unexpected end of hex escape*。原因是频道简介按 120 字、视频标题按 100 字用 `.slice()` 截断，截断点正好落在 emoji（两个 UTF-16 单元）中间，留下半个代理对；`JSON.stringify` 把它写成孤立的 `\udXXX` 转义，服务端的 JSON 解析器拒收整个请求。
- 做法两层：(1) `core/text.ts` 新增 `clip()`，截断时若最后一个单元是高位代理就连它一起去掉；`truncate()` 和各处对外部文本（YouTube 简介/标题、X 帖子、LLM 输出字段、用户备注）的截断都改用它。(2) 兜底：`services/llm.ts` 发送前对 system / user 统一做 `wellFormed()`，把任何残留的孤立代理项换成 U+FFFD——以前版本存进本地的数据（例如已截断过的简介）也不会再触发。
- 测试：单测里的假 Anthropic / OpenAI 按服务端规则拒收含孤立代理项转义的请求体；新增复现用例（简介在第 120 个字符处切到 emoji），确认修复前失败、修复后通过。

## 27. 新博主与 X 热点：并发运行时的预算护栏（上线后修复）

- 起因：手测时"本周新博主"显示"已用 search 16/8 次"，超过了每周 ≤ 8 次的验收要求。原因是后台例行任务与手动"现在发现"同时运行：两边都在开始时读到"还剩 8 次"，结束时才记账。X 热点有同样的隐患（打开"发现"页的自动刷新与手动刷新同时进行时，两边都可能通过预算检查），会让当天 X 花费略超预算。
- 做法：(1) 两者各加一把跨页面的 Web Lock（`run:discovery` / `run:hotspots`，与存储层按键名加的锁区分开，避免重入死锁），同一时间只跑一次；排队的一方若发现另一方在它发起之后刚跑完，直接返回那份结果，不再花 search 或 X 的钱。(2) 发现新博主改为每次 `search.list` 调用前就把本周用量记进账本，而不是整轮结束才记——中途失败或后台被休眠也不会漏记。
- 测试：并发复现用例（两路同时运行 → search 只花 4 次、X 只读一次、花费不翻倍），在修复前的代码上失败、修复后通过；另有"中途失败仍按实际调用记账"的用例。
- 已经超出的本周用量（16 次）不回退，下周自动重置。

## 28. 豆瓣评论 RSS 阅读器（2026-10-31，规格外新增）

- 起因：用户要求在侧边栏读豆瓣条目的评论 RSS（示例 `https://www.douban.com/feed/subject/35299923/reviews`），图文并茂、易读。
- **红线变更（用户 2026-10-31 确认）**：CLAUDE.md §2 的网络出口原本只有 Google/YouTube、LLM、X。新增两项：`https://www.douban.com`（进 `connect-src` 与 `host_permissions`，只读 `/feed/subject/<ID>/reviews`）、`https://img1–9.doubanio.com`（只进 CSP `img-src`，用于条目海报）。两者都在 `src/config/endpoints.ts`，构建脚本生成 manifest；正式版冒烟测试逐项核对白名单。CLAUDE.md §2 的网络出口红线已按用户要求同步（同日）。
- **外部事实（2026-10-31 实测）**：RSS 免登录可读（HTTP 200，`text/xml; charset=utf-8`），约 8 篇最新评论，不按时间排序；`description` 是"作者评论: 条目 (链接) / 评价: … / Draft.js JSON"，JSON 被豆瓣在服务端截断（常断在 `\uXXXX` 转义或半个代理对中间，末尾加 `...`），实际只剩几个字；"评价"常为空。海报在 `img3.doubanio.com`：干净浏览器直接打开返回 **418**，带外站 Referer 返回 403——即防盗链。
- **解析：手写的 RSS 2.0 取值器（`core/douban.ts`），不用 DOMParser、不加依赖。** 只取 title/link/description/content:encoded/dc:creator/pubDate/guid 这些不会同名嵌套的元素；CDATA 原样、其余解码实体。截断的 Draft.js 逐个提取 `"text"` 字段，自己解 JSON 转义、遇到不完整的转义就停、去掉末尾半个 emoji。纯函数，Node 里直接单测。放弃 DOMParser：服务层单测跑在 Node，要额外引入 jsdom（XML 支持完整的那个依赖多）；放弃 fast-xml-parser：多一个运行时依赖只为 7 个字段。替换：格式变复杂时把 `parseDoubanFeed` 的内部换成 DOMParser（侧边栏可用），单测加 `// @vitest-environment jsdom`。
- **安全**：订阅源里的 HTML 一律不渲染，只从 `content:encoded` 取海报地址与作者主页；链接只接受 https 的 `*.douban.com`，海报只接受 `DOUBAN_IMAGE_ORIGINS`，其余丢弃（夹具里有 `javascript:` 链接和外站图片做反例）。
- **请求形态**：`credentials: 'omit'`（不带豆瓣 Cookie，不暴露账号）、`referrerPolicy: 'no-referrer'`、`redirect: 'manual'`（被转去验证/登录页时明确报"被转走了"，而不是被 CSP 拦成"网络错误"）；失败不自动重试。HTTP 404 / 403 / 418 / 429 / 3xx / 返回网页 都有各自的人话提示，且保留上一次读到的内容。
- **海报：照常加载，不绕防盗链。** `<img referrerpolicy="no-referrer">`；被拒时换成本地生成的封面（色相取自条目名），并在海报下写明原因。放弃用 declarativeNetRequest 伪造 Referer：那是冒充豆瓣页面绕过对方的限制，也违背"不静默绕行"。
- **缓存与自动行为**：每个条目缓存 30 分钟（可调）；只在打开"豆瓣"页且当前条目缓存过期时自动读一次（可关），每次打开侧边栏每个条目最多自动读一次；后台 service worker 从不读取。同一条目一把 Web Lock（`run:douban:<ID>`），自动与手动刷新撞车时只请求一次。
- **存储**：`douban` 键（订阅列表、每个条目最近一次的解析结果、上次选中的条目），随导出全部数据一起导出、随清空一起删除。首次使用预置示例条目（可取消订阅）；最多 20 个条目。
- **界面**：侧边栏新增"豆瓣"标签（找片 / 发现 / 豆瓣 / 记录 / 画像 / 改进记录）。条目以小胶囊切换；顶部是海报（或生成的封面）+ 条目名 + 篇数 + 刷新 / 在豆瓣打开 / 取消订阅；评论卡：首字头像（色相取自用户名）、作者、发布时间（用户 2026-10-31 要求：RSS 的 `pubDate` 换算到本地时区，直接显示 `YYYY/MM/DD HH:mm`，不用"几周前"、不加悬浮提示；格式化用 `core/time.ts` 的 `formatDateTime`，固定 24 小时制，不依赖浏览器语言设置）、星级（力荐…很差 → 5…1 星）、标题、正文开头（引用块，截断处加"…"）、"读全文 ↗"。豆瓣链接在**新标签页**打开（不同于找片结果的"当前标签页"：读评论时不该把正在看的 YouTube 换掉）。
- **测试**：`tests/fixtures/douban-reviews.xml` 结构照抄真实订阅源，用户名与正文为虚构，覆盖上面每个边界；单测 40 条（解析 + 服务层：请求形态、缓存、并发、7 种失败、订阅管理、导出）。e2e 用 mock 提供 RSS，海报请求由 Playwright 在本地应答 418，验证回退封面与说明、请求不带 Cookie/Referer、Key/Token 不发往豆瓣。
