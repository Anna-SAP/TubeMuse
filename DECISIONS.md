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
- 主题：按兴趣簇权重取前 `maxTopics`（默认 4）个；没有兴趣簇时用最近的找片主题。每个主题一条检索式（关键词取 OR，排除转发与回复，≤ 512 字符），每个主题读 `postsPerTopic`（默认 15 条，2026-11-06 起 10 条，见 §48）。按互动（点赞、转发×2、引用、回复，对数压缩并按时间衰减）挑候选，交给 LLM 归纳成 5–8 条，每条必须引用至少一条真实读到的帖子（原文链接 `https://x.com/i/web/status/<id>`）并给出一句找片口令；引用不存在的条目一律丢弃。
- **不展开作者**（不用 `expansions=author_id`）：用户对象按 $0.010/个另计费，会让成本翻倍以上。原文链接不需要用户名。
- 缓存 6 小时。~~默认在你打开"发现"页、且缓存过期时自动刷新一次~~（2026-11-06 起默认关闭，见 §48）。**后台不会自动花 X 的钱**：没有任何定时任务调用 X。
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

> **续期做法已被 §53 取代**（2026-11-07）：隐式授权没有刷新令牌，`prompt=none` 静默续期在 Comet 上一直被 Google 以 `interaction_required` 拒绝，改为授权码 + PKCE + 刷新令牌。`launchWebAuthFlow`、"Web 应用"客户端、只申请 `youtube.readonly`、后台发起交互授权（§34）不变。

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

## 29. 豆瓣页跟随当前标签页（2026-10-31，上线后修复）

- 起因：用户在主页面打开了另一个条目（《生日快乐》）的评论 RSS，侧边栏仍停在《白衣逆行者》。
- 根因：豆瓣页只是"订阅列表 + 上次选中的条目"，从来没有监听标签页（代码里没有任何 `chrome.tabs.onActivated / onUpdated`），也不读当前网址。30 分钟缓存按条目 ID 分开存，与此无关——换了条目就不会命中旧条目的缓存。
- 做法：豆瓣页挂载时读取本窗口激活标签页的网址，并监听 `tabs.onActivated`（切标签）与 `tabs.onUpdated`（同一标签页换地址，含 history.pushState）；网址是豆瓣条目或评论 RSS 时切到该条目（`core/douban.ts` 的 `subjectFromTabUrl`）。没订阅的条目以虚线"当前页 · 条目名"显示，提供"订阅这个条目"，**不自动订阅**。同一地址的重复事件（加载完成、标题变化、刷新）不再切换，免得覆盖你刚点选的条目；离开豆瓣再回来会重新跟随；标签页离开豆瓣时保持当前显示。设置页可关（`douban.followActiveTab`，默认开）。
- **不加权限**：MV3 下标签页的 `url` 只对有 `tabs` 权限或有该网址主机权限的扩展可见。扩展已有 `https://www.douban.com/*` 主机权限（读 RSS 用），所以不需要 `tabs` 权限，也看不到其他网站的网址；冒烟测试里"权限最小化"一项照旧通过。代价：`movie.douban.com` 等子域名上的条目页看不到网址，不会跟随。放弃 `tabs` 权限（能看到所有标签页的网址，隐私面太大）与加子域名主机权限（扩大网络出口，属红线变更，需用户确认）。
- 缓存：跟随时看过、但没订阅的条目也会缓存，来回切换不重复请求豆瓣；只保留最近 5 份（`DOUBAN.transientFeedsKept`），订阅的条目全部保留。订阅一个已缓存的条目时直接带上条目名（e2e 发现：之前会显示成"条目 <ID>"）。
- 测试：单测覆盖网址识别（含 e2e 的 mock 地址）、缓存清理、订阅时带条目名；e2e 用 `chrome.tabs.create / update / reload` 驱动真实标签页：打开 RSS → 自动切换并读取；同一标签页换地址 → 随之切换、走缓存；刷新不覆盖手动点选；离开豆瓣保持显示、回来重新跟随；点"订阅这个条目"加入列表。

## 30. 自动字幕：无原生字幕视频的双语字幕（2026-11-01，规格外新增）

- 起因：用户要求为没有原生字幕（播放器显示 "Subtitles/closed captions unavailable"）的 YouTube 视频自动生成字幕并显示双语：ASR、BYOK 大模型翻译、注入播放器、时间轴对齐。
- **红线变更（用户 2026-11-01 确认，CLAUDE.md §1、§2 同步）**：原红线是"注入脚本只读播放器状态做观看追踪""不改动 YouTube 页面""不提供下载"。开工前停下汇报，用户在四个方案里选了"采音频 + 播放器内显示"：新增一个独立内容脚本，只在播放时经 `captureStream()` 采集当前视频的音频、读取字幕按钮状态、在播放器内叠加一层只读字幕；脚本自身不发网络请求。观看追踪脚本与它的构建检查不变。
- **外部事实（2026-11-01 核实）**
  - `chrome.tabCapture.getMediaStreamId` 必须在用户"调用扩展"之后（点工具栏图标、快捷键、右键菜单、omnibox），官方列表不含侧边栏里的点击；采集期间该标签页对用户静音，需要自己再播放一遍（[tabCapture](https://developer.chrome.com/docs/extensions/reference/api/tabCapture)、[screen capture](https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture)）。
  - 真实 YouTube（Chrome 152 内核的内置浏览器）实测：`#movie_player video` 是 MSE（`blob:` 地址），`captureStream()` 拿到 live 的音轨，不影响播放、不静音；`new AudioContext({ sampleRate: 16000 })` + `ScriptProcessorNode` 3 秒取到 45056 个样本、RMS 0.10；播放器音量调到 0 时采到的音频不变。用 TubeMuse 的切段参数跑这段访谈的 26 秒真实音频：切成 6 段，2.3–6.3 秒，没有强制切断。
  - 字幕按钮：无字幕时 `data-tooltip-title` 与 `data-title-no-tooltip` 相同（都是 "Subtitles/closed captions unavailable"）；有字幕时提示带快捷键后缀（"Subtitles/closed captions (c)"）；`aria-label` 在有字幕的视频上也可能残留 "unavailable"，不能用；广告期间按钮反映的是广告。
  - OpenAI：文件转写推荐 `gpt-transcribe`（$0.0045/分钟），返回 `text` 与 `languages: [{ code }]`，支持 `prompt`；实时转写 `gpt-live-transcribe`（$0.017/分钟）只文档化了服务端标准 Key 或服务端签发的临时密钥两种鉴权；`whisper-1`、`gpt-4o(-mini)-transcribe` 2027-02-26 下线。Anthropic 没有语音输入。
  - Web Speech API 的 `start(audioTrack)`（识别任意音轨）有 Intent to Ship，但没能确认已在稳定版上线；Comet 等非 Chrome 浏览器的云端识别通常不可用。
  - OpenAI SDK 6.x 上传文件前会 `fetch('data:,')` 探测 FormData 支持，会被扩展 CSP 拦下并报错；给 fetch 带上 `Response` 属性即可跳过探测。
- **音频来源：内容脚本 `video.captureStream()`。** 不需要新权限、不静音、不需要每个标签页点一次图标、自动开启也能用。放弃 `tabCapture` + offscreen 文档（要用户在每个标签页点工具栏图标，而本扩展点图标是开侧边栏；还会静音标签页）；放弃直接下载音轨（违反"不提供下载 / 不抓取"，且 YouTube 的分发方式让它很不稳）。代价：只能边播边听，第一次观看时字幕比说话晚几秒——用户在问题描述里已接受。
- **采样：16 kHz 的 AudioContext + `ScriptProcessorNode`。** 浏览器负责重采样；不需要加载任何模块文件。放弃 AudioWorklet：要从 YouTube 页面加载扩展里的脚本（得开 `web_accessible_resources`，网页就能探测到扩展），或用 blob 模块（受页面 CSP 影响，不可控）。放弃 `MediaStreamTrackProcessor`：规范已把它移到 Worker，窗口里的版本前途不明。替换：`src/content/subtitles.ts` 的 `startCapture` 一处。
- **切句（`core/subtitles.ts` 的 `Segmenter`，纯函数）：** 30 ms 帧能量 + 自适应底噪判有无人声；停顿 ≥ 0.45 秒交出一句；短于 1.5 秒的等下一句合并（停顿超过 1 秒则直接交出）；一直不停顿时到 7 秒在后 60% 最安静的一帧切开；人声 < 0.3 秒的片段丢弃。每帧按"块末的视频时间 − 剩余样本时长 × 倍速"换算成视频时间，所以倍速播放、后台节流都不影响对齐；进度跳变 > 1.2 秒视为拖动，先交出已有的部分。暂停、广告、拖动中、换视频时 flush，不采集。放弃按固定 5 秒切：会把字切成两半，识别和翻译都变差。
- **转写：OpenAI `gpt-transcribe`，一段一个 WAV（16-bit PCM）上传，由后台 service worker 发出。** 内容脚本经 `chrome.runtime.Port` 送 base64 的 WAV；后台校验（视频 ID 格式、本扩展编码的 16 kHz 单声道 WAV、≤ 8 秒）后再调用。`prompt` 带前 3 句转写文字（≤ 200 字）提高连贯性。不发视频 ID。放弃 `gpt-live-transcribe`：贵约 4 倍，浏览器里的鉴权没有文档（用户在问题里选了分段方案）。替换：`services/llm.ts` 的 `createTranscriber`（仍是唯一接触 SDK 的文件）。
- **翻译：复用 BYOK 大模型，单独可设"字幕翻译模型"。** 每句一次 `generateJsonWithUsage`（`effort: 'low'`），只发这一句 + 前 3 句原文 + 目标语言名；翻译失败只写 `translationError`，原文照常显示。**默认用 `claude-haiku-5-5`（提供商是 OpenAI 时用 `gpt-6-luna`），用户 2026-11-01 确认**：每句都要调用一次，跟随主模型 `claude-opus-5-5` 时一小时约 $3、$1 的预算二十来分钟就用完，字幕也出得更慢；Haiku 一小时约 $0.08。字段清空 = 跟随"1. 大模型"的主模型；设置页并排显示一小时估算花费，换成别的模型后有一键"改回默认"。双语组合按用户选择：原文是中文 → 英文，其他 → 简体中文（`translationTarget`，先用转写返回的语言，缺失时按文字推断）。
- **显示：`#movie_player` 里加一个带 Shadow DOM 的元素，只用 `textContent` 写字。** `pointer-events: none`，不遮挡点击；字号按播放器高度缩放（全屏自动变大）；控制栏出现时上移。显示规则（`pickCue`）：先按时间轴找覆盖当前时刻的句子（回看精确对齐）；找不到时显示刚送到的那句至少 2.5 秒（第一次观看）；晚到超过 20 秒的不再即时显示。播放器左上角的小字只用来说状态和错误（人话，不静默）。放弃原生 `<track>`：样式不可控，双语两种颜色做不到。放弃只在侧边栏显示：要转头看。
- **原生字幕判定（`nativeCaptionsState`）：** 用上面的结构性规则（提示文字是否等于按钮名、是否带快捷键后缀、`aria-pressed`），与界面语言无关；判断不出就是 `unknown`，不自动开启。广告期间不判断。
- **回看不花钱：** 字幕按视频时间存本机：每个视频一个键 `subtitles:<视频ID>`，加一个小索引 `subtitleIndex`（视频 → 最近更新时间），超过 100 个视频删最久没更新的。没有把所有视频放进一个键：每句字幕要写两次（原文、译文），单键会随视频增多每几秒重写几 MB；新片段与已有字幕重叠过半就不上传（内容脚本与后台各查一次，两个标签页放同一个视频也不重复）；只有音乐/杂音的片段记成空字幕，回看时同样跳过。
- **成本可见与护栏：** `subtitleLedger` 按本地日记账（转写按服务方报告的秒数 × 单价，翻译按返回的 token × 单价）；单价表在 `config/defaults.ts`（2026-11 官方定价），不在表里的模型按最贵一档保守估算并在界面注明。每段先按最坏情况（转写 + 一次翻译的保守 token 数）预留，剩余不够就不发请求，内容脚本停下并说明，改设置或 5 分钟后再试（重试本身不花钱）。在途请求的预留只在后台这一个 service worker 里计数，多个标签页同时出字幕也守得住。侧边栏顶部新增 `字幕 $` 条。默认每日 $1。
- **开关：** 设置页总开关与"无字幕时自动开启"；侧边栏"字幕"页对当前视频开 / 关；快捷键 `Alt+Shift+S`（`commands`，不需要权限）。手动选择只在这个标签页里记住。
- **权限：没有新增。** 不用 `tabCapture`、`offscreen`、`downloads`、`web_accessible_resources`；冒烟测试逐项核对。侧边栏和后台跟字幕脚本只用 `tabs.sendMessage` / `runtime` 消息通信（不需要 `tabs` 权限）。
- **构建检查：** 字幕脚本产物里不得出现 `fetch(`、`XMLHttpRequest`、`WebSocket`、`sendBeacon`、`EventSource`、`innerHTML =`、`outerHTML =`、`insertAdjacentHTML`、`document.cookie`、`.download =`；观看追踪脚本的检查不变。
- **测试：** 单测 40 条（切段：停顿、合并、长句切分、倍速、拖动、flush；WAV 往返与拒收；按钮判定；双语组合；显示时机；回看去重；记账与保守估价；后台流程：请求形态、Key 只在请求头、不发视频 ID、缺 Key、预算、并发预留、翻译失败、空转写、会话消息与致命错误）。e2e 在 mock 播放页上用"说话"音频跑完整流程：自动开启 → 采音频 → mock 转写 → mock 翻译 → 播放器里出现双语字幕；YouTube 自己的元素逐字不变；转写请求的 Origin 是扩展（不是内容脚本发的）；拖回去按时间轴对齐且不再请求；侧边栏开关；有原生字幕不开启；超预算一个请求都不发并在播放器里说明。
- **没做 / 留给以后：** 实时流式转写（延迟更低，等浏览器里的鉴权有文档后再评估）；本地 Whisper（音频不出本机，但要内置几百 MB 模型）；导出 SRT（规格外，没做）；Shorts 不出字幕。

## 31. 自动字幕一直提示"OpenAI 请求过于频繁或额度不足"（2026-11-01，上线后修复）

- 现象：用户实测时，播放器左上角反复出现"TubeMuse 字幕：OpenAI 请求过于频繁或额度不足"，一直不出字幕。
- **外部事实（2026-11-01 核实，[error-codes](https://developers.openai.com/api/docs/guides/error-codes)、[rate-limits](https://developers.openai.com/api/docs/guides/rate-limits)、[gpt-transcribe](https://developers.openai.com/api/docs/models/gpt-transcribe)）**：OpenAI 的 HTTP 429 有两类，只能靠 `error.code` 区分。① 额度 / 账单：`credit_balance_exhausted`（预付额度为 0）、`organization_spend_limit_exceeded`、`project_spend_limit_exceeded`、`organization_usage_limit_exceeded`（`error.type` 可能仍是 `insufficient_quota`），官方原话"重试不会恢复访问"。② 限流："Rate limit reached for requests"、`slow_down`（请求量上升太快，在每分钟上限以内也会出现），要按 `Retry-After` 等待；**被拒的请求也计入每分钟上限**，连续重发会一直被拒。`gpt-transcribe` 最低的付费档每分钟 5,000 次请求，字幕每分钟只发 12–20 次。
- **根因**：两层。(1) 直接原因在 OpenAI 账户一侧：按上面的请求量，持续不断的 429 几乎只可能是额度 / 账单类（最常见的是 API 没有预付额度——它和 ChatGPT 会员分开计费），或这把 Key 同时被别的程序大量使用。(2) 扩展自身的缺陷让问题看不清也停不下：`mapLlmError` 把所有 429 合成一句"请求过于频繁或额度不足"，不读 `error.code`，你无从判断该充值还是该等；字幕会话把它当成"可恢复"的错误，下一句照发——额度问题时每句都被拒，限流时被拒的请求又不断占用每分钟名额，提示永远不消失。
- **修复**
  - `services/llm.ts`：429 按 `error.code` / `error.type` 分成 `llm_quota`（逐个 code 给出原因与 platform.openai.com 上的处理位置）与 `llm_rate`（附服务方原话）；`retryAfterMs()` 读 `retry-after-ms` → `Retry-After`（秒或 HTTP 日期）→ 已用尽那一项的 `x-ratelimit-reset-*`（"1s"、"6m0s"、"20ms"），限制在 1 秒–10 分钟。所有功能（找片、总结、热点、翻译、测试连接）都受益；Anthropic 的 429 只可能是限流（它的余额不足是 400），不会误判成账单问题。
  - 字幕：`llm_quota` 算"致命"错误——停下，播放器与侧边栏写明原因和去哪里处理；充值后点"为这个视频生成字幕"立即重试（否则 5 分钟后自动再试一次，仍被拒也只多一个请求）。`llm_rate` 时后台对所有标签页统一暂停（服务方给了时间就照办，否则 5 秒起翻倍、最多 60 秒），暂停期间一个请求都不发；内容脚本同时停止送片段，播放器显示原因与实时倒计时，到点自动继续，提示随之消失。成功一次后退避清零。
  - 每日总结的补算遇到 `llm_quota` / `llm_rate` 同样停止本轮（以前 429 归在 `llm` 里，行为不变）。
- **测试**：单测 +12（5 种账单 code 各自的文字与"致命"标记、Key 不进提示；`slow_down` + `Retry-After` 暂停期间零请求、到点恢复；`x-ratelimit-reset-requests` 与指数退避序列 5/10/20/40/60/60 秒；各种等待时间格式与上下限；OpenAI 找片遇额度用完、Anthropic 429 判为限流）。e2e +7：mock 转写返回 `credit_balance_exhausted` 时只发 1 个请求就停并说清原因；返回 `slow_down` + `Retry-After: 3` 时显示倒计时、暂停期间零请求、到点后自动继续出字幕。
- 无法在这里替你确认的：你的账户具体是哪一种。新版本会在播放器里直接显示 OpenAI 返回的 `error.code`，看一眼就知道。

## 32. 自动字幕：浏览器自带的语音识别（2026-11-01，默认转写方式）

- 起因：用户的 OpenAI API 没有可用额度，希望用 Claude 额度。Claude API 只接受文字和图片，不能转写；翻译本来就用 Claude（`claude-haiku-5-5`）。给出三条路后，用户选"试试浏览器识别"，实测可用后要求做成默认。
- **外部事实（2026-11-01 核实）**：`SpeechRecognition.start(audioTrack)` 自 [Chrome 135](https://developer.chrome.com/release-notes/135) 起可识别任意音轨。用户的 Chrome 156 实测：传入非音轨参数同步抛 TypeError（据此判断支持，且不会误启动麦克风）；把 `3wP2VCoz3KM` 的音轨交给它，`zh-TW` 云端识别，约 1 秒出第一个字，连续说话时 25 秒只给了一个 final（置信度 0.89，无标点）；`SpeechRecognition.available({langs, processLocally: true})` 对 zh-TW / zh-CN / en-US 返回 `downloadable`。Claude 桌面应用内置的浏览器（Chromium 152）支持音轨参数，但云端识别报 `network`（非 Chrome 构建没有 Google 语音服务）——Comet 等同理。
- **红线变更（用户 2026-11-01 选择本方案时已知"声音交给 Chrome 的云端识别（Google）"；CLAUDE.md §2 同步）**：转写方式由用户选择，默认浏览器识别；装了本地语音包时在本机识别，否则由 Chrome 自己连接 Google（不是扩展的网络出口，CSP 白名单不变）；去向在设置页、侧边栏、播放器"正在听…"里写明。
- **做法**
  - 内容脚本把 `captureStream()` 的音轨直接交给 `SpeechRecognition`（`continuous` + `interimResults`），不再经过 AudioContext。识别器入口单独放在 `content/speech-engine.ts`，e2e 构建换成按脚本出字的假识别器（`speech-engine.e2e.ts`），正式构建自检不得含它。
  - **断行（`LiveTranscript`，纯函数）**：浏览器的结果边听边改、没有时间戳、连续说话时迟迟不给 final。记下每个字第一次出现时的视频时间（减 0.7 秒识别延迟，按倍速换算）；文字 1.2 秒不再变化算定稿，满 16 个汉字 / 42 个字符交出一行（中文优先断在语气词后，英文断在空格）；停顿 1.6 秒不满一行也交出；final 时交出剩余（超过 24 字再切）。屏幕上一行是"最近定稿的那行 + 还在识别的新字"（只留最后 30 字），下一行是那行的译文（`liveView`）。
  - 定稿的行以 `{type:'text'}` 送给后台：校验、存成字幕（`asrModel: 'browser-speech'`）、按原有流程用 Claude 翻译；不需要 OpenAI Key，不记转写费，只记翻译费。回看时已有字幕的时段不再存、不再翻译。
  - **识别语言**：浏览器识别不能自动判断语言。设置默认"自动"：先看缓存的视频元数据，没有就用官方 `videos.list` 查一次（1 unit，单独的 1-unit 预算，记进配额，结果与观看记录共用 `videoMeta` 缓存；`VideoMeta` 新增 `language` = `defaultAudioLanguage` ?? `defaultLanguage`）；中文一律按 `zh-CN` 识别（出简体字），粤语用 `yue-Hant-HK`；没有语言信息时按标题文字推断，再不行用简体中文并在侧边栏说明原因。侧边栏可以给单个视频换语言，立即生效（中止当前识别、按新语言重启）。
  - **本地 / 云端**：设置"装了本地语音包时在本机识别"（默认开）；设置页显示所选语言的本地语音包状态，没装时有下载按钮（只在用户点击时由浏览器下载）。本地识别是实验特性、对音轨是否支持未验证：本地模式出任何错误都改用云端，并在播放器里说明"声音发往 Google"。
  - **会话管理**：暂停 / 广告时 `stop()`（让识别器说完再结束），拖动或换语言时 `abort()` 并丢掉未定稿的字（声音属于之前的位置）；会话正常结束立即续上，3 秒内就结束的按 1→2→…→15 秒退避重启；`network`（云端）/ `not-allowed` / `language-not-supported` / `audio-capture` 是致命错误，停下并说明（连不上时提示只有 Google Chrome 能用、可改用 OpenAI）；`no-speech` / `aborted` 不提示。
  - 修了一个启动竞态：内容脚本读到保存的设置之前不开始采集（否则会按默认转写方式开始，e2e 发现）。
- **放弃**：把 Claude 用于转写（不支持音频）；同时开两个识别会话交替定稿（Chrome 每页一个会话，互相打断）；定时 `stop()` 强制定稿（重启间隙会丢字）；读页面标题判断语言（违反"注入脚本不读页面内容"，改用官方 API）。
- **未验证 / 风险**：Google 给浏览器语音输入的免费服务被连续使用几个小时会不会被限制；本地语音包能否识别音轨；识别准确率与断行长度是否合适——都列进了 README 打卡清单。
- **测试**：单测 +22（断行：连续说话、final 再切、停顿交出、识别器改字、英文断词与倍速、flush/reset；屏幕两行；语言选择与元数据；错误映射；后台：只收文字、不需要 OpenAI Key、回看去重、拒收格式不对、hello 带语言、自动查语言 1 unit 并缓存、没连接 YouTube 时不查）。e2e +13：默认浏览器识别边听边出字、不发音频、Claude 翻译、侧边栏写明去向与默认语言、存下的行、换语言、花费只有翻译、连不上语音服务时停下并说明；之后切到 OpenAI 转写，原有的 OpenAI 场景全部照跑。

## 33. 字幕默认关闭，只在手动开启时生成（2026-11-01，用户要求）

- 改了什么：设置"播放器显示'字幕不可用'时自动开始"默认关闭。字幕只在你从侧边栏"字幕"页点"为这个视频生成字幕"或按 `Alt+Shift+S` 时开启，只对当前视频生效（记在这个标签页里），换视频后回到关闭。总开关"启用自动字幕"保持开，否则手动也开不了。
- **旧设置怎么处理**：之前的键 `autoStart` 默认是开，已经保存过设置的安装里存着 `true`，单纯改默认值对它们不起作用。换成新键 `autoStartNoCaptions`（默认 false），`mergeSettings` 丢弃旧键——所有人（包括已经装过的）都从"关"开始，需要的话在设置页重新勾选。放弃"保留旧值"：无法区分"你主动打开的"与"当时的默认值被一并保存"，而这次的要求正是默认关闭。
- 侧边栏在未开启时写明"未开启（字幕默认关闭）：点'为这个视频生成字幕'或按 Alt+Shift+S"。
- 测试：单测 +3（新装默认关、旧 `autoStart: true` 不再生效且被去掉、勾选后照做）；e2e +3（没有原生字幕的视频播放 3 秒不出字幕、不识别、不翻译；侧边栏说明怎么开启；默认值）。之后在设置页勾选自动开始，原有依赖自动开始的场景照跑，验证这个可选项仍然好用。

## 34. 点了"重新授权"并登录，仍显示"已过期"（2026-11-01，上线后修复）

- **现象**：在 Comet 里点侧边栏的"重新授权"、在窗口里登录后，横幅仍是"YouTube 授权已过期，自动续期没有成功"，也没有任何报错。
- **证据**（用户本机 Comet 的扩展存储，只读，未读取令牌本身）：
  - 存着的访问令牌是 2026-10-24 08:13 首次连接时拿到的那一个，09:13 就过期了。
  - 之后 8 天，"重新授权"一次也没写进过新令牌。
  - 后台每 30 分钟尝试一次静默续期，次次失败。记下的原因只有笼统的"自动续期没有成功"，具体卡在哪无从查起。
- **根因**：
  1. 交互授权在发起它的页面里执行（侧边栏的 `getToken(true)`），令牌也由这个页面在 Google 回跳后写进存储。授权窗口开着时侧边栏被关掉、或被浏览器收起时，回跳结果没有人接，令牌被静默丢掉。界面不报错，存储不变，横幅照旧。
     - 在 Playwright 的 Chromium 里稳定复现：授权页停留 3 秒再回跳，期间关掉侧边栏 → 存储里仍是旧令牌和"续期失败"标记；侧边栏一直开着则成功。
  2. 静默续期的各种失败（Google 的 `login_required` / `interaction_required`、浏览器报错、超时）都被记成同一句话，看不出为什么续不上。
  3. 交互授权时，Google 若返回"需要用户操作"类错误码，报出来的是"YouTube 授权已过期，自动续期没有成功"，和横幅一字不差，看起来像点了没反应。
  - **没能直接证实**：Comet 在授权窗口打开时是否确实关掉了侧边栏（看不到 Comet 内部；读浏览历史的方案被权限拦下，未执行）。根因 1 与"无报错、令牌从未更新"的证据吻合，修复同时覆盖了 2、3，下一次失败会直接显示原因。
- **改了什么**：
  - 连接 / 重新授权改由后台 service worker 执行（`services/auth-service.ts`，消息 `tubemuse:auth:connect`，只接受本扩展自己的页面）。授权窗口开着时用 keepAlive 保活，最多 10 分钟（`GOOGLE_OAUTH.interactiveMaxMs`）。令牌由后台写入存储，侧边栏和设置页随存储变化自动更新，发起的页面中途关掉也不丢结果。
  - 同一时间只开一个授权窗口，重复点击共用同一个结果。
  - 每次尝试记进 `authAttempt`（开始时间、结束时间、失败原因；不进导出，断开时删除）。重新打开侧边栏或设置页时，显示"授权窗口已打开"、"上次授权（时间）没有完成：原因"，或"授权窗口没有把结果交回扩展"（超过 10 分钟未结束）。
  - 静默续期失败时记下具体原因（`renewReason`：Google 的错误码加一句人话，或浏览器的原始报错），显示在横幅下和设置页状态里，冷却期内的报错也带着它。旧字段 `renewError` 不再使用，下次续期成功或重新授权时随整条记录被替换。
  - 交互授权里的 Google 错误一律按交互授权的原因报（"Google 授权没有返回访问令牌（错误码）"），不再借用"自动续期没有成功"。
  - 修了一个相关竞态：静默续期还在等、交互授权已写入新令牌时，静默续期随后失败不再给新令牌打上"续期失败"标记。
- **没改**：只申请 `youtube.readonly`、隐式授权、网络出口都不变。静默续期本身的做法也不变：Comet 上为什么续不上，要等新记下的原因出来再定，不猜着改（比如不加没有文档的 `authuser` 参数）。
- **测试**：
  - 单测 +8：续期失败记下具体原因（Google 错误码、浏览器报错、冷却期）；交互授权的"需要用户操作"错误不再报成"自动续期"；连点只开一个窗口；静默续期与交互授权的竞态；后台授权的进行中、成功、失败记录；超过上限算"没交回结果"；后台回复的序列化；断开时清除记录。竞态测试做过反向验证：去掉保护后失败。
  - e2e +5：mock 授权页加"慢速"模式（`/e2e/authorize-mode`）。场景：令牌过期 → 侧边栏写明续期失败原因 → 点"重新授权"显示"授权窗口已打开" → 关掉侧边栏 → 后台照样存下新令牌、清掉"已过期"、只开了一次窗口 → 重新打开侧边栏不再显示"已过期"。
- **以后怎么换**：若某个浏览器不允许后台打开交互授权窗口，可以退回页面内执行，但必须保留"尝试记录"，并在页面关闭时提示"授权没有完成"。

## 35. 侧边栏导航栏图钉（2026-11-01，用户要求，规格外新增）

- **需求**：往下滚动时，导航栏（找片、发现、豆瓣…）会滚出视野。加一个图钉开关：按下后导航栏固定在顶部或头部下方，滚动时保持可见，且不遮挡正文；再点一次恢复随页面滚动。
- **布局**：
  - 用 `position: sticky`，不用 `fixed`。sticky 在文档流里占着自己的位置，固定前后正文不需要额外留白，也不会跳。
  - 吸附在头部下沿：头部（品牌和配额条）本来就吸顶，高度会随配额条数、窗口宽度变化。所以用 ResizeObserver 量出头部高度，写进 CSS 变量 `--top-h`，作为 `top`。
  - 固定时把外边距换成等量内边距，加不透明的 `--bg` 背景，挡住从下面滚过的正文。
  - 层级：`z-index: 4`，低于头部（5），高于正文里没设 z-index 的定位元素（时长角标等）。
  - 只有真正吸附住时（原位置已滚出）才加分隔线和阴影。判断方式是比较导航栏前面一个空元素的位置；用小数高度，避免取整误判。分隔用阴影而不是边框，不改变高度。
  - `scroll-padding-top` 设为"头部 + 已固定的导航栏"高度，页面内的跳转定位、键盘聚焦不会被挡住。
  - 固定并吸附着时切换标签页：滚回新页面的开头（紧贴导航栏下方），而不是停在上一页滚到的位置。
- **图钉按钮**：
  - 放在导航栏右端，复用 `.icon-btn` 风格。图标是内联 SVG，颜色跟随文字色，深色模式自动适配。
  - 未固定时图标倾斜、灰色；固定后直立，用强调色和浅强调底色，并设 `aria-pressed`。
  - 为了腾出位置，标签宽度从"严格均分"改为"按文字宽度分配、余下平分"（`flex: 1 1 auto`）。实测 320 / 360 / 420px 宽度下"改进记录"都不被截断；之前均分时，360px 下这个标签已经会被截断。
- **状态**：存在设置的 `ui.pinNav` 里（chrome.storage.local，默认 false）。多个窗口的侧边栏同步，重新打开后保留，随设置导出、随"清空"复位。放弃 localStorage：其他偏好都在设置里，统一一处。
- **放弃**：
  - 把头部和导航栏合成一个吸顶块：头部本来就固定，合并后高度更大，而且用户要的是"可切换"。
  - 用 IntersectionObserver 判断吸附：吸附线随头部高度变化，要跟着重建观察器；直接在滚动时比较位置更简单。
- **测试**：
  - 单测 +1：默认不固定；旧设置没有 `ui` 分区也能读；保存的选择生效。
  - e2e +7：默认随页面滚动；点图钉后标签与正文位置不跳；滚动后吸附在头部下沿，且盖在正文之上（用 elementFromPoint 检查）；固定时切换标签页回到新页面开头、不被挡住；另一个侧边栏读到同一设置；再点恢复随页面滚动。
  - 另在 Chromium 里截图检查了亮色、深色、320 / 360px 宽度。

## 36. 视频片段录制（2026-11-01，用户要求，规格外新增）

- **需求**：边看 YouTube 边录下想要的一段，画面和声音都要；录完直接存到本地；操作融入侧边栏。
- **红线变更（用户 2026-11-01 确认，CLAUDE.md §1、§2 同步）**：原红线写着"不提供下载"，注入脚本的白名单里也只有观看追踪和自动字幕。开工前停下汇报了冲突（含 YouTube 服务条款与 API 开发者政策对存储音视频的限制），用户选了推荐方案：新增独立的录制脚本，只录你主动开始录制的、正在播放的画面与声音，由浏览器存进下载文件夹；字幕烧录作为可选项（用户选"可选"）。观看追踪、自动字幕脚本和它们的构建检查不变。
- **外部事实（2026-11-01 在真实 YouTube 上核实，Claude 桌面应用内置浏览器，Chromium 152）**
  - `#movie_player video` 是 MSE（`blob:`），`captureStream()` 同时给出 live 的音轨和画面轨（854×480、30fps），不影响播放、不静音。
  - `MediaRecorder.isTypeSupported` 对 `video/mp4;codecs=avc1,mp4a.40.2`、`avc1.640028`、WebM VP8/VP9/AV1 + Opus 都返回 true。直接录 4 秒得到 1.3 MB 的 MP4，回放时长 4.02 秒。
  - 把视频画到画布上，画布仍然 origin-clean，`canvas.captureStream()` 可以录：3 秒画了 91 帧，输出 640×360，叠加的字幕框像素在成片里能读到。
  - 声音走 `AudioContext` → `MediaStreamAudioSourceNode` → `MediaStreamAudioDestinationNode`，不接扬声器也照常处理（成片里的响度 0.097）。录制器暂停 1 秒再继续，成片时长正好少 1 秒。
  - 广告和正片用的是同一个 `<video>`：插广告时 `currentTime` 跳变、播放器加 `ad-showing`。
  - 内置浏览器的面板被隐藏时，页面仍报告 `visible`，但 `requestAnimationFrame` / `requestVideoFrameCallback` 都不再回调；定时器照常。
- **画面：视频逐帧画到画布（不放进页面），录画布。** 跟着 `requestVideoFrameCallback` 画，回调停了就用 30fps 的定时器补画。输出尺寸在开录时定下（原尺寸，高于 1080 等比缩小，宽高取偶数）。
  - 放弃直接录 `captureStream()` 的画面轨：YouTube 插广告、换片源时轨道会结束或换新，MediaRecorder 遇到轨道变化就停，片段会在中插广告处断掉；清晰度切换时尺寸也会变。
  - 走画布还顺带解决了尺寸固定和字幕烧录。代价是多一次绘制，CPU 稍高。
- **声音：WebAudio 把这个视频的音轨接到一条固定的输出轨。** 广告前后音轨换新时（`addtrack`），重新接上即可，录制不中断。`AudioContext` 被浏览器挂起（页面还没有过点击）时，不静默录成无声：直接说明"在视频画面上点一下再开始"。
- **控制（`core/clips.ts` 的 `decideClip`，纯函数，每 100 毫秒一次）：**
  - 换视频（含 SPA 站内跳转、播放器换了视频元素）、到时长上限、超过 1.5 GB → 结束这一段。
  - 自由录制时视频播完 → 结束。时间段录到终点（含拖过终点）→ 结束；终点另外按帧的 `mediaTime` 判断，更准。
  - 你按了暂停、广告、标签页在后台、缓冲 / 拖动中、视频暂停 → 录制器暂停，并说明原因。不在时间段内时也暂停：还没到起点、或拖出了范围。
  - 标签页在后台时浏览器不再刷新画面，录下去会是定格画面，所以暂停。
- **时间段截取：** 开始时跳到起点并播放，按 1 倍速实时录（不下载流，所以不能快于播放）。正在播广告时拒绝开始：跳到起点会改动广告的进度。倍速播放时按当前倍速录。
- **字幕烧录（可选，默认关）：** 每 100 毫秒读一次播放器里当时显示的字幕，变了才重排：
  - 来源：YouTube 原生字幕的 `.caption-window .caption-visual-line`；TubeMuse 自动字幕层（同一扩展，shadow root 是 open）的 `.src` / `.tr`。
  - 样式与播放器字幕层一致：半透明底框，原文白色，译文浅黄、略小。字号跟"12. 自动字幕"的字号倍数。
  - 折行和排版是纯函数（`wrapText` / `layoutBurnIn`）：中日韩逐字断、其他语言按词断，从下往上堆，放不下的更早的行不画。
  - 放弃在侧边栏另录一份字幕文件（SRT）：用户要的是画面里的字幕。
- **保存：录制脚本把片段做成 Blob，用不放进页面的 `<a download>` 交给浏览器存进下载文件夹。** 不经过网络，下载归属 youtube.com。保存后只把文件名、时间段、大小、格式经 `runtime` 消息交给后台。后台逐项校验（`sanitizeClipRecord`）后记进 `clipLog`：最多 100 条，随导出、随清空。
  - 放弃 `downloads` 权限：后台拿不到页面里的 Blob；跨进程传几百 MB 太重。
  - 放弃 `tabCapture` + offscreen：要每个标签页先按快捷键授权，录的是整个标签页（含 YouTube 界面），标签页还会被静音。
  - 放弃 `getDisplayMedia`：每次弹选择框，还有"正在共享"条。
  - 放弃 `showSaveFilePicker`：要页面里有用户点击，而点击发生在侧边栏。
  - 代价：存不进下载文件夹里的子文件夹。真实 Chrome 第二次起可能问"允许 youtube.com 下载多个文件"，README 有说明。想每次自己选位置，开 Chrome 的"下载前询问每个文件的保存位置"。
- **格式：** 按优先级选第一个支持的：MP4（H.264 High + AAC）→ MP4（H.264 + AAC）→ WebM（VP9 / VP8 + Opus）。码率按输出高度（1080p 8 Mbps，720p 5 Mbps，480p 2.5 Mbps），声音 128 kbps，数值都在 `config/defaults.ts` 的 `CLIPS`。
- **停止后：** 默认直接保存（设置可关）。片段保留在内存里，可以"再存一次"（浏览器拦下时用）或"释放内存"。关掉自动保存时，停止后由你点"保存到本地"或"丢弃"。保存前片段全部在内存里，单段时长默认最多 10 分钟（1–60 可调）。
- **文件名：** 页面标题去掉通知数和" - YouTube"，去掉文件系统不允许的字符，限 80 字，再接起止时间（`标题_12m03s-13m10s.mp4`）。没有标题时用视频 ID。页面标题只用来起文件名、在侧边栏显示，不发往任何地方。
- **界面：** 侧边栏新增"片段"页（导航栏改为放不下时换行），内容：
  - 自由录制 / 按时间段截取，起点、终点可以"取当前"（精确到 0.1 秒）。
  - 录制中显示计时、已录大小、时间段进度和暂停原因，可以暂停、继续、停止。
  - 录好的片段（保存 / 再存一次 / 丢弃），最近录过的片段（点标题回到视频的这一段）。
  - 状态由录制脚本在有变化时推送（播放位置不算变化，免得边看边每秒发消息）；页面打开时每秒再问一次位置。"当前标签页状态"的钩子从字幕页抽成共用的 `useActiveTabState`。
- **快捷键与图标：** `Alt+Shift+R` 开始 / 停止（`commands`，不需要权限）。录制中工具栏图标显示 REC：在录是红色，自动暂停时灰色；失败时（例如在 Shorts 上按快捷键）显示橙色"!"，悬停可看原因。`action.setBadgeText` 不需要权限。
- **权限：没有新增。** 不用 `downloads`、`tabCapture`、`offscreen`、`desktopCapture`、`web_accessible_resources`；冒烟测试逐项核对。
- **构建检查：** 录制脚本产物里不得出现以下内容（观看追踪、字幕脚本的检查不变）：
  - 网络：`fetch(`、`XMLHttpRequest`、`WebSocket`、`sendBeacon`、`EventSource`。
  - 写 HTML：`innerHTML =`、`outerHTML =`、`insertAdjacent*`。
  - 往页面插元素：`appendChild(`、`.append(`、`.prepend(`、`insertBefore(`、`replaceChildren(`、`replaceWith(`、`attachShadow(`。
  - 其他：`document.cookie`、`getUserMedia` / `getDisplayMedia`。
- **测试：**
  - 单测 26 条：时间码解析与显示；文件名（标题清洗、Windows 保留名、无标题）；格式优先级与回退；输出尺寸与码率；开录前检查（设置关闭、Shorts、已在录、播完、时间段各种错）；`decideClip` 全部分支；折行（中文、英文、超长词、换行）与排版（从下往上、译文略小、不出界、放不下截断）；记录校验、去重、上限；后台存记录；设置默认值与旧数据兼容。
  - e2e：在 mock 播放页上依次验证：
    - 自由录制：录制中图标显示 REC；视频暂停和模拟广告期间不计时、不录。
    - 停止后直接保存：检查文件名、文件头与扩展名一致、时长不含暂停和广告、1280×720 画面、有声音。
    - 不烧录时画面干净；记录写进 `clipLog`。
    - 播放器原样未动；录制与保存期间没有任何网络请求。
    - 时间段 0:02–0:05：自动跳到起点、到终点自动停，成片约 3 秒，原生字幕烧进了画面底部、其他地方没有多出东西。
    - 关掉自动保存：停止后不保存，点"保存"才保存，"释放内存"后清掉。
    - 站内跳转换视频：这一段自动结束并保存，侧边栏说明原因。
- **没做 / 留给以后：**
  - 剪辑、预览：侧边栏是扩展页面，读不到 youtube.com 页面里的 Blob。
  - 后台标签页继续录。
  - 存进子文件夹（要 `downloads` 权限，还要把数据搬出页面）。
  - Shorts（播放器结构不同）。
  - 刷新或关闭页面前提醒未保存的片段（要拦截页面关闭，会打扰正常浏览）。

## 37. 多语字幕：几种 YouTube 字幕同时叠在播放器里（2026-11-02，用户要求，规格外新增）

- **需求**：突破 YouTube 播放器一次只能显示一种字幕的限制，在播放器底部同时叠加中、英、韩等几种语言的 CC 字幕（用户给了参考截图：三行从上到下堆叠）。用户点名的三个技术点：取多个语言轨、不同语言的时间戳差异与 `currentTime` 对齐、注入播放器且适配全屏 / 剧场模式、不与原生字幕冲突。
- **红线变更（用户 2026-11-02 确认，CLAUDE.md §1、§2 同步）**：这件事与三条红线冲突——"YouTube 数据只走官方 Data API"（字幕文字只能来自播放页自己的接口）、注入脚本的用途白名单（新用途，且要调用播放器）、网络出口白名单（内容脚本要请求 `www.youtube.com/api/timedtext`）。开工前停下汇报，给了三个方案：复用播放器请求并由 TubeMuse 代管原生字幕开关（推荐）、只读不操作播放器（每个视频你要按两次 C）、不改红线不做。用户选了推荐方案；"视频没有你选的语言时"选了"用 YouTube 自动翻译补上并标注"。观看追踪、自动字幕、片段录制脚本与它们的构建检查不变。
- **外部事实（2026-11-02 核实）**
  - 官方 Data API 走不通：`captions.list`（50 units）与 `captions.download`（200 units）都只接受 `youtube.force-ssl` / `youtubepartner` 权限，不含 `youtube.readonly`；`captions.download` 还要求"有权编辑这个视频"——别人的视频一律 403（[captions.list](https://developers.google.com/youtube/v3/docs/captions/list)、[captions.download](https://developers.google.com/youtube/v3/docs/captions/download)）。2025–2026 的修订记录里没有字幕相关变更。
  - 真实 YouTube 实测（Claude 内置浏览器，Chromium 152，已登录；TED 演讲 `arj7oStGLkU`，50 条字幕轨、156 种自动翻译目标）：
    - 字幕轨列表在播放器对象上：`#movie_player.getPlayerResponse().captions.playerCaptionsTracklistRenderer`（`captionTracks[].baseUrl / languageCode / kind / name / vssId / isTranslatable`、`translationLanguages`）。隔离环境的内容脚本看不到这个对象。旧的 `timedtext?type=list` 已失效（404）。
    - 直接请求 `baseUrl`（带不带 `fmt=json3`）都返回 **200 空响应**：缺播放器生成的 `pot` 令牌。
    - 原生字幕关着时播放器不发字幕请求；`setOption('captions','track',{languageCode})` 会让播放器自己发出请求（XHR），地址带 `pot`（116 字符）、`potc=1`、`fmt=json3`、`c=WEB` 等，在 Resource Timing 里能看到完整地址。
    - 把这个地址的 `lang` 换成 `ko` / `zh-CN` 得到完整的韩文（305 句）/ 中文（316 句）字幕，加 `tlang=zh-Hans` 得到 YouTube 机翻（315 句）；不带 Cookie 也行；去掉 `pot` 又是空响应。签名（`sparams`）不覆盖 `lang` / `kind` / `tlang`。
    - `setOption('captions','track',{})` 关掉原生字幕（字幕按钮 `aria-pressed=false`、字幕窗口消失）；`loadModule('captions')` + `setOption` 再打开；`getOption('captions','track')` 读当前选择（关着时是 `{}`）。
    - 页面的资源计时缓冲会被清掉（测试中早先的条目消失），所以用 `PerformanceObserver` 而不是只读一次 `getEntriesByType`。
    - 广告期间播放器会为**广告视频**取字幕（`v=QoI7QEvAljo`，不是页面的视频），这时 `getPlayerResponse()` 仍是正片。所以只认 `v` 等于当前视频的请求，广告期间也不请播放器取字幕。
    - 自动生成字幕的 json3（同一视频的 en/asr，实测）：1 个只定义窗口的事件（无 `segs`）、逐词 `tOffsetMs`、换行事件 `aAppend: 1`（`segs` 只有 `"\n"`），相邻句 29/30 时间重叠（两行滚动显示）——与解析器的假设一致。
- **架构：三块，各自独立、各有构建检查**
  1. **页面内助手** `content/multi-captions-bridge.ts`（manifest `world: "MAIN"`，Chrome 111+）：只应答五种请求——`state`（字幕轨列表、可翻译语言、当前原生字幕）、`prime`（让播放器选一条轨）、`hide-native`（关原生字幕，`save` 时记住原来的选择）、`restore-native`、`forget-native`。只依赖 `core/multicc-protocol.ts`（不带入任何设置与默认值，产物 3.7 KB）。构建检查：不得发网络请求、不得往页面插元素或写 HTML、不得读页面文字（`textContent` / `innerText`）、不得碰 Cookie / 本地存储、不得 `eval`、不得用 `chrome.*`。
  2. **取字幕与画字幕层** `content/multi-captions.ts`（隔离环境）：控制流程、经 `window.postMessage` 与助手通话、`PerformanceObserver` 记下播放器的字幕请求地址、复用它取各语言、按播放进度画字幕层。构建检查：**只能有一处 `fetch(`**、产物里必须有 `/api/timedtext`，不得 XHR / WebSocket / sendBeacon / EventSource、不得写 HTML、不得碰 Cookie、不得触发下载、不得 `credentials: 'include'`。运行时每个地址先过 `trackUrl` 校验：与页面同源、路径 `/api/timedtext`、`v` 是当前视频、带 `pot`。
  3. **纯逻辑** `core/multi-captions.ts`：json3 解析、按时间找句、选轨、地址改写、助手消息校验、侧边栏勾选项。后台只多了一件事：`services/multi-captions-service.ts` 回答"视频原声是什么语言"（见下）。
  - 放弃把功能塞进自动字幕脚本：那个脚本的构建检查保证"不发任何网络请求"，混进来就破了这个保证；两层字幕的生命周期（录音识别 vs 取现成字幕）也完全不同。
  - 放弃在 MAIN 世界里打补丁拦截 `fetch` / `XMLHttpRequest`：要改动 YouTube 页面的 JS 环境，也只能拿到播放器取过的那一种语言；资源计时只读地址、不碰页面代码，够用了。
  - 放弃用 `chrome.scripting.executeScript({ world: 'MAIN' })`：要新增 `scripting` 权限；声明式的 MAIN 内容脚本不需要任何权限。
  - 页面能看到也能伪造双方的 postMessage：内容脚本把助手的回答当不可信输入（`sanitizeTrackList` 逐项校验、截断）；助手只接受白名单里的五种操作。页面本来就能直接调用播放器，助手没有给它新增任何能力。
- **取字幕的流程（每个视频）**
  - 开启后先读一次字幕轨列表；原生字幕开着就关掉并记住（开启期间只在这一刻做一次）。
  - 已经看到播放器带令牌的请求（原生字幕本来开着时播放器加载就发过）→ 直接复用；没有 → 请助手让播放器选第一行要用的那条轨，播放器就会自己发出请求，看到后立刻把为此打开的原生字幕关掉。每次改动原生字幕后，作废改动之前发出的"读状态"请求，等读到改动后的状态再判断（`nativeEpoch`），否则会把自己的改动当成你按了 C。
  - 每种语言（轨 + 翻译目标）只取一次，同时最多 2 个，存在内存里；拖动、回看、关掉再开都不再取，换视频即丢。
  - 令牌失效：用某个令牌取到空响应、而它从没成功取到过字幕 → 判为失效，记下不再用，请播放器换一条轨重取；同一个视频最多 3 次，之后停下并说明（"刷新页面后再试"），不无限重试。用一个已经成功过的令牌取到空响应 → 是那条轨本身是空的，只在那一行说明。
  - 广告期间不操作播放器、不显示；Shorts 不支持。
- **原生字幕与冲突**：叠加显示期间原生字幕关着（不然会有两层，且位置重叠）。你自己按 C 打开原生字幕时多语字幕**先让开**（不和你抢），并且忘掉之前记住的选择——之后关闭多语字幕时不再替你恢复，保持你最后的操作；你再按 C 关掉原生字幕，多语字幕回来。不再显示多语字幕时（关掉、换视频且新视频不自动显示），只在原生字幕仍关着时恢复原来的选择。自动字幕层也在时，多语字幕叠在它上面（量它的位置），两者不互相关闭。
  - 放弃注入 CSS 隐藏 `.ytp-caption-window-container`：那是改动 YouTube 的元素，红线不允许；用播放器自己的开关等同你按 C。
- **选轨（`resolveSources`）**：偏好是一个有序列表（默认 `original` → `en` → `zh-Hans`，最多 4 种），一种语言一行、从上到下按顺序。
  - 语言归并（`langMatchKey`）：中文按字形分简 / 繁（zh-CN、zh-SG、zh-Hans = 简；zh-TW、zh-HK、zh-MO、zh-Hant = 繁），其他语言只看主语言（en-GB = en）；`iw`→`he`、`in`→`id`。同一语言里人工字幕优先于自动生成，同等时代码完全一致的优先。
  - "视频原声语言"：有自动生成的字幕就用它的语言（YouTube 按声音识别）；没有（MV 常见）时问后台，后台用官方 `videos.list` 查 `defaultAudioLanguage`（1 unit，与自动字幕、观看记录共用 `videoMeta` 缓存——从 `recognitionPlan` 里抽出 `lookupVideoMeta` 共用）。查不到就在侧边栏说明，其余语言照常。
  - 没有原生轨：用 YouTube 自动翻译（`tlang`）补上，标"机翻"。源轨：原声语言的人工字幕 > 其他人工字幕 > 自动生成。"原声语言"本身不用翻译补（译成原声语言的字幕不是原话）。同一种语言只出现一次（例如原声是英文时，"English" 不再重复）。
  - 侧边栏可以给单个视频另选（只在这个标签页里记住），一键改回默认（2026-11-06 起也能调顺序、设为默认，见 §51）。
- **时间轴同步（`textAt`，纯函数）**：每种语言用**自己的**时间轴独立查找，不硬对齐到某一种语言——各语言字幕的断句和起止时间本来就不同（实测的 TED 演讲里中、韩两轨句数不同），硬对齐会让某些行提前或滞后。按开始时间二分找到最后一句已开始的，再往前看最多 8 句有没有还没结束的（覆盖长标牌）；同时有几句时最多显示 2 句。两句之间空档 < 0.3 秒时留着上一句，避免闪。自动生成的字幕：相邻句截到下一句开始（YouTube 是两行滚动显示，我们一种语言只占一行），并按 `tOffsetMs` 逐词出现。
  - 刷新：播放时用 `requestAnimationFrame` 每帧按 `video.currentTime` 查（每行只在文字变化时写 `textContent`），暂停 / 拖动时由每 250 毫秒一次的主循环刷新；标签页在后台时不跑。
  - 放弃"以第一种语言为准、其他语言按重叠度配对"：显示更整齐，但会让别的语言的句子比说话提前出现。放弃原生 `<track>` / `TextTrack`：一次只能显示一种语言的样式，做不出分语言的颜色与机翻标记，也要往 `<video>` 里插元素。
- **显示**：`#movie_player` 里加一个带 Shadow DOM 的元素（`data-tubemuse="multicc"`），`pointer-events: none`，只用 `textContent` 写字。每种语言一行，从上到下按偏好顺序，颜色依次白、浅黄、浅蓝、浅紫（`MULTICC_LINE_COLORS`，第一行之后略小）；机翻行前面一个小"机翻"标记。字号按播放器高度缩放（全屏、剧场模式自动变大），控制栏出现时上移；这一刻没有字幕的语言那一行收起，全部没有时整层隐藏。状态与错误用人话写在播放器右上角（自动字幕的状态在左上角，互不遮挡）。
- **片段录制**：烧录字幕时也读多语字幕层（同一扩展的 open shadow root），每行保留自己的颜色（`BurnLine.color`）。
- **开关与设置**：设置页新增"13. 多语字幕"（片段录制、数据顺延为 14、15）：启用、有字幕的视频自动显示（默认关）、YouTube 自动翻译补缺（默认开）、显示的语言与顺序、字号。侧边栏"字幕"页最上面新增"多语字幕"一块：状态、这个视频所有的字幕（勾选即生效，写明原生 / 自动生成 / 机翻、读到几句或为什么没有）、开 / 关按钮。快捷键 `Alt+Shift+C`（`commands`，不需要权限）。默认关闭的理由同 §33：你要的是"按需"，而且开启会动原生字幕。
- **权限：没有新增。** MAIN 世界的内容脚本由 manifest 声明，不需要 `scripting`；同源请求不需要 host 权限；扩展页面的 CSP 白名单不变（这个请求不是扩展页面发的）。冒烟测试核对五个内容脚本、只有助手在 MAIN 世界。
- **测试**
  - 单测 35 条：json3（人工多行字幕、窗口事件、自动生成字幕的换行事件与逐词时间、坏数据、上限）；按时间找句（边界、空档桥接、重叠、长句、逐词出现、两种语言断句不同时各显示各的、1 万句二分与逐句扫描对拍）；语言归并、选轨（用户截图那支 MV 的轨、原声语言来自自动生成字幕 / YouTube 数据 / 查不到、机翻补缺与源轨选择、关掉自动翻译、原声不翻译、译不成、最多 4 行）、侧边栏勾选项、让播放器取哪条轨；地址（认得播放器请求、只换语言参数且令牌签名原样、asr / tlang / name、拒绝别的视频 / 站点 / 无令牌）；助手消息校验；设置默认值与旧数据兼容；烧录颜色；后台查原声语言（1 unit 并缓存、没连接、没写、关闭、坏 ID）。
  - e2e：mock 播放页带一个按实测接口写的假播放器（`getPlayerResponse` / `getOption` / `setOption` / `loadModule`，选轨时自己用 XHR 发带 `pot` 的请求），mock 字幕接口没有令牌时回空响应。场景：默认不开启、不发请求；原生字幕关着时开启 → 请播放器取一次 → 复用请求取韩 / 英 / 中三种（令牌、签名原样，各一次）→ 三行按各自时间轴显示（4.25 秒时英、中已换句而韩文未换）、空档不闪、全部没有时隐藏；原生字幕随即关掉；只调用了字幕开关、YouTube 的元素没被改动（MutationObserver）；侧边栏加一种空轨语言 → 只在那一行说明；播放器从 360 高变 720 高字号翻倍、控制栏出现时上移；关闭后不替你打开本来关着的原生字幕；原生字幕开着的演讲 → 直接复用、不再请播放器取 → 英文 + 机翻中文（`tlang`）→ 关闭后恢复原生英文；显示期间你按 C → 让开、再按 C → 回来、之后关闭不再替你恢复；没有字幕的视频只说明不请求；令牌一直失效 → 换 3 条轨后停下并说明、不再请求；勾选自动显示后打开就显示；字幕请求都是页面同源请求、不带任何 Key 或令牌。
- **没做 / 留给以后**：每种语言单独调时间偏移（用户没要，各轨自带的时间轴已对准）；把字幕存进本机供离线回看或导出（红线只允许存在内存里）；Shorts；YouTube Music 与嵌入式播放器。
- **以后怎么换**：YouTube 改了令牌或字幕接口时，只需改 `core/multi-captions.ts` 的 `timedtextVideoId` / `trackUrl` 与页面内助手的 `state`（播放器字段）；若某天官方 Data API 允许 `youtube.readonly` 下载别人视频的字幕，就把取字幕换成后台调用官方接口，页面内助手与字幕层不变。

## 38. 多语字幕开启后只剩一种原生字幕、提示"你打开了 YouTube 原生字幕"（2026-11-02，上线后修复）

- **现象**：用户在 TWS MV（`3MPUCncZBR0`，用户的 YouTube 字幕偏好是"开着、中文（简体）"）上开启多语字幕后，播放器里只有一行 YouTube 原生中文字幕，没有多语字幕层；侧边栏写"你打开了 YouTube 原生字幕，多语字幕先让开；按 C 关掉原生字幕即恢复"——用户并没有按 C。
- **证据（2026-11-02，真实 YouTube，Claude 内置浏览器）**
  - YouTube 把字幕偏好存在 `yt-player-caption-persistence`（开 / 关）与 `yt-player-caption-sticky-language`（语言）里。从字幕菜单选中文 → `true` + `zh-Hans`；页面内助手关原生字幕用的 `setOption('captions','track',{})` → 变 `false`（所以关过一次之后，播放器不会再自己打开）。
  - 偏好为"开 + 中文"时让播放器重新加载这个视频（`loadVideoById`，等同换到这个视频 / 广告结束后正片开始），每 50 毫秒记一次 `getOption('captions','track')`：0.13 秒时是关着的，**0.81 秒时播放器自己打开了 zh-Hans**，那时还在缓冲、没开始播放。
  - 修复前的构建在 e2e 假播放器上复现（假播放器照实测行为：正片开始约 1 秒后按保存的偏好打开字幕，先放 2.5 秒广告，广告期间点"显示多语字幕"）：侧边栏同样写"你打开了 YouTube 原生字幕，多语字幕先让开"，原生字幕是 zh-Hans，没有多语字幕层。修复后同一脚本：正在显示、原生字幕关着。
- **根因**：内容脚本把"开启后原生字幕被打开、且不是我们打开的"一律当成你按了 C（§37 的"先让开"）。但 YouTube 自己也会打开：每次正片开始（页面打开、站内换视频、广告结束）后约 1 秒按你保存的偏好打开。多语字幕若在这之前就做完了开启时的那一次检查（看到原生字幕关着）——广告期间点了开启、勾了"自动显示"、或页面一打开就点——播放器随后的自动打开就被误判成你的操作，多语字幕让开、不再显示。
  - 连带问题：那种情况下原生字幕关着、还没有带令牌的请求，内容脚本会马上请播放器选第一行的轨（例如韩语），把你保存的语言改掉；播放器随后再按旧偏好打开中文。
- **修复**
  - `core/multi-captions.ts` 新增 `AutoCaptionWindow`（纯逻辑）：正片开始（页面打开、换视频、广告结束）后、正片播放满 2 秒之前（最多 8 秒），算"播放器可能按你的偏好自动打开字幕"的窗口。主循环每轮喂一次"是否广告、是否在播放"。
  - 窗口内原生字幕被打开（不是我们打开的）：当作播放器自动打开的，照常关掉并**记住它**（关闭多语字幕时恢复成你保存的语言），同一窗口最多这样处理 2 次；窗口外才算你按了 C、多语字幕先让开（行为同 §37）。
  - 窗口内没有带令牌的请求时先不请播放器选轨：它很可能马上自己打开字幕（顺带发出带令牌的请求，直接复用），免得我们选的轨盖掉你保存的语言。代价：原生字幕本来关着时，若在视频刚开始就开启，多语字幕要等正片播满 2 秒（最多 8 秒）才出现；视频中途开启不受影响。
  - 窗口内每 250 毫秒读一次播放器的字幕状态（平时每秒一次），尽快看到那次自动打开。
  - 数值在 `config/defaults.ts` 的 `MULTI_CC.autoCaptionGracePlaySec / autoCaptionGraceMaxMs / autoCaptionMaxAbsorb`。
- **放弃**
  - 读 `yt-player-caption-persistence` 判断你的偏好：要读 YouTube 的本地存储，超出红线里"页面内助手只读字幕轨列表与当前字幕状态"的范围（构建检查也禁止）。
  - 监听页面上的按键 / 点击判断你是否按了 C：要读取你在页面上的输入，同样超出红线允许的范围。
  - 一律不让开（原生字幕一打开就关掉）：你真想看原生字幕时会被反复关掉。
- **测试**：单测 +5（窗口：开始后、还没播放时吸收且最多 2 次；播满 2 秒后算你按的；停在开头最多等 8 秒；广告期间不计时、广告结束重新开始；换视频重新计时、后台节流一轮最多按 1 秒算）。e2e 假播放器新增"按保存的偏好在正片开始后约 1 秒自动打开字幕（不经过公开的 setOption）"与"先放广告"，+2 个场景：勾选自动显示后打开页面、广告期间点开启——都照常叠加三种语言、原生字幕关着、直接复用那次自动打开发出的请求（没有另外请播放器选轨）、关闭后恢复成中文。原有"你按 C → 先让开"场景改为先播放两秒再按（你是在观看中按 C 的）。
- **没改**：页面内助手、取字幕的请求、红线范围都不变。

## 39. 录好的片段画面正常、没有声音（2026-11-02，上线后修复）

- **现象**：用户在 TWS MV 上自由录制 2 分 27 秒（侧边栏写"已保存……_00m00s-02m27s.mp4、MP4（H.264 + AAC）"），文件画面正常、没有声音。用户当时戴着蓝牙耳机。
- **证据**
  - 用户的文件（ffmpeg + 逐个读 MP4 盒子）：文件头 `moov` 里只有 1 条轨（画面），没有声音轨。但分片里有第 2 条轨：6894 帧 AAC，时间刻度 48000，合计 147.1 秒——正好是录到的 2:27.1；每帧中位 338 字节，是正常的 128 kbps 声音，不是静音。第 2 条轨从第 3 个分片才出现，之后一直比画面落后约 12 秒，最后一个分片一次补进 12.5 秒的声音。声音录到了、编码了、写进了文件，只是文件头没声明，播放器一概读不到（ffmpeg 还因此把这 6894 帧当成画面读，报了 6894 次 NAL 错误，时长算成 2:47）。
  - 同一台电脑 11-01 录的另一段（K-POP，30m40s–31m49s）：文件头有两条轨，第 1 个分片就有声音，48 kHz。
  - 在本机真实 Chrome 156 里只用画布 + 正弦波复现（Playwright `channel: 'chrome'`，有界面）：`start(1000)` 后立刻 `pause()`，暂停 6 秒再 `resume()`，录 10 秒 → 文件头只有画面轨，声音从第 10 个分片才出现，最后一片补进 6.3 秒声音，与用户的文件同一特征。暂停 0 秒、0.1 秒都正常。不用蓝牙也必现。
- **根因**：录制脚本开录时先 `recorder.start()`、马上 `pause()`，等"该录了"（广告结束、跳到起点、缓冲完、视频开始播放）才 `resume()`。Chrome 的 MP4 封装按时间戳排队交错两条轨；开头暂停了多久，声音就排在画面后面多久。文件头随第一个完整的分片写出（分片在关键帧处切开：720p / 1080p 约 101 帧、3–4 秒），那时还没有任何声音帧进过封装，文件头里就只有画面轨，而分片 MP4 的文件头写出后不能再改。开头的等待、以及之后录的时长都超过一个分片才会触发（只录 2.5 秒就停的话，第一个分片在停止时才写出，那时声音已经到了，文件正常——所以短测试发现不了）；用户那段从 0:00 开始，很可能是在片头广告（或缓冲）中按的开始，等了约 12 秒。开始之后的暂停（中插广告、你按暂停）没有这个问题：文件头已经带着两条轨写出了。蓝牙耳机不是这次的原因：当时的录音采样率是 48 kHz，默认输出设备（OWS Pro）也是 48 kHz。
- **顺带查到的另一条无声路径（蓝牙）**：本机另有一个启用中的蓝牙输出端点（英特尔智音技术，通话模式）是 16 kHz 单声道。`AudioContext` 默认跟着默认输出设备的采样率走；在 Chrome 156 里把它设成 16 kHz：`AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 16000 })` 为 false，MediaRecorder 不出数据、停不下来或自己停掉（22.05 / 24 / 32 kHz 同样；44.1 / 48 kHz 正常）。Windows 把默认输出切到耳机的通话端点时就会遇到。
- **修复**
  - 录音机等到第一次"该录了"才 `start()`（`content/clipper.ts` 的 `startRecorder`），开头不再经过暂停；之后的暂停照旧 `pause()` / `resume()`。同一复现脚本：先等 6 秒再开始 → 两条轨都在文件头；开始后 0.3 秒、1.5 秒、8 秒再暂停 6 秒 → 都正常，暂停前后声画总时长一致（16.0 秒 / 15.9 秒）。
  - `AudioContext` 固定 48 kHz（`CLIPS.audioSampleRate`），由浏览器重采样，不再跟着输出设备走。
  - 不再静默产出无声文件：MP4 文件头一写出（Chrome 交出的第一块数据就是 ftyp + moov）就用纯函数 `mp4TrackKinds` 查有没有声音轨；没有就立刻停下、不保存这一段，侧边栏写"录制出错：浏览器写出的文件里没有声音轨……"。用户那个文件在这个检查下得到 `['vide']`，11-01 那段得到 `['vide', 'soun']`。WebM 不查（Chrome 只在不支持 MP4 时才用它）。
- **放弃**
  - 不分片（`start()` 不传 timeslice，停止时一次交出）：文件头会在最后写，躲开排队问题，但"已录大小"就看不到了，1.5 GB 的上限也没法在录制中判断。
  - 事后修文件（把漏掉的声音轨补进文件头）：要在页面里重写整个 MP4，几百 MB 的数据再拷一遍；修根因更简单。
  - 用 `isConfigSupported` 检测 AAC 支持、不支持时退回 WebM：固定 48 kHz 之后不需要；真遇到不支持，文件头检查会报出来。
- **测试**
  - 单测 +5：文件头里两条轨、只有画面轨、没写全时等更多数据、文件头前就出现分片；Chrome 156 实录的两个文件头作为夹具；采样率固定 48 kHz。
  - e2e 新增"片头广告中开始 → 等 13 秒 → 广告结束才真正开录 → 录 12 秒 → 成片有声音"。时长有讲究：mock 视频只有声音，画布约 10 帧/秒，第一个分片约 10 秒；等 4–6 秒、录 2.5–8 秒时修复前的构建也能通过（两次实跑都过了），测不出这个 bug。
  - 修复前后对照（同一 e2e 浏览器加载扩展，经消息直接控制录制，等 13 秒、录 12 秒）：修复前，广告中开始、视频暂停着开始两种都得到只有画面轨的文件，页面里 `decodeAudioData` 报"Unable to decode audio data"；修复后两种文件头都有两条轨，第一个分片里 10 秒画面配 10 秒声音（不再错开），响度 0.132。

## 40. 小红书网页版：笔记发布时间、收藏与标签（2026-11-03，用户要求，规格外新增）

- **需求**：扩展支持小红书网页版（示例：个人主页 `https://www.xiaohongshu.com/user/profile/*`）。用户给了截图，红框圈出笔记卡片底部（标题 + 作者 / 点赞那一行）：① 在这一块自然地显示每条笔记的具体发布时间；② 在页面上直接收藏博主或单篇笔记，并能添加、管理自定义标签。
- **红线核对**：CLAUDE.md §2 的红线都是针对 YouTube / X 与网络出口写的，没有一条覆盖小红书。按"不发网络请求、只读页面里已有的数据"设计后，网络出口白名单（connect-src / host_permissions / img-src）一项不变，所以没有停下来等确认，直接开工；但这是扩展第一次往 YouTube 以外的网站注入脚本、改动页面，CLAUDE.md §1、§2 补了一段对应的约束（同日，请用户过目）。也守住"只建议，不代办"：这里的"收藏"是 TubeMuse 自己的本地收藏，脚本不点击、不模拟点击小红书的任何按钮。
- **外部事实（2026-11-03 实测，Claude 内置浏览器，未登录；从这台机器打开 xiaohongshu.com 会被转到国际域名 `www.rednote.com`，同一个网页版）**
  - 卡片：`section.note-item[data-index]` > `div` > 隐藏链接 `a[style="display: none"]` + `a.cover` + `.footer`（`a.title`、`.author-wrapper`（`a.author` > 头像 + `.name`、`.like-wrapper`））。首页卡片链接是 `/discovery/item/<笔记ID>?xsec_token=…`；个人主页是 `/user/profile/<用户ID>/<笔记ID>?xsec_token=…&xsec_source=pc_user`——**未登录时笔记 ID 是空的**（`/user/profile/<用户ID>/`）。Vue 生产构建，元素上没有组件实例可读。
  - **瀑布流不重排**：卡片 `position: absolute` + `transform`，位置由页面按当时的卡片高度一次算好。实测往每张卡片 footer 里加一行 18px：卡片变高 18px，位置不变，压住下一张 12px；派发 `resize` 也不重排。卡片还是**虚拟列表**：滚动时元素被移除 / 换成别的笔记（12 篇只有 4–8 个在 DOM 里）。
  - **页面数据**：`window.__INITIAL_STATE__`（只有页面环境能看到）。个人主页 `user.notes` 是 Vue ref（`_rawValue` 是按"笔记 / 收藏 / 点赞"分的数组），列表项 `{ id, index, noteCard: { noteId, displayTitle, time, … } }`，**`time` 是毫秒级发布时间**（未登录时 `noteId` 也是空字符串）；笔记详情 `note.noteDetailMap[<ID>].note` 有 `time` 与 `lastUpdateTime`；首页 `feed.feeds` 只有 ID，没有时间。走完整份个人主页数据 956 个对象、5 毫秒。
  - **笔记 ID 前 8 位 = 创建时刻（Unix 秒）**。对 6 篇笔记比对详情页的 `time`：4 篇一秒不差；2 篇 ID 时间早 1 小时 57 分 / 2 小时 46 分，且这两篇的 `lastUpdateTime` 早于 `time`——定时发布或审核后发布。所以 ID 只能当"≈"用。
- **发布时间：页面数据 > 笔记 ID，两者都不发请求。**
  - 页面内助手 `content/xhs-bridge.ts`（manifest `world: "MAIN"`，与多语字幕的助手同一做法）：只应答一种请求，在 `__INITIAL_STATE__` 里找"列表项带 `noteCard.time`"与"笔记本身 `{ noteId, time }`"两种形状，交回 `{ id, index, title, time }`。解 Vue ref（`__v_isRef` → `_rawValue`）与响应式代理（`__v_raw`），不进 `dep`；有循环引用保护和上限（6 万个对象、深 10 层、3000 条，`core/xhs-protocol.ts`）。不认具体路径，小红书挪动数据位置也能找到。构建检查：不得发网络请求、**连 `document` 都不能用**、不得碰存储、不得 `eval`、不得用 `chrome.*`。
  - 对应到卡片（`core/xhs.ts` 的 `cardTime`）：有笔记 ID 按 ID；没有（未登录）按 `data-index` + 标题（空白归一）；同一键对上两个不同时间时宁可不显示。都没有时用笔记 ID 推算（`timeFromNoteId`，2013 年以前或未来 2 天以后的不认）；再没有显示"时间未知"（未登录且对不上）。
  - 助手的回答当不可信输入（页面能伪造 postMessage）：`sanitizeTimeEntries` 逐项校验时间范围、ID 格式、截断标题。
  - 有没在页面数据里找过的卡片（虚拟列表滚出新卡片、加载下一页、打开详情、站内跳转）时重读一次，最多每 0.8 秒一次。
  - 显示：本地时区 `YYYY/MM/DD HH:mm`（与豆瓣评论卡同一个 `formatDateTime`，用户 10-31 定的格式）；由 ID 推算的加"≈"，并在悬停提示里说明（页面数据的精确时间不加提示，同豆瓣）。笔记详情的日期旁写"发布于 …"。
  - 放弃：① 请求每篇笔记的详情页拿 `time`——那是网页抓取，要带 Cookie、过小红书的反爬（`xsec_token`、签名），且要新增网络出口；② 在页面环境里拦截 `fetch` / `XMLHttpRequest` 读接口返回——改动小红书页面的 JS 环境，页面数据已经够用；③ 只用笔记 ID——个人主页明明有精确时间，三分之一的笔记会差几个小时还不标明，违背"不静默降级"。
- **放在哪儿：作者那一行，不另起一行。** 时间插在 `a.author` 与 `.like-wrapper` 之间，`margin-left: auto` 靠右贴着点赞数；作者名放不下时由小红书自己的省略号截短（我们只加了一条 `min-width: 20px` 给头像留位置）。这样卡片高度一像素都不变（e2e 用仿瀑布流的页面核对：高度与排版时相同、同一列不重叠、这一行仍是 20px）。放弃：另起一行（压住下面的卡片，见上）；改小封面高度腾地方（要改小红书元素的内联样式，虚拟列表重画时会被改回去）；放在封面上（不在用户圈的区域）。
- **收藏按钮放在封面左下角，悬停时出现、收藏后常驻**（"已收藏 · 2"）。按钮插在 footer 开头、`position: absolute` 用静态位置 + 负的 `margin-top` 定到封面左下角，不占卡片高度、不嵌在封面链接里（点它不会打开笔记）。博主主页名字旁一个"收藏博主"、笔记详情"关注"旁一个"收藏"。点开是一个弹窗（同一时间只有一个，挂在 `body` 上、`position: fixed`，贴着按钮，被虚拟列表回收时自动关掉）：笔记一节、作者一节，各有"收藏 / 移出"、已有标签（× 去掉）、加标签输入框（回车；逗号 / 顿号分开可一次加几个；**未收藏时加标签即收藏**）、"常用"标签（还没打在这一条上的、最常用的 12 个）。未登录时卡片没有笔记链接：笔记一节说明"登录后才能收藏"，博主照常。
  - 按钮和弹窗都在 Shadow DOM 里（小红书的样式进不来、我们的也出不去）；时间是一个 `<time>`，靠注入的一小段全局样式定位——只选中我们自己加的元素（`[data-tubemuse^="xhs"]`）。
  - 按钮、弹窗上的点击 / 按键都不往外传：不让小红书把它当成"点了卡片"或触发它的快捷键。"点外面关闭"用捕获阶段的 `pointerdown`；Esc 关闭并把焦点还给按钮。
  - 名字：按钮叫"收藏"，悬停提示与弹窗都写明"收进 TubeMuse，只存在本机，不会在小红书上收藏或关注"。放弃起别的名字（"存""TM 收藏"）：用户要的就是"收藏"，和小红书原生收藏的区别靠说明文字讲清楚。
- **数据与写入**：存储键 `xhs` = `{ notes: {ID → {标题, 链接, 作者 ID / 名字, 发布时间与来源, 收藏时间, 标签}}, users: {ID → {名字, 链接, 收藏时间, 标签}} }`。链接只留站点 + 路径 + `xsec_token` / `xsec_source`（从外面打开笔记必须带 `xsec_token`，否则小红书显示"暂时无法浏览"），去掉来源统计参数。不存封面和头像：侧边栏要显示它们得把小红书图片域名加进 img-src（红线变更），用户没要。
  - **写入只经后台**：页面脚本发 `tubemuse:xhs:op`，后台核对发送方是注入小红书的脚本（`XHS_PAGES` 前缀），`parseXhsOp(…, fromPage=true)` 把内容当不可信输入校验——只接受收藏 / 移出 / 加减标签；ID 必须是 24 位十六进制且与链接里的一致，链接必须是小红书网页版的笔记 / 主页，文字去控制字符、限长（标题 200、名字 60、标签 20 字），时间要在合理范围——再加锁读改写。改名 / 删除标签 / 撤销只在侧边栏。页面脚本**不直接写**扩展存储（构建检查 `chrome.storage.local.set/remove/clear`），只读 `settings` 与 `xhs` 两个键（和 YouTube 的脚本一样直接读）。放弃让页面脚本自己写：页面里的 Web Lock 属于小红书的源，和侧边栏、后台互斥不了，并发写会丢。
  - 标签：去掉开头的 #、合并空白、按字限长（不劈开 emoji）；不分大小写去重（保留先出现的写法）；每条最多 20 个。标签不单独建表，从收藏上汇总：改名 = 所有收藏上替换（新名字已有就合并成一个），删除 = 所有收藏上去掉。放弃单独的标签表：多一份要同步的数据，"没被任何收藏用到的标签"也没有用处。
  - 再次收藏同一条：更新标题、链接、作者，保留收藏时间与标签；发布时间只升级（页面数据的覆盖 ID 推算的），不降级。各自最多 5000 条。
  - 随"导出全部数据"导出、随"清空"删除（同一个 `chrome.storage.local`）。不发给大模型。
- **侧边栏"小红书"页**（豆瓣之后）：顶部说明当前标签页的情况（博主主页 / 笔记详情 / 笔记列表；找到几张卡片、几张是页面数据的时间、几张 ID 推算、几张未知；助手没应答时提示刷新）——页面脚本按 `useActiveTabState` 的协议应答与推送，"不静默"。下面是"全部 / 笔记 / 博主"、关键词（标题、作者、标签）、标签筛选；每条显示类型、标题链接（新标签页，同豆瓣）、作者、发布时间、收藏日期、标签（点标签筛选、× 去掉、输入框加）、"移出收藏"（可撤销）。"管理标签"里改名、删除（删除要再点一次确认，写明会从几条收藏上去掉）。
- **设置**：新增"15. 小红书"（启用、显示发布时间、显示收藏按钮；都默认开，关掉后页面上 TubeMuse 加的东西全部移除，收藏保留），"数据"顺延为 16。
- **站点**：`www.xiaohongshu.com` 与 `www.rednote.com`（同一个网页版，海外网络会被转过去；本次实测就是在 rednote.com 上做的）。只进内容脚本的 `matches`（`endpoints.ts` 的 `XHS_PAGES`），不进 host_permissions / connect-src。e2e 构建另加 `http://127.0.0.1:47321/xhs/`（mock 的仿小红书页面），不影响 mock 的 YouTube 播放页。安装时 Chrome 会提示"读取和更改你在 www.xiaohongshu.com 和 www.rednote.com 上的数据"。
- **构建检查**（`scripts/build.mjs`）：页面脚本不得发网络请求、不得用 HTML 字符串写页面、不得碰 Cookie / 页面的本地存储、不得 `.click()` / `dispatchEvent`（不会替你点小红书的按钮）、不得直接写扩展存储、不得 `eval` / `window.open`、不得触发下载。正式版冒烟测试核对两个新脚本只注入小红书网页版、助手在页面环境，网络出口白名单不变。
- **测试**：单测 23 条（ID → 时间与边界、页面数据优先、未登录按位置 + 标题、歧义不显示、助手回答校验、显示格式与时区、链接识别与规范化（含 rednote.com、伪造域名）、页面类型、标签规范化与拆分、收藏 / 加减标签 / 上限 / 改名合并 / 删除 / 撤销、页面只能发四种操作、坏数据读出时丢弃、筛选与常用标签、加锁并发写）。e2e 用照真实结构写的仿小红书页面（`tests/e2e/xhs-pages.mjs`：瀑布流按排版时的高度一次摆好、Vue ref 形状的页面数据带循环引用、一张未登录样式的卡片、记录小红书元素被点击的次数）：三种时间来源、时间在作者与点赞之间、卡片高度不变不重叠、悬停出现按钮、加标签即收藏（存下的链接、时间来源）、收藏博主后主页按钮跟着变、去掉标签、Esc / 点外面关闭、未登录卡片的说明、常用标签、虚拟列表换卡片后时间跟着换、设置开关、详情页时间与按钮、侧边栏筛选 / 改名 / 移出与撤销、小红书页面上没有 TubeMuse 发出的请求、小红书元素一次都没被点到。
- **日后替换**：小红书改版时改 `content/xhs.ts` 里的选择器（`section.note-item`、`.footer`、`.author-wrapper`、`.user-info .user-name`、`#noteContainer`、`.bottom-container .date`、`.note-detail-follow-btn`）与 `parseXhsPath` 的路径；页面数据的形状变了改 `xhs-bridge.ts` 的 `collect`。要在侧边栏显示封面，需先征得同意把小红书图片域名加进 img-src。

## 41. 多语字幕：每种语言尽量只占一行（2026-11-03，用户要求）

- **现象**：同时显示几种语言时，单种语言的字幕常占两行甚至更多（用户截图：韩、英各两行，机翻中文两行，一共六行），字幕区过高、挡住画面。
- **原因（按影响排序）**
  1. **字幕本身带换行**：YouTube 字幕作者常把一句歌词在句中手动断成两行（截图里 `We YG지, Yeah we be trimmin' trimmin'` 与 `We gon' shock yuh` 是同一句字幕，中间是 `\n`）。解析时保留了换行，字幕层又用 `white-space: pre-wrap` 原样显示——播放器明明宽得放下整句，也被拆成两行。
  2. 同一种语言同时有两句（重叠的对白、标牌）时用换行隔开，又多一行。
  3. 可用宽度偏窄：容器左右各留 4%、每行再限 92%，实际只有播放器宽度的约 85%；加上 `overflow-wrap: anywhere`，一超宽就在任意处折。
  4. 字号不随文字长短调整：最大 38px，长句只能折行。
  5. 行距偏松（行高 1.32、行间 0.16em）。
- **做法**
  - `core/multi-captions.ts` 新增 `joinCueLines`（纯函数）：显示前把一句里的几行、以及同时显示的几句接成一行——中日韩全角标点后直接接，其余用一个空格。解析出的字幕数据本身不变（仍保留原换行）。
  - 每行最宽占播放器的 96%（`MULTI_CC.lineMaxWidthRatio`），默认不折行（`nowrap`）。
  - `fitLine`（纯函数）+ 内容脚本的 `fitLines`：每一行按原字号、不折行排一次，量出宽度；放不下就**只把这一行**等比缩小到正好放下（最多缩到 75%，`MULTI_CC.fitMinScale`），缩到 75% 还放不下才允许折行（用 75% 的字号）。字号、内边距、"机翻"标记都按 em 算，宽度随字号等比变化，缩一次就准。一批变化的行先全部写、再一起量、再一起改，每批只触发一次排版；文字变化时排变化的行，播放器尺寸或字号变化（全屏、剧场模式、改字号倍数）时重排所有行。
  - 行高 1.32 → 1.25，行间 0.16em → 0.12em，上下内边距 0.06em → 0.05em。
  - 片段录制烧录字幕读的是字幕层里接好的一行文字，按成片宽度自己折行（不变）。
- **放弃**
  - 超出部分截断（`text-overflow: ellipsis`）：会把歌词 / 台词藏掉，看不全；改为最后才折行、显示全文。
  - 所有行统一缩小字号：短的语言也跟着变小，难读；只缩放不下的那一行。
  - 用画布 `measureText` 估宽度：字体回退（中日韩混排）下与实际渲染有偏差；直接量这一行的 `scrollWidth`。
  - 加一个"保留原字幕换行"的设置：用户要的就是一行；有需要再加。
- **测试**：单测 +4（接行：英韩加空格、中文全角标点后直接接、重叠的几句、空行与空白；缩放：放得下、等比缩到正好、缩到 75% 还放不下就折行、未排版时不缩放）。e2e：mock MV 的字幕改成和真实歌词字幕一样在句中断行，并加一句特别长的英文，+4 项检查——三种语言各占一行、放得下时不缩小；量出英文这一行的宽度后把播放器调到只够它 85% 宽，这一行缩到约 85% 仍是一行；调到 60% 宽，缩到 75% 并折行；那句特别长的字幕缩到 75% 后折行、显示全文。

## 42. 多语字幕一直"正在读取字幕…"（2026-11-03，上线后修复）

- **现象**：用户在 TWS 的 STUDIO CHOOM 视频（`h6xpzXZ2FBA`，7 种人工字幕、没有自动生成的字幕）上开启多语字幕，播放器右上角与侧边栏一直写"正在读取字幕…"，一行字幕都不出；用户说"部分视频"这样。
- **证据（2026-11-03，真实 YouTube，Claude 内置浏览器，Chromium 152，与用户同一台电脑、同一网络）**
  - 字幕轨列表正常（ko / en / zh-Hans / id / ja / es / th，都可自动翻译）。`setOption` 选韩语后，播放器照常发出带 `pot` 的 `/api/timedtext` 请求——**这个请求本身 40.4 秒后才回，HTTP 502**（Google 前端的"Error 502 (Server Error)"页，1.6 KB）；播放器自己的字幕窗口一直是空的：YouTube 自带的字幕同样出不来。
  - 复用这个请求换语言 / 格式（ko、en、zh-Hans × json3 / srv3 / vtt / 不带 fmt，加 tlang）：几乎都是约 40 秒后 502，偶尔约 20 秒后 200（一次 srv3 读到了真字幕，同样的请求再发一次又是 502）。不带 `pot`、`pot` 改坏的请求（平时立刻回 200 空）也要等 20–40 秒——慢的是字幕接口本身，与令牌、参数、格式无关。
  - 对照：同频道另一支（`s-RxvIPvpBc`，只有自动生成字幕）、11-02 一切正常的 TED 演讲（`arj7oStGLkU`）：播放器自己的字幕请求同样 40 秒后 502。所以不限于"部分视频"，是这段时间 YouTube 的字幕接口整体出故障（至少从这台电脑的网络看；有的视频看着正常，可能是碰上了约 20 秒成功的那次，或字幕是故障之前取的）。
  - 关原生字幕（`setOption(…, {})`）或换轨会中止播放器还在等的那个请求，资源计时里立刻出现这条地址（状态 0）——取令牌这一步不受影响，卡住的是之后取各语言的请求。
- **根因**：YouTube 字幕接口服务器端的故障（约 20 秒才回、多数 40 秒后网关放弃回 502），在 TubeMuse 之外，修不了。TubeMuse 这边让它变成"一直卡着、不说为什么"的有四处：
  1. 取字幕的请求不设超时，状态也不说明在等什么——一直"正在读取字幕…"，看不出是 YouTube 慢；
  2. 同时只取 2 种：第 3 种语言要排在前两个 40 秒之后；
  3. 502、连不上一律当成永久失败：这个视频不再取，关掉再打开也不取，只有刷新页面——而 502 是暂时的；
  4. 换视频时不取消上一个视频还在等的请求，它们占着同时取的名额，新视频的字幕要多等最多 40 秒。
- **修复**
  - `core/multi-captions.ts` 新增 `ccFetchRetry`（纯函数）：5xx、429、超时、连不上算暂时的，隔 5 / 15 / 30 秒重试，最多 3 次；用完停下，写明"重试 3 次仍不行"，并提示"这是 YouTube 那边暂时的问题，不是 TubeMuse 的设置问题；这时 YouTube 自带的字幕通常也出不来。过几分钟关掉再打开多语字幕即重试"（连不上时提示检查网络 / 代理）。其余 4xx 重试没用，不重试。
  - `ccWaitStatus`（纯函数）：一种都还没读到时说明在等什么——有请求已等 8 秒以上 →"YouTube 的字幕接口响应很慢，已等 N 秒…（第 k 次重试）"；都在等重试 →"YouTube 的字幕服务器出错（HTTP 502），N 秒后重试（第 k 次，最多 3 次）"。侧边栏状态与播放器右上角都用它。已读到一部分时，侧边栏写"正在显示 1 种语言，还有 1 种在读取"，每一行写明出错原因与"稍后重试"。
  - 每次请求最多等 60 秒（YouTube 网关约 40 秒放弃，这里只防连接一直挂着）；同时取 4 种（= 最多行数；youtube.com 走 HTTP/3 多路复用，不多占连接）。
  - 换视频时取消在途的字幕请求（`AbortController`）。
  - 关掉再打开多语字幕（或按两次 `Alt+Shift+C`）：重取出错、等重试的语言，已读到的不再取。
  - 数值在 `config/defaults.ts` 的 `MULTI_CC.fetchTimeoutMs / fetchRetryDelaysMs / slowFetchMs / fetchConcurrency`。
- **放弃**
  - 换别的字幕来源（例如页面"显示转写文稿"用的 `youtubei/v1/get_transcript`）：网络出口白名单只允许 `/api/timedtext`，换来源要你先同意红线变更；它一次也只给一种语言、没有自动翻译。若字幕接口长期不可用再议。
  - 更短的超时（例如 15 秒）：实测成功的响应本身就要约 20 秒，短超时会把能成功的请求掐掉。
  - 无限重试：YouTube 长时间故障时会一直打它的接口；3 次后停下，由你决定什么时候再试。
  - 换格式重试（srv3 / vtt）：实测各种格式一样慢、一样 502。
- **测试**：单测 +8（重试：5xx / 429 / 超时 / 连不上按 5、15、30 秒重试，用完停下并写明次数与 YouTube 那边的提示，4xx 不重试，默认值来自配置；等待说明：刚发出时"正在读取"、等了 8 秒以上按最早发出的算秒数并写第几次重试、都在等重试时写几秒后第几次、有在途请求时不提前报错）。e2e：mock 字幕接口可按次数回 502 / 404 / 慢 9 秒，新场景 `ccFlaky00007`：一种都没读到时侧边栏与播放器写"响应很慢，已等 N 秒"；韩文 9 秒后读到；英文两次 502 后第 3 次读到（隔 5、15 秒）；中文 404 不重试；关掉再打开只重取中文。
- **没改**：页面内助手、取令牌的流程、红线与网络出口都不变。

## 43. 小红书：笔记详情里的"收藏"、视频笔记的片段录制（2026-11-04，用户要求）

- **需求**：① 小红书的本地收藏只在瀑布流卡片上能用，打开的笔记详情里没有——要在详情里也能收藏；② "片段"页只认 YouTube，要能录小红书笔记详情里的视频。用户给了两张截图：详情浮层里只有小红书自己的"关注"，侧边栏"片段"页写"当前标签页不是 YouTube 视频页"。
- **外部事实（2026-11-04 实测，Claude 内置浏览器，未登录，rednote.com，首页点开一篇视频笔记的浮层）**
  - 详情 `#noteContainer` 下**有两份作者栏**：`#noteContainer > .author > .author-wrapper`（尺寸 0×0，藏着）和右侧互动区 `.interaction-container > .author-container > .author-wrapper`（看得见）。两份都是 `.info`（头像、`a.name`）+ `.note-detail-follow-btn`。评论区每条评论也有 `.author-wrapper`，但里面是 `.author` + `.comment-menu`，没有 `.info`。
  - 视频播放器是 xgplayer：`.media-container > .player-container > .player-el.xgplayer > video`，`src` 是 `blob:https://www.rednote.com/…`（MSE，同源）。`captureStream()` 给出音轨和画面轨；视频**静音自动播放时，取到的声音照样有**（响度 0.55，取消静音 0.49）；画到画布上画布仍然可读。用和录制脚本相同的画布 + WebAudio + MediaRecorder 录 3 秒：504 KB 的 MP4，文件头里画面、声音两条轨都在。
  - **放到结尾时不报"播完"**：时长 23.767 秒的视频停在 23.609 秒（缓冲区到 23.683 秒），`paused=false`、`ended=false`、`readyState=2`，等了 7 秒也没动。没有 `loop`。
  - 页面标题是"<笔记标题> - rednote"（xiaohongshu.com 上是" - 小红书"）。浮层打开的网址是 `/discovery/item/<ID>`（不一定带 `xsec_token`）；用户截图里是 `/explore/<ID>?xsec_token=…`。
- **① 收藏按钮看不见的根因**：`scanDetail` 用 `container.querySelector('.note-detail-follow-btn')` 取第一个"关注"——正是藏起来的那份，按钮被一起藏了（11-03 的 e2e 仿页面只有一份作者栏，所以没测出来）。修复：取 `.author-wrapper:has(> .info)` 里**看得见的那份**（`getClientRects().length > 0`），按钮插在它的"关注"前面、`margin-left: auto` 贴着"关注"；没有"关注"（自己的笔记）时放在这一栏末尾；都看不见时退回第一份。窗口宽窄变化时重新扫一遍（两份可能互换）。弹窗、校验、写入都不变（11-03 已有）。
- **② 片段录制注入小红书**：同一个 `content-clipper`，manifest 里 YouTube 与小红书写在**同一条** `content_scripts` 里（e2e 的 mock 站点两边都匹配，分两条会注入两次）。脚本按网址判断站点（`xhsPath`）：
  - 视频：`#noteContainer` 里播放器的 `<video>`（`.player-container` / `.xgplayer`），找不到播放器时退而取笔记里的 `<video>`；不止一个时取画面最大的。"视频 ID"是笔记 ID（网址是笔记详情时），网址不再是这篇笔记（关掉浮层、站内跳走）= 换了视频，这一段结束并保存。
  - 标题：页面标题去掉" - 小红书 / - rednote"（只用来显示和起文件名，与 YouTube 同样的红线）；没有标题时文件名用 `xhs-<笔记ID>`。
  - 不提供字幕烧录：小红书的视频没有单独的字幕层（字幕若有，是做在画面里的，原样录下）。侧边栏不显示这个选项并说明原因。
  - 没有广告判断（笔记详情里没有插播广告）。
  - 侧边栏状态：不是笔记详情 →"这个页面不是笔记详情：打开一篇视频笔记再录"；图文笔记（没有视频）→"这篇笔记里没有视频（图文笔记录不了）…"（`clipUnavailable`，纯函数）。YouTube 的判断不变。
  - 录制记录多两项：`site: 'xhs'` 与笔记链接 `url`。站点由**后台按发消息的页面**定（`fromXhsPage` 优先），不信记录自己写的；小红书的记录要求笔记 ID 是 24 位十六进制、链接是小红书网页版的这篇笔记，链接只留 `xsec_token` / `xsec_source`（与收藏同一个 `canonicalXhsUrl`）。YouTube 的记录形状不变（不加 `site`），旧记录照读。"最近录过的片段"里标"小红书 ·"，点标题回到这篇笔记（没有按时间打开的地址）。链接取开始录制时的网址：关掉笔记后再手动保存也对得上。
- **两处对 YouTube 也生效的改动**（`decideClip`，纯函数）：
  - **卡住算缓冲**：在播放（没暂停、没在跳转）但进度 1 秒没动（`CLIPS.stallMs`）→ 暂停录制，状态"缓冲中…"。原来只看 `readyState ≥ 2`，缓冲时可能录进一段定格画面；YouTube 缓冲时最多录进约 1 秒定格。
  - **卡在结尾算播完**：卡住、且离结尾不到 0.5 秒（`CLIPS.endSlackSec`；实测差 0.16 秒）→ 自由录制结束（"视频播完了"），时间段录制按到终点结束。开录时已停在结尾也按"已经播完了"拒绝。不这样的话，小红书的视频放完后会一直录最后一帧，直到单段上限。
- **画面读不到时说人话**：开录前把视频画到 1×1 的画布上读一个像素，读不了（跨站且没放行的视频）就停下说明"视频来自别的网站，没有放行"，不靠 `captureStream()` 抛错后的"可能受版权保护"。YouTube 与小红书现在都是同源 `blob:`，正常走不到这里。
- **红线**：CLAUDE.md §1、§2 补了"小红书视频笔记的片段录制"（同日，请用户过目）：与 YouTube 片段录制同样的约束；按时间段截取时会把这个视频跳到起点并播放（改动的是播放器状态，不点击小红书的任何按钮）；网络出口不变。构建检查加两条：录制脚本只能有一处 `.click()`（它自己不放进页面的下载链接），不得 `dispatchEvent`、不得碰页面的本地存储。没有新增权限。
- **放弃**
  - 用 `chrome.tabCapture` 录整个标签页再裁出视频区域：要新增权限，会录进页面上的弹窗和鼠标，和 YouTube 的做法不一致；同源 `blob:` 流直接可录，没必要。
  - 把收藏按钮放在视频画面上（像卡片那样悬停出现）：会挡住播放器的控件；用户截图指的就是"关注"旁。
  - 识别 xgplayer 的"播完"事件：要读页面环境里的播放器对象（需要新的页面内助手）；"卡在结尾"的判断不依赖播放器实现，也顺带修了 YouTube 缓冲时的定格。
- **测试**：单测 +5 组（小红书页面标题、`xhs-` 文件名、不是笔记详情 / 图文笔记的说明、`atVideoEnd`、卡住当缓冲 / 卡在结尾算播完（含时间段、暂停与后台优先）、小红书记录的校验（链接与 ID 对得上、只留两个参数、站点由后台定、伪造域名与对不上的链接拒收）、后台记下小红书片段）。e2e：仿小红书的笔记详情改成实测结构（藏起来的 `.author` + 互动区作者栏 + 评论区作者栏），核对"收藏"在看得见的那份里、紧挨"关注"、不进评论区；新增视频笔记（同源 WAV）：图文笔记的说明、标题与不提供烧录、图标 REC、倍速 0 模拟卡住时不计时、停在结尾前 0.2 秒自动结束并保存（文件名、格式、时长、声音）、记录带 `site` 与带 `xsec_token` 的链接、清单标"小红书 ·"、页面原样未动、小红书元素没被点到、关掉笔记（站内跳走）自动结束并保存；冒烟测试核对录制脚本的注入范围。
- **顺带修的测试**：多语字幕一节"勾选印尼语"用的是 Playwright 的 `check()`——它点完立刻核对勾选状态，而这个勾选框要等页面里的脚本回话后才变，两者赛跑（本次 4 轮 e2e 里有 2 轮在这里失败，与本次改动无关的代码路径）。改成点击后等预期结果，再核对勾选框保持勾上。
- **日后替换**：小红书改版时改 `content/clipper.ts` 的 `XHS_PLAYER_VIDEO` / `XHS_ANY_VIDEO` 与 `content/xhs.ts` 的 `detailAuthorRow`。

## 44. eMails：文章汇总邮件的解析、评分与收藏（2026-11-04，用户要求，规格外新增）

- **需求**：导航栏与"找片""发现""豆瓣""小红书"平级新增"eMails"，辅助筛选邮件里的长篇科技博客汇总（如 Medium Daily Digest）：① 自动提取当前邮件的文章列表与元数据；② 每篇打 0–10 分并附简短理由（0 = Slop，10 = 值得精读）；③ 复用小红书的收藏逻辑与数据结构，一键收藏。
- **红线核对**：无冲突，CLAUDE.md §1、§2 补了 eMails 的功能与约束（同日，请用户过目）。
  - OAuth 只申请 `youtube.readonly` → 不能用 Gmail API，只能读页面（用户截图里也是 Gmail 网页版）。
  - 网络出口不变：Gmail 只进内容脚本 `matches`（`EMAIL_PAGES`），不进 `host_permissions` / `connect-src`；文章内容只发给已选定的 LLM。
  - 数据最小化：只发文章的标题、摘要、作者、刊物、站点名、阅读时长、互动数。
- **外部事实（2026-11-04 用用户的真实邮件核实，Gmail 连接器只读取 HTML；样本没有进仓库，e2e 夹具是虚构内容）**
  - Medium Daily Digest 的 HTML 约 77 KB，15 篇。每篇的结构：作者链接（头像 + 名字）、"in"、刊物链接（可能没有）→ 配图链接（`alt` 是**完整标题**）→ 标题链接（`<h2>` 标题、`<h3>` 摘要，都可能被 Medium 截断加"…"）→"Member-only content"图标、"8 min read"、`alt="Claps"` 图标 + 数字（"1.3K"）、`alt="Responses"` 图标 + 数字（没有回应时没有这一项）。
  - **每个链接都带 `?source=email-<用户 ID>-…`**，退订链接带 `token`：能认出收件人，显示、保存前必须去掉，发给大模型时干脆不带链接。
  - 大小离 Gmail 的截断线（约 102 KB）不远：`sizeEstimate` 约 98 KB，所以要检测截断并说明。
  - 用户的 Gmail 开着**分栏阅读窗格**：打开邮件时网址不变（`#search/…` 不动），用线程 ID 拼的深链显示空白（"无法找到您请求的会话"）。所以不能靠网址判断换了邮件。
  - 邮件列表的 class（`tr.zA`、`yO`）与多年来一样，邮件视图的 `.a3s` / `h2.hP` / `.gD` / `.iX` **没有在真实页面上读到**（核实时没能打开邮件，见下"核实时的失误"）；这是最大的未验证项，列在 README 手测清单与已知限制里。读不到时界面说明（`unreadable`），不静默。
- **核实时的失误**：在 Chrome 里点开邮件时，点击落在了悬停才出现的"归档"按钮上（截图坐标是页面坐标的 0.8 倍，算错了），把用户的一封 Medium Digest 归档了。Gmail 连接器是只读的，加不回 `INBOX`；没有再回界面操作，已告知用户手动"移至收件箱"。之后的核实只用连接器只读取 HTML。**日后要看真实 Gmail 页面，让用户自己打开邮件，脚本只读，不在邮箱里点击。**
- **读邮件的方式**：内容脚本 `content-email.js`，**完全被动**：只回答侧边栏的 `getState`，没有 MutationObserver、没有定时器、不用扩展存储。侧边栏 eMails 页开着时每 1.5 秒问一次（`EMAIL.pollMs`），这是分栏阅读下唯一可靠的换邮件信号；这一页不开（或设置关闭）时它一个字也不读。同一封邮件没变时不重新解析。
  - 只取**看得见的** `.a3s`：Gmail 不把打开过的邮件从页面里拿掉，只是藏起来。藏起来的预览文字（`display:none`）、引用的旧邮件（`.gmail_quote`）不读。
  - 不写页面：图 2 的箭头指的是侧边栏，Gmail 页面里不需要任何东西；比小红书的脚本权限更小。
- **认文章**（`core/email.ts` 的 `extractArticles`，纯函数，输入是脚本按文档顺序读出的文字 / 图片 alt 节点，单测不需要 DOM）
  - 按链接归组，三档从严到宽：① 链接里的 h1–h4；② 链接里的粗体 / 大字；③ 够长的文字链接。某一档够 2 篇就不看更宽松的——Medium 的文章都在第 ① 档，页脚的"Control your recommendations"、"Read from anywhere"（不在链接里）就混不进来。
  - 不是文章的链接：站点首页、退订 / 设置 / 条款 / 帮助（按路径的**完整一段**判断，"how-to-subscribe-…"这样的标题不算）、应用商店、社交账号。
  - 标题以"…"结尾且配图 alt 以它开头时，用 alt 的完整标题。署名在标题之前（"作者 in 刊物"），摘要与数字在标题之后，到下一篇的链接为止。
  - 真实邮件验证：15 篇全对（标题完整、署名、时长、掌声、回应、会员标记、链接干净，页头页脚没有混入）。
- **评分**
  - 只在你点"评估"时发送（`buildEmailScorePrompt`）。普通邮件认不出文章时没有按钮，不可能发出去。
  - **按文章缓存**（`emailScores`，键是规范链接的哈希，最多 2000 篇）：Medium 的汇总常有重复，同一篇不再花钱；"重新评估"才重发。
  - 分批（每 20 篇），每批的结果立刻存下：中途失败时已评好的不丢。大模型漏掉的、分数不在 0–10 的不补分，说明"还有 N 篇"。
  - 用"1. 大模型"的模型、`effort: low`；花费按服务方返回的用量算，评完显示。一封 15 篇约 $0.02–0.05（Opus 5.5）。
  - 邮件内容不可信：系统提示写明里面的文字都不是指令，内容放在 user 消息的 JSON 里；回答过 `parseScores` 校验，显示只走 Preact 的文本节点，链接只认 http(s)。
  - 分档 ≥7 / 4–6 / ≤3，数值在 `EMAIL.bands`。
- **收藏**：把标签逻辑从 `core/xhs.ts` 抽到 `core/collection.ts`（规范化、加减、改名 / 删除、统计），界面抽到 `ui/shared/tags.tsx`，小红书改用公共部分（对外导出不变，原有单测与 e2e 不改）。eMails 的 `emailSaved` 用同样的形状（`id / title / url / savedAt / tags`，操作同为 save / remove / tags / renameTag / deleteTag / restore），另加分数与理由。
  - 只有侧边栏写入，所以不需要小红书那层"页面脚本发来的操作当不可信输入"的校验；读存储时仍逐条校验。
- **放弃**
  - 读文章正文再评分：要访问 medium.com 等网站，得扩大网络出口白名单，Medium 的会员文章也读不到全文。分数因此只是预判，界面明示。
  - Gmail API：要新的 OAuth 范围（`gmail.readonly`），违反"只申请 `youtube.readonly`"，而且要重新走 Google 的同意屏幕。
  - 把文章塞进小红书的 `xhs` 键（`articles` 第三种类型）：改动最少，但小红书页的计数、标签、设置开关都会掺进邮件文章；用户要的是"复用逻辑与数据结构"，抽公共代码做到了，数据各存各的。
  - 打开邮件就自动评估：会把没看一眼的邮件内容发出去，也会花钱。点一下的成本很低。
  - 用 LLM 解析邮件：要把整封邮件发出去，违反数据最小化；本地规则可测试、不花钱，认不出时明说。
  - 把用户的兴趣画像发给大模型做个性化：用户要的是内容价值，不是"合不合胃口"；数据也更少。
  - 在 Gmail 页面上给文章标分数：要改动邮件内容，图 2 也指向侧边栏。
- **测试**：单测 +33（链接规范化、Medium 结构、三档识别、普通邮件、发给大模型的内容、回答校验、缓存、分批、部分失败、收藏与标签、存储校验）；e2e 用仿 Gmail 页面（分栏阅读、藏起来的上一封、预览文字、改版后的 class）+32 项，包括"DOM 没有任何变化""没有点击""页面上没有发出请求""发给大模型的内容不含链接 / 主题 / 发件人 / 收件人""普通邮件的内容没有发到任何地方"；冒烟测试核对注入范围与网络出口不变。
- **发现的已有问题**：做这一节时发现设置页 22 项设置存不上，同日修复，见 §45。
- **日后替换**：Gmail 改版时改 `content/email.ts` 的 `GMAIL`；支持别的邮箱时加进 `EMAIL_PAGES`，并按站点换选择器；新的汇总版式加进 `extractArticles` 的档位或单独写一份解析。

## 45. 设置页 22 项设置存不上（2026-11-04，用户确认修复）

- **现象**：设置页的开关改了不生效：取消勾选后看起来变了，重新打开设置页又回到原样，不报错。涉及模型名（2 项）、语音（2）、评分学习（2）、观看追踪、每日总结、周报、导师提醒、X（2）、新博主、豆瓣（3）、片段（3）、小红书（3），共 22 项。产品原则"所有自动行为可关闭"在设置页上没有兑现，"模型名可改"也没有。这个写法从第一版（2026-10-24）就有。
- **根因**：`onChange={(e) => updateSettings((s) => ({ ...s, xhs: { ...s.xhs, enabled: e.currentTarget.checked } }))}`：`e.currentTarget` 在回调里读，而回调要等 `navigator.locks` 拿到锁才运行。那时事件已经派发完，`currentTarget` 是 `null`，抛 `Cannot read properties of null`，整个写入作废；`void` 又把这个错误吞了，界面上什么也看不出来。
- **修法**：加 `updateSection(key, patch)` 与 `updateModel(provider, raw)`，参数在调用时就算好，写不出这种 bug；22 处加 eMails 的开关都换成它们。自动字幕、多语字幕的设置一直走 `set(...)`，同样是当场取值，不受影响。
- **为什么 e2e 没发现**：e2e 只在设置页上看勾选状态、改设置时直接写存储，没有真的点这些开关；也只听设置页的控制台错误，未捕获异常属于 `pageerror`，没听。
- **关掉后功能真的会停吗**：这些开关以前从没生效过，所以逐项核对了使用方：20 个开关都有门控代码；`tracking`、`clips`、`douban`、`reminder`、`xhs` 的关闭路径已有测试，总结、周报、X、新博主、评分学习读过代码，没有另加测试。
- **放弃**
  - 改 `Store.update` 让回调同步运行：读改写必须在锁里，不能动。
  - 22 处逐行先读到变量里：同样能修，但下一个新开关还会写错。
  - 把 `void` 去掉、在界面上报错：能让错误看得见，但治标；设置写入失败现在只可能是存储出错。
- **测试**：e2e 新增"设置页：每一项都存得上"：遍历设置页所有勾选框（28 个，以后新加的也会被覆盖；"优先本机识别"只在选浏览器识别时显示，所以先切过去），点一下核对存储变了，再点一下核对复原；语音语言与两个模型名单独核对（清空后回到默认模型）。设置页补了 `pageerror` 监听，回调里的异常会让 e2e 失败。
- **测试时碰到的两个时序问题**（都不是这次的产品 bug）：① 模型名的输入框值跟着存储走，刚存完时界面还要重绘一次，自动化输入快过重绘就会被盖掉（实测不等时 25 轮只过 12–18 轮，两次写入前各等 200 毫秒 25 轮全过），e2e 已按此等待，人的手速碰不到这个窗口。② 多语字幕"按 C 打开原生字幕"那一项偶发失败（这次 7 轮完整运行里 1 次，同样的代码重跑就过）：测试只播 2000 毫秒，判定却要实际播满 2 秒，机器忙时差一点；是已有问题，没有改。
- **用户能感觉到的变化**：从这一版起这些设置真的会生效。关掉的功能会停，改过的模型名会被用上。之前点过的不算数，要重新设一次。

## 46. GitHub Actions CI（2026-11-04，用户要求）

- **选了什么**（2026-11-11 起拆成几个 job 并行，`verify` 只汇总结果，见 §61）：`.github/workflows/ci.yml` 只有一个 job `verify`，依次跑 `npm ci`、`npm run setup`、类型检查、单元测试、装 Chromium、e2e（含正式版冒烟），与 `npm run verify` 检查内容相同。`main` 加分支保护：必须走 PR（0 个审批，不要求 review）、`verify` 必须通过，管理员不例外，禁止强推和删除。
- **参考 IPCountryWatcher，沿用的**：只读权限、`persist-credentials: false`、Action 固定到 commit SHA、同分支新提交取消旧运行、超时限制、`if: always()` 上传诊断结果。
- **为什么分支保护是必须的**：IPCountryWatcher 的 `main` 没有分支保护也没有 ruleset，CI 红了照样能合。工作流本身只会报告结果，真正挡住合并的是必过项。管理员不例外，因为这个仓库的管理员就是唯一的使用者，否则这道挡板对谁都不起作用。
- **为什么还要"必须走 PR"**：只设必过项时，已经通过检查的提交仍能直接 push 到 `main`，挡不住绕过 PR。审批数设为 0：一个人的仓库不需要审批，但每个改动都要经过 PR。
- **实测（2026-11-04）**：临时 PR 里放一个故意失败的测试，`verify` 失败在单元测试这一步后，管理员合并被拒绝（HTTP 405）。在另一个配了同样规则的临时分支上，管理员直接 push 一个已通过 `verify` 的提交被拒绝（GH006）。两者都已删除，探针测试没有进 `main`。
- **为什么跑在 `windows-2022`**：和日常开发同系统，`npm run verify` 本地过了基本等于 CI 过；e2e 依赖真实 Chromium 的音频、录制与下载，事先只在 Windows 上验证过。公开仓库的 Windows runner 也免费。
- **触发条件**（2026-11-06 起只跑 PR 和 `main`，见 §48）：所有分支的 push，加上指向 `main` 的 PR，代价是 PR 分支每次 push 跑两遍。两次检查的对象不同：push 查分支本身，PR 查与 `main` 合并后的结果。
- **密钥**：构建需要 `local/manifest-key.txt`，CI 用 `npm run setup` 现场生成，只活在这台 runner 上，不需要任何 Secret。这个密钥对应的扩展 ID 与本机的不同，所以 CI 只验证，不产出可安装的包。
- **放弃**
  - 路径过滤（IPCountryWatcher 有）：设成必过项后，被过滤掉的 PR 不产生 `verify`，会一直等下去。
  - 发布 job（IPCountryWatcher 有）：CI 的包用临时密钥，扩展 ID 不对，OAuth 也走不通，发布出来没用。
  - `ubuntu-latest`：快一些，但公开仓库两种 runner 都免费，e2e 也没在 Linux 上验证过，日常开发又不用 Linux。
  - 用 `npm run verify` 一步跑完：内容一样，但红了看不出是哪一段。
- **日后如何替换**：换系统只改 `runs-on`（Linux 需加 `playwright install --with-deps`）。改 job 名要同时改分支保护的必过项，否则所有 PR 都会卡住。不想要这道挡板时，在仓库 Settings → Branches 删掉 `main` 的规则，工作流照常运行。

## 47. eMails：每次评估后的总体结论（2026-11-05，用户要求）

- **需求**：用户的截图里 15 篇文章全部评完，"值得精读"是 0，界面只有一句"这一档没有文章"，看不出这封邮件整体怎么样、为什么一篇都没有。要求：① 每次评估后给一段简短的总体结论，概述整体质量；② "值得精读"是 0 时明确解释原因。
- **红线核对**：CLAUDE.md §2 写的是文章内容"只在我点'评估'时"发给 LLM，"只发标题、摘要、作者、刊物、站点名、阅读时长、互动数"。这次有两处超出字面，都不增加用户数据的外发，已写进 CLAUDE.md，用户 2026-11-06 确认同意：结论这一步多发了分数和理由（都是大模型自己写的）；多了一个"生成总体结论"按钮（同样是用户亲手点才发）。
- **分两层**：
  - **本地层**（`verdictHeadline`、`verdictFacts`）：一句话和分数分布，由 `digestStats` 算，不花钱、不会出错、不依赖大模型。"值得精读"是 0 时直接写"最高 6 分，离精读线（7 分）还差 1 分"——这是能确定的那部分原因。
  - **大模型层**（`buildEmailVerdictPrompt`，`EMAIL_VERDICT_SCHEMA`）：`summary` 概述整体质量，`whyNone` 解释为什么没有精读。统计数字由本地算好发过去，并告诉它不要改：标题、理由来自不可信的邮件内容，界面上的数字不能被大模型或邮件里的文字影响。
- **单独一次请求，排在所有批次之后**：结论要看这封邮件的全部文章，包括之前评过、这次没有重发的。放进评分请求的话，分批时每批各有一段，缓存命中的文章也看不到。多一次请求约 $0.01，只发标题、分数、理由，比重发一遍摘要更省、数据更少。
- **按"文章 + 分数"存**（`emailVerdicts`，键是 `verdictKey`，最多 200 份）：关掉侧边栏再回来还在。分数一变（重新评估、在别的邮件里重评过同一篇）键就对不上，旧结论不再显示，不会出现结论和分数打架。不按邮件主题存：主题不该落进这份数据，同一批文章出现在两封邮件里，结论也确实是同一份。
- **什么时候显示**：评过的文章 > 0，且全评完了或已经有对应的结论。还有文章没评时不显示：只评了 1/2 篇就说"没有值得精读的"是错的。大模型漏评（`missing > 0`）时照样写，标题改成"已评的 N 篇里……"。
- **`whyNone` 是必填项**：0 篇精读时大模型没写原因，按没写成处理（`parseVerdict` 返回空），不存半截结论，界面报错并留着"生成总体结论"。这是用户明确要求的内容，不能静默缺失。
- **结论失败不影响分数**：`scoreArticles` 不抛出，放在 `verdict: 'failed'` + `verdictError`，界面用 ErrorBox 说明。分数已经花钱评好了，不能因为最后一步失败而让人重来。
- **"生成总体结论"按钮**：截图里的情况是分数已有、没有结论（这个版本之前评的，或文章全在别的邮件里评过）。没有这个按钮，用户只能点"重新评估"，全部重新花钱，分数还可能变。
- **"值得精读 0"这一档**：空列表提示改成"这封邮件没有值得精读的文章，原因见上面的总体结论"，结论面板就在筛选按钮上方。
- **放弃的方案**：
  - 只用本地规则写结论：不花钱，但说不出"这些文章缺什么"，用户要的是解释，不是把数字再念一遍。
  - 在评分请求的 schema 里加 `summary`：分批和缓存都解决不了，见上。
  - 打开邮件时自动生成结论：违反"点了才发"，也花没看一眼的钱。
  - 让大模型把分数也算一遍再解释：数字可能和筛选按钮对不上；本地算才可靠。
  - 给邮件整体打一个等级（好 / 中 / 差）：阈值是拍脑袋的，一句话加分数分布已经够判断。
- **日后替换**：结论的写法只改 `buildEmailVerdictPrompt`；想换成读正文之后再总结，改 `writeVerdict` 的输入，`verdictKey` 和界面不用动。
- **测试**：单测 +19（统计、一句话、指纹、回答校验、发送内容、指令注入、截断、分批只写一次、覆盖之前评过的、0 篇精读、缺原因、请求失败、漏评、全缓存、单独生成及其失败路径、分数变了旧结论失效、导出、上限）；e2e 用一封全部评过且没有精读的仿邮件走完截图里的场景，并核对结论请求不含链接、主题、发件人、作者和摘要。原有 e2e 的请求次数断言相应改了（评估现在是"评分 + 结论"两次请求），没有删除任何检查。

## 48. 成本优化：最大限度消除不必要的花费（2026-11-06，用户要求）

起因：X 通知 2026-11-22 起 expansions 带回来的对象按标准价计费。核实后代码本来就不发 `expansions`（§20），这次变化不影响账单，但顺着查下来发现了真正的漏洞。

- **外部事实（2026-11-06 核实）**
  - X：邮件与[开发者社区公告](https://devcommunity.x.com/t/inform-x-api-ppu-expansions-update/279110)：11-22 起 post / user / media / poll / place 走 expansions 也计费，$0.005 / $0.010 / $0.005 / $0.005 / $0.005。官方定价页没有从搜索结果确认到，以邮件为准。
  - Anthropic（claude-api skill，2026-10 缓存）：Opus 5.5 $4/$20、Haiku 5.5 $0.10/$0.50（100K token 以内）；两者思考默认开启，思考算输出 token；`effort` 都支持。
  - Chrome 内置大模型（Prompt API）[只支持 en、ja、es、de、fr](https://developer.chrome.com/docs/ai/prompt-api)，不支持中文：写不了中文总结，**不用**。
  - Chrome Translator API：Chrome 138+ 稳定，[语言包按需下载](https://developer.chrome.com/docs/ai/translator-api)，第一次下载要用户操作。**实测（Playwright 自带 Chromium，UA 156）**：扩展 service worker 里有 `Translator`，`availability()` 返回 `downloadable`；此时 `create()` 既不成功也不报错（等了 20 秒），所以后台必须先查 availability，并加超时。品牌版 Chrome 156 不接受 `--load-extension`，没能在真实 Chrome 的后台验证；语言包下载后后台能否使用是**未验证假设**，列入 README 打卡清单。
- **改动前实测的漏洞**（同一份脚本 `tests/unit/cost-scenarios.test.ts` 在改动前后各跑一遍，设 `COST_REPORT` 输出 JSON）

| 场景 | 改动前 | 改动后 |
|---|---|---|
| 大模型一直返回坏结果，后台一天 48 次检查 | 48 次付费调用 | 2 次，然后停下等你手动 |
| 手动生成后没有新观看，再点两次、到点再补算 | 4 次 | 1 次 |
| 一周只有一个低分 | 1 次 | 0 次（一个案例看不出共性） |
| 没填大模型 Key 就刷新热点 | 读 X 2 次，白花 $0.15 | 不读 X |
| 大模型失败 3 次后成功 | 读 X 7 次，$0.50（到预算上限） | 读 X 2 次，$0.10 |
| 第二个主题被限流 | 已付钱的帖子全丢，没有结果 | 第一个主题的帖子照常整理，注明没查完 |
| 响应在路上丢了 | 账上 $0 | 账上 $0.05（按最坏情况） |
| 同一句口令提交 5 次 | 5 次 | 1 次，回显标"缓存" |
| 模型 / 输出上限 | 全部 Opus 5.5 / 16000 | 后台与批量任务 Haiku 5.5 / 每类单独上限 |

- **每月大模型花费估算**（`LLM_TASKS.typical`：一天 5 句口令、1 份总结、1 次热点、1 封 15 篇的邮件，token 数是估计值，不是账单）：全用 Opus 5.5 约 $7.81；默认分档约 $3.69，其中理解口令 $3.42；全部省钱模型约 $0.19。X：每天打开一次"发现"的旧默认约 $9/月（到预算上限 $15）；现在不点不花，每天点一次约 $6/月。
- **先预扣、后结算（`core/spend.ts`）**：大模型、X、字幕共用一套规则。请求发出前把最坏情况写进持久账本，结算三种结果：知道用量按实际记；服务方明确拒绝（4xx/5xx，没有计费）退回；不知道（超时、断网、响应读不出来、页面被关）按预扣额记成"未确认"。因为预扣在 `chrome.storage` 里，页面被关、service worker 被回收都绕不过预算。字幕原来的预留只在内存里，一样换成这个。
  - 放弃：只在请求后记账（原 X 的做法）：响应丢了就是 $0。放弃：中断的预扣超时后自动退回：钱可能真的花了，宁可本地数字偏高。
- **新增大模型每日上限（`llm.dailyBudgetUsd`，默认 $0.50，不含字幕）**：之前除字幕外完全没有上限，也看不到花了多少。顶部加 `AI $` 条，错误类型 `llm_budget`。预算按本地日计。
- **任务分档（`LLM_TASKS`、`llm.economyModels`、`llm.taskTiers`）**：总结、周报、热点、eMails 打分与结论默认 Haiku 5.5（约 Opus 5.5 的 1/40）；理解口令、归纳兴趣簇留在主模型，因为后面的一切都依赖这两步，而换模型后的质量没有用真实调用验证过（本次不能调付费服务）。全部可在设置页逐项改，并显示每月估算。
- **每类调用有输出上限**：原来全是 16000，一次截断在 Opus 上就是 $0.32，也没法预扣。上限留了余量（思考算输出）；真不够时报"输出被截断"，调 `LLM_TASKS` 即可。
- **不盲目重试**：SDK 的自动重试关掉，它在超时后也会重发，可能付两次钱。只有服务方明确拒绝（408/409/429/5xx）且等待不超过 5 秒时自己重试一次；OpenAI 的额度问题不重试。
- **例行任务失败不再每 30 分钟重来**（`nextJobRetry`）：已计费的失败再试一次就停，等你手动；没计费的失败隔 2 小时起翻倍，最多 24 小时；到了预算等明天；没填 Key 不花钱，下一次检查就再试。记录页写明下次什么时候试或已经停止。
- **取消没有价值的调用**：观看记录和目标没变就不重新总结（`inputKey`，"仍要重新生成"可以强制）；到点补算手动版时同样跳过；周报低分少于 2 个不调大模型（少了"只有一个低分时的建议"，这是取舍，一个案例谈不上共性）；同一句口令在缓存时间内不再理解（"重新理解"强制；兴趣簇、纠正、模型变了自动失效）；读到的帖子和上次相同就不再整理。
- **X 热点**：`autoRefresh` 默认改为关，旧设置迁移一次（`x.defaultsVersion`），打开"发现"页不再花钱。这是用户可见的变化：要新热点得点一下，想恢复自动在设置页打开。每主题从 15 条降到 10 条：X 的最小值，也正好是每个主题交给大模型的候选数，多读的 5 条只用来挑互动高的。一次刷新最多 $0.20（原 $0.30）。先确认大模型 Key 和预算再读 X。读到的帖子存草稿（`hotspotDraft`），大模型失败、页面被关后下次直接用；某个主题失败时已读到的照常整理。200 但响应读不出来不再当成 0 条。测试守着请求参数，不让 `expansions` 混进来。`X_API.timeoutMs` 防止挂住的请求一直占着锁。
- **字幕翻译默认用 Chrome 本地翻译（`translationEngine: 'local'`）**：免费、文字不离开电脑，不需要新权限，走 service worker。代价：质量一般、没有上下文。语言包没好时说明原因、第二行留空，**不**悄悄改用收费的大模型（红线：不静默降级）。覆盖了 2026-11-01 用户选的"默认翻译用 Haiku"：大模型翻译仍在，选一下就回来。
  - 放弃：offscreen 文档：要加权限，service worker 够用。放弃：放在内容脚本里翻：语言包状态按来源隔离，YouTube 页面上没有用户操作时下载不了。
- **新博主发现的断点续跑**：搜到的结果存 `week.pending`，后面一步失败时不重搜，每周 8 次 search 不会因为一次网络错误用光。
- **其他失败恢复**：YouTube、豆瓣请求加 30 秒超时（之前挂住的请求会让例行任务的锁永远不释放，后台还被保活）。
- **CI**：只在 PR 和 `main` 上跑（取代 §46 的"所有分支 push"；2026-11-11 起 `main` 上那一次在内容已经验过时不重跑，见 §61）。仓库是公开的，Actions 本来就免费，省的是等待：每次 push 从两遍 10 分钟变成一遍。通过的运行不再上传产物，保留 7 天。代价：没开 PR 的分支不自动检查，本地 `npm run verify` 仍是提交前的要求。
- **没做的**：Prompt caching：提示词都短于可缓存门槛（512–4096 token），且一天调用几次，缓存早过期了。Message Batches：便宜一半，但要轮询，也不支持 `fallbacks`，省下的不值这个复杂度。找片失败后复用 search 结果：只是 YouTube 配额（免费），失败也少见。本地规则代替大模型理解口令：规则只认约束，检索词扩展（中英文）靠大模型，质量差异验证不了。
- **日后如何替换**：改分档看 `LLM_TASKS`；改重试节奏看 `JOB_RETRY`；预扣逻辑都在 `core/spend.ts`；换翻译方式看 `services/local-translator.ts`。

## 49. 多语字幕默认关闭，旧设置作废（2026-11-06，用户要求）

- **现象**：用户反映多语字幕默认是打开的。
- **原因**：代码默认值一直是关（`autoOn: false`），但用户 Comet 里存的设置是 `autoOn: true`（只读取了这一个值核实），存下的值盖过默认值。用户主要在 Comet 上用这个扩展（Chrome 的 Profile 2 几乎没有数据）。
- **选了什么**：换成新键 `autoShow`（默认关），旧键丢弃，与 §33 把 `autoStart` 换成 `autoStartNoCaptions` 同一做法。设置页的勾选项保留：重新勾选算你主动打开，之后不会再被改掉。
- **为什么不用版本号迁移（§48 的 X 设置那样）**：内容脚本直接读原始设置，不经过 `mergeSettings`；换键两边都自然生效，不用再写一份迁移。
- **放弃**：删掉"自动显示"选项：用户说的是"除非用户主动打开"，这个勾选本身就是主动打开。
- **顺带发现**：用户主要在 Comet 上用，而 §48 把字幕翻译默认改成了 Chrome 本地翻译。Comet 能否下载语言包没有验证；下载失败时界面说明原因，用户改选大模型翻译即可。

## 50. Capture：一键把当前这一帧存成无损 PNG（2026-11-06，用户要求）

- **需求**：在"片段 → 录制片段"里加一个 Capture 按钮：按视频源的真实尺寸截下当前画面，存成无损 PNG，按"标题_时间戳_original_序号.png"命名，不弹"另存为"，直接进下载文件夹。
- **红线变更（用户 2026-11-06 要求，CLAUDE.md §1、§2 同步）**：原红线写着"不提供其他任何下载方式"，注入脚本的白名单里也没有截图。这是用户点名要的功能，存的是一帧、不是音视频流，所以没有停下来再问，按片段录制的同一套约束写进红线：只在点按钮时工作、画布不放进页面、不发网络请求、广告时不截、不绕过 DRM、扩展不留图片。
- **外部事实（2026-11-06 实测）**
  - 真实 YouTube（用户的浏览器，`Whzw29g8gU4`）：`videoWidth×videoHeight` 是 1920×1080，页面上显示 1187×668（`devicePixelRatio` 2.02）。画布按 1920×1080 画，`toBlob` 得到 1.41 MB 的 8 位 RGB PNG，从取帧到编码完约 1 秒；画布 origin-clean、不是黑帧，`getImageData` 读得到。
  - 下载限流（Chromium 自带的 `DownloadRequestLimiter`）。用原始 CDP 驱动真实侧边栏，每条路径点 4 次：页面自己下载（对照）只存下 1 个；录制脚本的 `<a download>`（§36 的保存方式，点击发生在侧边栏）只存下 1 个，其余被拦，而页面上没有任何错误；侧边栏自己的 `<a download>` 4 个全存下，隔 100 毫秒连点 5 次也全存下。
  - 这个限流 Playwright 测不出来：它接管下载时，录制脚本那条路径也全部成功。所以 e2e 只钉死"下载算在侧边栏上"，真实限流的结论来自上面的实验。
- **保存由侧边栏做（与 §36 不同）**：录制脚本截帧、编码，PNG 经 `tabs.sendMessage` 分块传回侧边栏，侧边栏用 `<a download>` 保存。限流按发起下载的页面计，你点击的正是侧边栏，每次点击都重新放行一次。
  - 放弃沿用录制脚本的保存：第二次起被拦，侧边栏却只能显示"已保存"；Capture 正是要连点的功能。
  - 放弃 `downloads` 权限：一样要把字节传出页面（后台 Service Worker 没有 `URL.createObjectURL`，只能经扩展页面），多一项权限换不到什么。§36 放弃它是因为片段有几百 MB，这里 §36 的理由不适用，但侧边栏的 `<a download>` 已经够用。
  - 放弃 `tabs.captureVisibleTab`：截的是页面渲染结果，带播放器控件，尺寸取决于窗口。
  - 代价：要开着侧边栏（按钮本来就在那里），所以没有做快捷键。
- **传输**：runtime 消息只能传 JSON、单条上限 64 MB，所以转 base64，每块 16 MB（`CLIPS.captureChunkBytes`，转完约 21 MB），由侧边栏一块块取。8K 的 PNG 可能超过一条消息，1080p 只有一块。最后一块取走后立即释放；侧边栏中途关掉时 30 秒后释放（`CLIPS.captureHoldMs`）。
- **画质**：画布按 `videoWidth×videoHeight` 建，1:1 绘制，不用 `outputSize` 的 1080 上限（那是给实时编码的）。`alpha: false`，PNG 里没有透明通道。不叠加字幕，"把字幕烧进画面"只影响录制：用户要的是 original。
  - 没有切换清晰度：那要在页面环境里调用播放器的接口，超出红线，用户也没要。"自动"清晰度下存到的就是当时解码出的尺寸，所以侧边栏写出实际尺寸，并提示先调到最高。
- **文件名**：`标题_时-分-秒-毫秒_original_序号.png`，格式照用户给的样例，时间是播放位置（样例里 `00-00-30-804` 落在片段时长之内）。标题清洗沿用 `safeFileTitle`。序号 5 位补零，存在 `captureSeq`，全局递增、加锁，跨视频、跨重启不重号；截成了才取号，广告时点不占号。样例的序号看起来也是跨视频累加的（新文件 00701，两小时前的 00576）。
- **同一拍**：`currentTime` 和 `drawImage` 在同一段同步代码里，文件名里的时间就是这一帧。跳转中（`seeking`）不截：画面还是旧的，时间却是新的。
- **只限 YouTube**：小红书的红线写的是"录制"，用户这次只说 YouTube，所以按钮不显示，脚本也拒绝。放开只要去掉 `!xhs` 和 `checkCapture` 的站点判断，再改红线。
- **录制中也能截**：截图另开一块画布，不碰录制用的那块。
- **不记进"最近录过的片段"**：用户没要；连续截图会把录制记录冲掉（上限 100 条）。下载列表里有文件。
- **没有新增权限**，`manifest` 不变；smoke 里"不用 downloads"的检查照常有效。录制脚本的构建检查不变（仍只有一处 `.click()`，截图不用它）。
- **测试**：
  - 单测：时间戳（毫秒、进位、NaN、超过 99 小时）；文件名（用户的两个样例、非法字符、无标题、Windows 保留名、限长、序号超 5 位）；截图前检查全部分支；base64 往返（超过一次 `fromCharCode` 的上限）；每块转完不超过消息上限；序号的默认值、损坏回退、并发递增。
  - e2e：mock 视频只有声音，现场用画布录一段 1920×1080 的 VP8 当片源，把播放器缩到 320×180。验证：文件名；PNG 文件头是 1920×1080、8 位；像素左红右蓝（是这一帧，不是黑帧）；侧边栏写出文件名与尺寸；再点序号递增；下载算在侧边栏上；广告时拒绝且不占号；录制中能截且不打断；播放器原样未动；没有网络请求；小红书没有按钮。
  - 真实侧边栏（一次性脚本，不进仓库，因为 e2e 测不出限流）：加载 e2e 构建，用原始 CDP 和真实鼠标事件，不碰播放页连点 6 次，下载目录落地 6 个 1920×1080 的 PNG，序号连续。
  - Comet（用户 2026-11-06 手测，装好的扩展）：不碰 YouTube 页面连点 5 次，5 个文件都存下了。
- **没做 / 留给以后**：快捷键；小红书；HDR 的色彩保真；截图记录。

## 51. 多语字幕：调整显示顺序（2026-11-06，用户要求）

- **需求**：侧边栏"字幕"页勾选的语言能调上下顺序，排在前面的显示在上方，调完实时反映到播放器的字幕层，并处理好存储和重置。
- **核实现状**：字幕层本来就按语言列表的顺序走（`resolveSources` → `syncLines`，行序变了就重建），片段烧录读的是这一层的 DOM 顺序，设置页也能调默认顺序。缺的只有两样：侧边栏没有调序的入口；调好的顺序只能留在这个标签页的内存里。所以渲染层没有改。
- **交互：已勾选语言右边的 ↑ ↓。** 设置页已经是这个样子，最多 4 行，最多点 3 下就到位，键盘也能用。
  - 放弃拖拽：4 行的列表省不了几下，却要多写一套拖放状态，还得另做键盘操作。
  - 放弃"按勾选先后排"：想调一次要先取消再勾，这一行还会从播放器里消失一下。新勾的语言排在最后这一点保留。
- **状态分两层，不新增存储键**：
  - 调序和勾选一样，只对这个视频生效，存在内容脚本的 `override`（标签页内存，刷新即回到默认）；界面上写明。
  - 想长期保留就点"把这组语言和顺序设为默认"，写进 `settings.multiCaptions.langs`，随设置导出、清空。设置页同一份数据，两边互通。
  - 重置：沿用"这个视频改回默认"，改名为"这个视频改回默认语言和顺序"。
  - 放弃调序时自动写进默认：会悄悄改掉所有视频，也和"勾选只对这个视频生效"矛盾；这个视频的语言和默认不同时，也说不清该改什么。
  - 放弃按视频持久保存：要加存储键、数量上限、导出和清空，换来的只是回看同一个视频时顺序还在，而常用的是"我总想中文在上"，默认顺序已经够了。日后要加，把 `override` 换成一个 `Store`，再把写入放到侧边栏（内容脚本目前只读设置）。
- **`override` 只放和默认不同的列表**：手动调回和默认一样、或把它设为默认后，这个视频就不算单独选过（`applySettings` 和 `setLangs` 都用 `sameCcLangs` 判断）。否则"改回默认"的按钮会留着，之后改默认这个视频也不跟。
- **语言列表比勾选项长**：默认 `original, en, zh-Hans` 在英文视频上，`en` 和原声重复，`resolveSources` 把它去掉，勾选项里只有两行。如果照勾选项排序或存默认，`en` 就没了，换到韩语 MV 上少一行英文。所以状态里新增 `langs`（完整列表），`moveCcLang` 和"设为默认"都用它：没有行的语言跟着排在它前面的那一行走（`zh-Hans, original, en`），调回去也能和原来完全一样。勾选 / 取消仍按勾选项写（已有行为，没有改）。
- **只在有行的语言之间换位**：这个视频给不出的语言勾着也没有行，没有 ↑ ↓，也不占位置，所以每按一次屏幕上都有变化。
- **颜色和字号跟位置走**（第一行白色、略大），不跟语言走。这是已有规则，顺序的意义正是"谁是主字幕"。
- **键盘焦点**：列表按语言加了 `key`，Preact 换位时会把其中一行重新插入，这一行的按钮就失去焦点。所以等状态里的 `langs` 变成预期的样子后，把焦点放回这一行；挪到头时那个按钮不能按了，落到同一行的另一个按钮。
- **设置页显示语言名**：从侧边栏存成默认的语言可能不在 `MULTI_CC_LANGS` 里（`fil`、`ms`），用 `Intl.DisplayNames` 补上；它遇到 `en-x` 这样的代码会抛错，所以有兜底，显示代码本身。
- **没有新增权限**，`manifest` 不变，也没有新的网络请求：调序不重新取字幕（内存里按轨缓存）。
- **测试**：
  - 单测：换位、到头、新顺序决定字幕层和勾选项的顺序、重复语言跟着走并能调回原样、这个视频没有的语言不算一行、排在最前面的无行语言不动、`sameCcLangs`。
  - e2e（mock 播放器）：暂停时点 ↓，字幕层和文字立刻换位；第一行仍是白色；不重新取字幕；到头的按钮不能按；键盘连按时焦点跟着这一行；调回默认后"改回默认"消失；改回默认；字幕层关着时调序，打开后生效；设为默认后存进设置、设置页跟着变、刷新后还在；在设置里改默认，正在看的视频立刻跟着变；原声与 English 重复时设为默认，`en` 不丢。
- **没做 / 留给以后**：拖拽；按视频持久保存；片段录制的烧录顺序不需要改（读的是字幕层）。

## 52. 片段录制：支持 X 帖子里的视频（2026-11-06，用户要求）

- **需求**：片段录制只认 YouTube 和小红书，用户在 X 的全屏视频页（`/status/<ID>/video/1`）看到"当前标签页不是…"。要把录制脚本注入 X 帖子页，快捷键、文件名、元数据、列表展示与现有平台一致，提示文案把 X 写进支持列表。
- **红线**：这是 TubeMuse 第一次往 x.com 注入脚本。原红线写的是"不抓取 YouTube 或 X 网页做搜索或数据采集"，录你正在看的视频既不是搜索也不是采集，用户又点名要，所以没有停下来再问，按片段录制的同一套约束写进 CLAUDE.md §1、§2（请用户过目）：只在你开始后工作、画布不放进页面、不发网络请求、不点 X 的任何按钮、读取的页面信息只限播放器状态、页面标题和网址。网络出口不变：`x.com` 不进 `connect-src` / `host_permissions`，官方 API 仍是 `api.x.com`。
- **外部事实（2026-11-06 实测，用户的 Chrome，已登录，`x.com/ayoships/status/2117650684774580249`）**
  - 普通视频是同源 `blob:`（MSE），画到画布上读得到，`captureStream()` 给出一条音轨一条画面轨，`mediaKeys` 为空。和 YouTube、小红书同一类。
  - **默认静音自动播放，静音时取到的声音照样有**：`muted=true` 下峰值 0.897。用和录制脚本相同的画布 + WebAudio + MediaRecorder 录 3.5 秒：1.1 MB 的 MP4，文件头里画面、声音两条轨都在，画面不是黑帧。
  - **一页有 3 个 `<video>`**：主帖 720×1280，页面上 286×508，在播；回复视频 518×518，暂停，在屏幕外；回复里的动图 518×377，暂停，在屏幕外。回复的视频**比主帖的大**。
  - **动图（GIF）是跨站的**：`src` 是 `video.twimg.com/tweet_video/…`，不是 `blob:`。`getImageData` 和 `captureStream()` 都抛 `SecurityError`。时长只有 1.47 秒，循环播放。
  - **全屏视图 `/video/1`**：视频在 `[role="dialog"]` 里，页面上 551×980；弹层底下的帖子页还留着另一个 `<video>`（`readyState=0`，被盖住）。直接打开这个网址时视频没有自动播放（`paused=true`，`t=0`）。
  - 在帖子页点视频：第一次取消静音，第二次暂停，不进全屏；全屏视图是从时间线点进去的。
  - **放到结尾时正常报"播完"**：`ended=true`、`paused=true`，一直停着，`loop=false`。不需要小红书那样"卡在结尾"的判断。
  - 页面标题：`X 上的 Ayo O：“I reverse engineered tiktok https://t.co/TEV1YKfAZQ” / X`，全屏视图也一样。正文后面的 t.co 短链是 X 把媒体写成的链接。
  - `twitter.com/…` 已跳到 `x.com/…`。
  - **片头广告没有实测到**：`main.js` 里有帖子的 `prerollMetadata`，播放器在懒加载的分包里，没看到广告怎么显示；这个账号上也没碰到带片头广告的视频。
- **注入范围**：manifest 匹配 `https://x.com/*`，和 YouTube、小红书写在同一条 `content_scripts` 里。不能只匹配 `/status/`：X 是单页应用，从时间线点进帖子不重新加载页面，脚本要在时间线上就注入好。没有写 `twitter.com`（已全部跳转），没有新增权限。
- **取视频（`pickXVideo`，纯函数）**：小红书"取画面最大的"在 X 上会选中回复。依次看：在屏幕上 → 在全屏弹层里 → 正在播 → 播过 → 屏幕里的面积；都一样时取页面上靠前的。不是帖子页时直接不找，时间线上每 100 毫秒不用量任何元素。
- **录制中盯住开录时的那个元素**：YouTube 和小红书用"`videoEl()` 还是这个元素吗"判断换了视频，在 X 上滚动就会变（回复开始播了），一滚就结束这一段。改成只看这个元素还在不在页面上（`isConnected`），加上网址里的帖子 ID。滚开时 X 自己会暂停它，录制跟着暂停，滚回来接着录。`tabState` 在录制中也报告这个元素的位置和时长。
- **视频 ID 是帖子 ID**：`parseXStatusUrl` 认 `/用户/status/ID`（可带 `/video/1`、`/photo/1`）、`/i/status/ID`、`/i/web/status/ID`。网址不再是这条帖子 = 换了视频，这一段结束并保存。
- **文件名与标题**：标题改写成"作者 - 正文"，去掉 t.co 短链；只有视频没有文字时只留作者；"帖子 / X"这类标题不用；没有标题时文件名用 `x-<帖子ID>`。其他语言界面的写法认不出时，去掉结尾和短链后原样用。只读 `document.title`，不读帖子正文的元素。
- **录制记录**：`site: 'x'` 由后台按发消息的页面定（`fromXPage`），不信记录自己写的。帖子 ID 要和链接对得上。链接存规范形式：去掉 `/video/1` 和 `?s=…&t=…`（分享链接的参数会标记分享人）。"最近录过的片段"标"X ·"，点标题回到帖子（没有按时间打开的地址）。
- **不提供字幕烧录**：用户没要。侧边栏说明播放器里的字幕（CC）不会录进去。
- **Capture（用户手测后要求，同日）**：第一版沿用小红书，X 上不显示 Capture；用户手测时把这一项列为问题，所以放开，红线同步。沿用 §50 的做法：录制脚本截帧编码，PNG 分块传回侧边栏，由侧边栏保存，这样连点不被 Chrome 拦。
  - 实测（真实 Chrome，同一条帖子）：画布按 `videoWidth×videoHeight` 建，720×1280（页面上显示 286×508），`toBlob` 得到 214 KB 的 8 位 RGB PNG，34 毫秒，不是黑帧。
  - 取的是 `videoEl()`：你眼下看着的那个视频。录制中滚到回复区时，截到的是回复的视频，不是正在录的那个，这和"当前这一帧"的说法一致。
  - 文件名沿用 §50 的格式，没有标题时用 `x-<帖子ID>`。序号和 YouTube 共用一条。
  - 动图读不到画面，提示和录制一样说明是动图的限制。片头广告认不出来，广告时点了会截到广告，README 写明。
  - X 的说明里去掉了"先把清晰度调到最高"：还没确认 X 网页版有这个选项。
- **小红书也加上 Capture（用户同日接着要求）**：三个站都有了，`checkCapture` 的站点判断去掉，`ClipsView` 的按钮和说明不再按站点隐藏。§50 留的"放开只要去掉站点判断，再改红线"照做。
  - 实测（真实 Chrome，已登录，从首页取一篇视频笔记直接打开）：`XHS_PLAYER_VIDEO` 命中唯一的 `<video>`，720×1280（页面上显示 592×832），`blob:` 同源，`toBlob` 得到 1.32 MB 的 8 位 RGB PNG，约 1.1 秒，不是黑帧。
  - 文件名沿用 §50 的格式，没有标题时用 `xhs-<笔记ID>`。
- **没有广告判断，界面写明**：验证不了的选择器要么漏判，要么把正常视频误判成"广告中"一直暂停，后者更糟。X 的广告只在片头，你等放完再开始就录不进去，所以侧边栏直接写"片头广告认不出来：等广告放完再开始录"。这是与 YouTube 的已知差异，手测清单里留了一条，碰到时补上。
- **竖屏的清晰度上限改按短边算（用户 2026-11-06 确认，对小红书也生效）**：`outputSize` 原来按高度算，1080 的上限对竖屏不公平，X 的 720×1280 会录成 608×1080，小红书的 1080×1920 也一样。改成短边不超过 1080（`CLIPS.maxShortSide`，原名 `maxHeight`）。横屏的短边就是高度，结果不变。
  - 实测（真实 Chrome，`avc1.640028`）：608×1080、720×1280、1080×1920、1440×2560、1080×2400、2560×1080 都能编码，解出来尺寸一致。所以没有加长边上限：算下来 1080×2400 超出 H.264 Level 4.0 的帧大小，Chrome 照样编出来了。
  - 负载（同一 Chrome，X 上的真实视频，画布 8 Mbps 录 5 秒，定时器 30fps 补画）：608×1080、720×1280、1080×1920 都画满 152 帧，源视频 0 丢帧，1080×1920 得到 4.33 MB。第一次只跟着 `requestVideoFrameCallback` 画，标签页不在前台，4 秒只回调 4 次，这组数据作废。
  - 码率仍按输出高度选，竖屏落在 8 Mbps 这一档，和原来一样，文件不会因此变大。放弃按短边选码率：720×1280 会从 8 Mbps 降到 5 Mbps，画面变大了每个像素分到的反而少。
- **动图录不了，说人话**：开录前的 `framesReadable` 已经挡住，提示里加一句"X 的动图（GIF）是这样，普通视频不受影响"。
- **两处对其他站也生效的修复**
  - **没点过页面时开录会卡死**：`await ac.resume()` 在页面没有用户手势时既不报错也不返回（实测 x.com：`hasBeenActive=false`，3 秒后仍挂着），录制脚本不回话，侧边栏一直"忙"，"在视频画面上点一下"的提示永远出不来。原来的判断写在这句之后，是走不到的。外链打开的 X 帖子最容易碰到，YouTube、小红书同样会。加 1 秒超时（`CLIPS.audioResumeMs`）后往下走。
  - **循环播放的视频不算"播完"**：开录检查里的 `atVideoEnd` 把离结尾不到 0.5 秒算作播完，1.47 秒的循环动图约三分之一的时间落在这里，提示成"视频已经播完了"。e2e 的动图用例抓到的。
- **放弃**
  - 时间线上直接录：视频属于哪条帖子要读帖子的链接，超出"播放器状态、页面标题和网址"；点开帖子只多一步，侧边栏也会提示。
  - `chrome.tabCapture`：理由同 §43。
  - 读页面环境里 X 的播放器对象判断广告：要新的页面内助手，和红线的方向相反，也没有样本可验证。
- **测试**
  - 单测：真实页面标题（中英文、通知数、无文字、认不出的语言、加载中）、文件名、网址（全屏视图、`/i/`、分享参数、伪造域名、官方 API）、不能录的说明、`checkCapture` 拒绝、屏幕面积、取视频（实测的两种布局加滚到回复区、暂停主帖）、记录校验（ID 与链接对不上、站点由后台定、从 YouTube 页面送来）、回到帖子、后台保存。
  - e2e：仿 X 页面 `tests/e2e/x-pages.mjs` 照实测结构写。时间线的说明；站内跳进帖子不刷新就能录；选主帖不选更大的回复；图标 REC；滚开暂停不计时、滚回来接着录；静音视频录到声音；文件名、记录、去掉分享参数；清单标"X ·"；页面原样未动、X 的元素没被点到；Capture（现场录一段左红右蓝的 720×1280 VP8 换给主帖：文件名、真实尺寸、像素、下载算在侧边栏上、页面原样未动，小红书同样走一遍）；全屏视图选弹层、离开帖子自动结束；动图提示（跨站视频由 Playwright 在本地应答，现场录一段 VP8，WAV 没有画面触发不了）；文字帖子；页面上没有 TubeMuse 发出的请求。冒烟测试核对注入范围。
  - 没点过页面（一次性脚本，不进仓库）：e2e 带 `--autoplay-policy=no-user-gesture-required` 启动，测不到这条路径；Playwright 下换成桌面版的默认策略也复现不了，超时调成 10 分钟的对照组同样直接开始录制。改用原始 CDP 裸启动 Chromium（`--autoplay-policy=document-user-activation-required`，只连侧边栏，全程不连 X 页面）才复现：对照组（超时 10 分钟，等于旧行为）6 秒内既没开始录制也没有提示；修复后 1251 毫秒出现"浏览器还没允许这个页面处理声音"。
  - 没有在真实 X 上跑完整扩展：Playwright 自带的 Chromium 解不了 H.264，正式版 Chrome 又不让命令行加载扩展；管线、标题和布局是在真实页面上分别核实的，整体留给手测清单。
- **顺带修的测试（用户确认后改）**：CI 上"把字幕烧进画面"的 `uncheck()` 报 `Clicking the checkbox did not change its state`，这行是 11-01 写的，本地三轮都没出现。和 §43 的 `check()` 同一类：这个勾选框跟着设置走，点完到设置写进存储之间，侧边栏每秒一次的状态刷新会把它弹回旧值，Playwright 点完立刻核对就赛跑。不是产品问题，最终状态是对的。侧边栏里只有这两处这样写，都改成点击后等设置写进存储、再等勾选框到位；写不进去或勾选框对不上仍然失败。
- **日后替换**：X 改版时看 `core/clips.ts` 的 `xPostTitle`、`X_STATUS_PATH` 和 `content/clipper.ts` 的 `xVideoEl`。摸清片头广告后在 `adShowing` 里加 X 的判断，去掉 `ClipsView` 里的说明。

## 53. YouTube 授权改为授权码 + PKCE + 刷新令牌：自动续期不再靠浏览器窗口（2026-11-07，用户要求；取代 §25 的续期做法）

- **现象**（用户截图，Comet）：连接后十几分钟到一小时就显示"YouTube 授权已过期，自动续期没有成功"，原因 `Google 要求你在授权窗口里确认或选择账号（interaction_required）`。重新加载扩展后同样如此。用户的硬指标：至少 24 小时无感续期、不手动干预；重新加载扩展后仍保持已登录。
- **根因**：§25 的隐式授权（`response_type=token`）**没有刷新令牌**。访问令牌约 1 小时有效，之后唯一的续期办法是在隐藏窗口里再走一次授权（`prompt=none`）。这条路能否成功完全由 Google 决定，取决于这个浏览器里网页版 Google 的登录态：
  - Google 回 `interaction_required`，就是它坚持要你在窗口里操作一次（确认或选择账号），隐藏窗口给不了，所以每次都续不上。§34 记下的"8 天里静默续期一次也没成功"就是同一件事，当时只差把原因记下来；这次原因记下来了。
  - 最常见的触发是浏览器里登录了不止一个 Google 账号，又没带 `login_hint` 指明是哪个。我们给不了 `login_hint`：它要邮箱或账号 ID，而拿这两样都要申请 `openid` / `email` 范围，违反"只申请 `youtube.readonly`"的红线。Google 在"测试中"的未验证应用上也可能要求确认。到底是哪一种看不到 Comet 内部，**没能直接证实**；但不管是哪一种，扩展都控制不了。所以这不是参数没调好，而是这个续期办法本身没法保证。
  - "十几分钟就过期"没能复现：访问令牌本身是 1 小时。较可能的情况是在上一个令牌快到期时连上、或令牌被 401 作废后立即续期失败。新做法下访问令牌的长短不再影响你，这一点不再追。
  - 重新加载扩展：令牌一直存在 `chrome.storage.local`，重新加载不会丢。看起来"掉线"是因为重新加载后访问令牌往往已过 1 小时，续期又失败。
- **外部事实（2026-11-07 核实，Google 文档经搜索摘录；`developers.google.com` 在本会话的网络里打不开，未能逐字读原文）**：
  - Web 服务器流程：`access_type=offline` 才发刷新令牌；Google 只在"同意"那一步发刷新令牌，以前授过权的再连接要加 `prompt=consent` 才会再给。`prompt` 可以用空格连写多个值。
  - "Web 应用"客户端用授权码换令牌要带 `client_secret`（PKCE 不能代替它；有人试过只带 PKCE，被拒）。续期（`grant_type=refresh_token`）同样要带。
  - 同意屏幕为"外部"、发布状态为"测试中"的项目：申请超出 name / email / profile 的范围时，**刷新令牌 7 天后失效**。发布为正式版后没有这个期限；Google 的说法是半年不用或被撤销才失效。发布前已发的令牌仍按 7 天算，要重新授权一次。未验证的应用最多 100 个用户，授权时显示"未验证"警告。
  - Google Cloud 控制台自 2025 年起只在创建时显示一次 Client Secret，之后打码；丢了可以在客户端页面"Add secret"再建一个（支持多个并存、轮换）。
- **做法**：
  - 连接：`launchWebAuthFlow`（交互）打开 `response_type=code`、`access_type=offline`、`prompt=consent select_account`、PKCE（S256，32 字节随机 verifier）、随机 `state`，只申请 `youtube.readonly`，不带 `include_granted_scopes`。回跳先校验 `state`，再把授权码连同 `client_id`、`client_secret`、`redirect_uri`、`code_verifier` POST 到 `oauth2.googleapis.com/token`，得到访问令牌和刷新令牌。没拿到刷新令牌就明确报错，不存半套状态。
  - 续期：访问令牌过期（留 2 分钟余量）时，用刷新令牌 POST 到令牌端点换新的。不开窗口，与浏览器里的 Google 登录、多账号都无关。侧边栏、设置页、后台各有一份授权模块，用 Web Locks（`youtubeAuth:renew`）串行：一个换完，其他直接用存下的结果；同一页面里的并发请求只续一次。
  - 失败分四类（`core/oauth.ts` 的 `classifyTokenError`）：
    - 网络、5xx、429：**暂时的**，报"连不上 Google、授权本身没有失效"，不标"已过期"，下次用时再试。
    - `invalid_grant`：刷新令牌失效（测试状态满 7 天、你移除了授权、改了密码）。丢掉这个令牌（之后不再白发请求），状态变"已过期"，写明原因，只能重新授权。
    - `invalid_client` / `unauthorized_client` 等：Client Secret 不对。**保留刷新令牌**，提示去设置页改 Client Secret；改好后清掉失败标记，立刻续上，不用重新授权。
    - 其他：记下原因，冷却 15 分钟再试。
  - 竞态：续期失败只在记录仍是这个刷新令牌、且没有别处刚换来新令牌时才记下（与 §34 的保护同理）。
  - Client Secret：红线要求密钥由你在设置页填写、只存本地、不进代码与构建产物。所以它不像 Client ID 那样在构建时注入，而是放进 `secrets`（不进导出，"清空"时删除），每次用时现读，只随请求体发往令牌端点。脱敏补上 `GOCSPX-…`、`1//…` 和表单里的 `code=` / `refresh_token=` / `client_secret=` / `code_verifier=`；构建产物扫描补上 Client Secret 与刷新令牌的样式。
  - 断开：有刷新令牌时吊销它（Google 会连带吊销它换出的访问令牌），访问令牌过期了也照样吊销。
  - 旧版记录（隐式授权、没有刷新令牌）：访问令牌还有效时照常用；侧边栏提前提示"YouTube 授权是旧版"。过期后状态为"已过期"，原因写"旧版授权，没有刷新令牌"，不发请求、不开窗口。填好 Client Secret、重新授权一次即可。
  - 界面：设置页「2. YouTube 账号」加"OAuth Client Secret"一栏。状态显示"已连接，自动续期已开启"，下一行写刷新令牌拿到的时间，以及 Google 给的期限；Google 没给期限时说明"测试中 7 天"的规定和发布为正式版的办法。侧边栏横幅写原因：要改 Client Secret 时按钮是"打开设置填 Client Secret"，否则是"重新授权"。
- **偏差（请过目）**：
  - §25 里你指定的是隐式授权，这次改成授权码流程，因为隐式授权达不到你这次给的硬指标。
  - 多了一步手动配置：在设置页填 Client Secret。已有"Web 应用"客户端的，到 Google Cloud 该客户端页面"Add secret"新建一个即可，不用新建客户端。
  - 每次连接 / 重新授权都会显示 Google 的同意页（`prompt=consent`），这是拿到刷新令牌的条件。
  - "测试中"状态下每 7 天要重新授权一次，这是 Google 的规定，满足"至少 24 小时"；README 写了发布为正式版去掉期限的办法。是否发布由你决定，不是代码能改的。
- **放弃**：
  - 保留隐式授权 + `prompt=none`，加 `login_hint` 解决多账号：要 `openid` / `email` 范围，违反红线；而且仍然依赖网页版 Google 的登录态，达不到"24 小时无感"。
  - 加没有文档的 `authuser` 参数：账号序号会变，Google 也不保证支持。
  - `getAuthToken`：Comet 上不可用（§25）。
  - "桌面应用"类型客户端 + 环回地址：`launchWebAuthFlow` 只截获 `chromiumapp.org`，要另开标签页监视跳转；而且同样要 Client Secret，换了也没有好处。
  - 把 Client Secret 写进构建产物（像 Client ID 那样）：违反红线。
  - 定时在后台主动续期：令牌用时再续就够了，主动续期只会多发请求。测试状态的 7 天期限从刷新令牌发放时开始算，续多少次都不会延长。
- **验证**：
  - 单测 36 条（`tests/unit/auth.test.ts`）：
    - 授权地址的参数；RFC 7636 附录 B 的 PKCE 示例；回跳与令牌响应的解析；错误归类；脱敏。
    - 连接时 Client Secret 与 verifier 只在令牌端点的请求体里。
    - **连续 30 小时每小时用一次**：只弹过 1 次窗口，续期 30 次，状态一直"已连接"。
    - 浏览器关了几天后再用，一次续上。
    - **模拟扩展重新加载**：新的一份授权模块，只共用存储，状态"已连接"，之后 25 小时照样续期。
    - 侧边栏 + 后台同时续期，只发一次请求。
    - 401 后的续期；Google 轮换刷新令牌。
    - 网络 / 5xx 不标"已过期"；`invalid_grant` 丢掉刷新令牌并写明 7 天；`invalid_client` 保留刷新令牌，改好 Secret 立即续上；Secret 被删时不发请求。
    - 其他错误的冷却；续期途中重新授权的竞态；旧版记录；断开时的吊销；导出排除。
    - 竞态保护与跨页面锁都做过反向验证：去掉后对应用例失败。
  - e2e（mock 授权页发授权码，mock 令牌端点校验 Client Secret、`redirect_uri` 与 PKCE）：
    - 没填 Secret 就点连接：说明原因，不弹窗。
    - 连接请求的参数；换令牌只 POST 到令牌端点。
    - 用 mock 让刷新令牌失效 → 侧边栏同步画像 → 横幅写明 `invalid_grant` 和 7 天 → 重新授权（窗口开着时关掉侧边栏，后台照样存下）。
    - **访问令牌过期 24 小时后**同步画像：自动续期，没有弹窗、没有横幅。
    - **关掉浏览器再用同一个用户目录启动**：扩展 ID 不变，授权原样还在，设置页"已连接，自动续期已开启"，过期的访问令牌自动续上、不弹窗。
    - Client Secret 只发往令牌端点；刷新令牌只发往令牌端点与吊销端点。
  - 想在 e2e 里测"扩展管理页的重新加载"，但 Playwright 的 Chromium 对命令行加载的扩展执行 `chrome.runtime.reload()` 后不会再启用它（页面报 `ERR_BLOCKED_BY_CLIENT`），所以改测更彻底的整个浏览器重启。真正的"重新加载"按钮留在 README 手测清单里。
  - 没有在真实 Google、真实 Comet 上跑过：要你的 Client Secret 和账号。手测清单已更新（24 小时、重新加载、移除授权后重新授权）。
- **以后怎么换**：
  - 若某天 Google 允许"Web 应用"客户端只用 PKCE 换令牌，删掉 `connect` / `renew` 里的 `client_secret` 和设置页那一栏即可。
  - 若改用别的身份提供方，`AuthProvider` 接口与调用方不用动，只换 `services/auth.ts` 的 `webAuthFlowAuth`。

## 54. 片段录制：支持酷播（www.kubb.tv）的播放页（2026-11-10，用户要求）

- **需求**：用户在 `https://www.kubb.tv/play/<ID>` 上打开 **片段** 页，看到"当前标签页不是 YouTube 视频页、小红书网页版或 X 网页版"。要把 YouTube 上的片段录制照搬到 `kubb.tv/play/*`：更新注入范围，侧边栏不再说不支持，提示文案把酷播写进去。
- **红线**：这是 TubeMuse 第一次往 `www.kubb.tv` 注入脚本，红线里没有这个站。用户点名要、要的又是现有功能原样照搬，所以没有停下来再问，按 §52（X）的先例，把同一套约束写进 CLAUDE.md §1、§2（请用户过目）：只在你开始后工作、画布不放进页面、不发网络请求、不点酷播的任何按钮、读取的页面信息只限播放器状态、页面标题和网址。网络出口不变：`www.kubb.tv` 不进 `connect-src` / `host_permissions`，没有新增权限。比 X 多读一样东西：播放器当前片源的地址是不是 `blob:`（`video.currentSrc`，属于播放器状态），用来认片头广告，写进了红线。
- **外部事实（2026-11-10 实测，用户的 Chrome，未登录酷播；电影 `/play/8aZsQlwuJ1E`，剧集 `/play/e2rCXFzJUz2`）**
  - 截图里的网址我先读成了 `8aZsQIwuJ1E`（大写 I），页面回"视频不存在"；实际是小写 l。
  - **单页应用（Angular）**：从首页点进播放页、播放页之间互相跳、换集，页面都不重新加载（事先放在 `window` 上的标记一直在）。
  - **一页有 3 个 `<video>`**：投屏按钮（`.control-item.airplay`）里一个空的，排在最前；播放器的 `video#video_player`，是 `<vg-player id="main-player">` 的直接子元素，`crossorigin="anonymous"`，页面上 840×473；页面角落 `.root-container` 下一个 1×1 的 `empty2.mp4`。换片、换集用的都是同一个 `#video_player` 元素，只换片源。
  - **正片是同源 `blob:`**（HLS，分片来自别的域名，经 MSE 喂给播放器）。画到画布上读得到（不是黑帧），`captureStream()` 给出一条音轨一条画面轨，声音峰值 0.722，`mediaKeys` 为空。和 YouTube、小红书、X 同一类。电影 864×362、2 小时 23 分。
  - **放到结尾正常报"播完"**：`ended=true`、`paused=true`。电影停在那里；剧集约 1.4 秒后自动播下一集。
  - **换集**：网址变成 `/play/<影片ID>?id=<分集ID>`（你点的和自动播下一集都是），页面标题同时更新；不带 `?id=` 打开时是站点替你接着看的那一集（实测进去就是第 24 集，从 47 分处接着放）。换集后播放器自己跳过片头（跳到 107 秒）。
  - **页面标题**：电影 `八仙！-免费在线观看-酷播`，剧集 `玉簟秋-24-免费在线观看-酷播`，首页 `酷播-海量高清视频免费在线观看`。站内换片后标题晚一两秒才变（网址先变）。
  - **ID**：首页 207 个 `/play/` 链接，ID 是 11 或 12 位字母数字。另有 `/watch?v=<ID>`（64 个，短视频）、`/svideo`、`/space/<ID>` 等路径，这次没有碰。
  - **片头广告**：换片、点选集时，`#video_player` 先放了一条 `https://s1-a1.global-cdn.me/vod/….mp4`（20 秒、1280×720，抽帧看是"你知不知道什么是 VIP…还能看超清 4K"的会员宣传片），直接给地址、不是 `blob:`。在播放器里直接看到它在放的只有一次（点选集后 0.76 秒：`currentTime=0.8`、时长 20，不到 1.5 秒就被正片换掉）；页面的资源记录里它一共加载了 3 次（从电影跳到剧集时两次、第一次点选集时一次），自动播下一集和之后再点选集时没有。完整放满 20 秒的情形没有碰到。它带着 `crossorigin="anonymous"` 加载成功，画面读得到。
  - 播放器里有弹幕层（`vg-overlay-danmu`）和一个空的字幕层（`div.caption`），都是盖在视频上的页面元素。
  - **没有核实的**：登录后、VIP 清晰度、会员片是否一样（有没有 DRM）；不带 `www` 的 `kubb.tv` 会不会跳转；中插广告。
- **注入范围**：manifest 匹配 `https://www.kubb.tv/*`，和 YouTube、小红书、X 写在同一条 `content_scripts` 里。**没有按用户写的只匹配 `/play/*`**：单页应用从首页点进播放页不重新加载，只匹配 `/play/*` 的话要刷新一次才有录制脚本。脚本自己只认播放页（`parseKubbPlayUrl`），别的页面上每 100 毫秒只解析一次网址，不找任何元素。
- **站点与 ID**：`ClipSite` 加 `'kubb'`。ID 是"影片ID"或"影片ID.分集ID"（网址里有 `?id=` 时）。这样换集就是换了视频，沿用现有的"网址里的 ID 变了 → 这一段结束并保存"，不用另加判断。分隔符用 `.`：ID 本身只有字母数字（正则放宽到 `_`、`-`），`.` 能放进文件名。不带 `?id=` 时录到的那一集，记录里只有影片 ID，标题里有集数。
- **取视频**：`vg-player > video`，不是播放页时不找。没有用 `#video_player`：直接子元素这个关系同时排除了投屏按钮里的那个；页面角落那个不在 `<vg-player>` 里。
- **换了视频的判断**沿用 YouTube 的（`videoEl()` 还是这个元素、网址里的 ID 没变）：酷播一直用同一个元素，靠的是网址。
- **片头广告（`isKubbAd`，纯函数）**：播放器当前片源不是 `blob:`、时长又不超过 `CLIPS.kubbAdMaxSec`（120 秒）算广告。和 YouTube 一样：广告时暂停录制、不画广告画面、不让截图、不让开始按时间段截取。
  - 和 §52 不同的选择。X 那次是没有样本、只能猜选择器，所以不判；这次看到了广告是怎么放的，判断用的是片源的种类，不是页面结构。但样本只有一条，所以加了时长上限：万一有正片是直接给地址的，只要超过 2 分钟就不会被误判成"广告中"一直不录。时长还不知道时不算广告。
  - 认不出的（叠在画面上的、做进正片流里的）会录进去；侧边栏、README 都写明"只认得出一种"，没有写成"广告自动跳过"。
  - **广告放完不算视频播完**（`decideClip` 里 `finished` 加了 `!s.ad`，对 YouTube 也生效）：酷播的广告放到头时 `ended=true`，过一会儿才换成正片；原来的顺序是先看"播完"再看"广告"，在广告里开始的录制会以"视频播完了"结束。YouTube 上这个改动只在"广告标记还在、播放器又报播完"的那一瞬间有区别，那时本来也不该结束。
- **换片源后声音接得上**：录制在广告里开始时，`captureStream()` 拿到的是广告的音轨；换成正片后浏览器给出新音轨，`connectAudio` 原本为 YouTube 换片源写的重接逻辑照用。e2e 里核对了成片有声音。
- **文件名与标题**：去掉结尾的 `-免费在线观看-酷播`，电影得到"八仙！"，剧集得到"玉簟秋-24"。首页的标题不用；认不出的写法原样用；没有标题时文件名用 `kubb-<ID>`。只读 `document.title`。
- **录制记录**：`site: 'kubb'` 由后台按发消息的页面定（`fromKubbPage`）。ID 必须和链接里解析出来的一致。链接存规范形式：只留影片 ID 和 `?id=`，别的查询参数去掉。"最近录过的片段"标"酷播 ·"，点标题回到这部影片（这一集）。
- **不提供字幕烧录**：用户要的是照搬录制，没提字幕；酷播的字幕层这次是空的，没有样本。侧边栏说明弹幕和播放器另外显示的字幕不会录进去。弹幕不录是画布只画视频本身的结果，不是特意去掉的。
- **Capture**：已有的三个站都有，酷播也照样有（红线同步）。沿用 §50。
- **侧边栏没有"域名拦截"要解除**：`useActiveTabState` 只是给当前标签页发消息，没人回话就显示"当前标签页不是…"。注入了脚本就有回话。改的是那句提示和页面底部的说明。
- **放弃**
  - 只匹配 `/play/*`：见上。
  - 支持 `/watch?v=`（短视频）：用户只要了 `/play/*`，那边的播放器结构没有看。
  - 片源一变就结束这一段：切清晰度也会换片源（没有实测），会把正常的录制打断；换集已经由网址管住了。
  - 读 `<vg-player>` 上的类名判断广告：这次看到的类名（`publicplay`）含义不明，也没有稳定出现。
- **已知风险**
  - 站内换片后的一两秒里页面标题还是上一部的，这时立刻开录，文件名会用上一部的片名（ID 和链接是对的）。那一两秒里新片还没加载出来，实际很难碰到，没有处理。
  - 广告判断只有一条样本，见上；README 的排查表里写了"正片被当成广告"时怎么办。
  - 酷播上的影视剧版权属于各自的版权方。录制只在你开始后、实时录正在播放的画面，不下载片源、不绕过 DRM，界面和 README 沿用"仅供个人学习，请勿传播"。
- **测试**
  - 单测（`tests/unit/clips.test.ts`"酷播播放页"12 条，另加 1 条判定）：真实页面标题（电影、剧集、通知数、片名带连字符、首页、认不出的写法）、文件名、网址（换集、多余参数、结尾斜杠、不像 ID 的 `?id=`、12 位 ID；首页、榜单、`/watch?v=`、不带 www、伪造域名、http 都不算）、站点判断、广告判断（实测的那条、正片、时长未知、超过上限、没有片源）、不能录的说明、`checkCapture`、记录校验（ID 与链接对不上、少了分集、站点由后台定、从 X / YouTube 页面送来）、回到影片、后台保存；广告放完不算播完。
  - e2e：仿酷播页面 `tests/e2e/kubb-pages.mjs` 照实测结构写（单页应用、三个 `<video>`、正片 `blob:`、广告直接给地址）。首页的说明；站内跳进播放页不刷新就能录；选中播放器的视频；图标 REC；文件名、有声音、记录、清单标"酷播 ·"；页面原样未动、酷播的元素没被点到；换集自动结束并保存，侧边栏跟上新的一集；广告时 Capture 不截且不占序号，开始录制后不计时，广告放完后仍在等，换成正片后接着录，成片不含广告、有声音，记录带分集；页面上没有 TubeMuse 发出的请求。冒烟测试核对注入范围。
  - 没有在真实酷播上跑完整扩展（原因同 §52：Playwright 的 Chromium 解不了 H.264，正式版 Chrome 不让命令行加载扩展）；结构、片源、声音、结尾、换集、广告是在真实页面上分别核实的，整体留给手测清单。
- **日后替换**：酷播改版时看 `core/clips.ts` 的 `kubbTitle`、`parseKubbPlayUrl`、`isKubbAd` 和 `content/clipper.ts` 的 `kubbVideoEl`。碰到认不出的广告或被误判的正片，改 `isKubbAd` 和 `CLIPS.kubbAdMaxSec`。

## 55. 片段录制：X 首页信息流里也能录（2026-11-10，用户要求；改了 §52 的红线）

- **需求**：在 `x.com/home` 上 **片段** 页写"这个页面不是帖子详情"。用户要三件事：首页信息流上也能用；信息流里有多个视频时，只把"正在播放且没有静音"的那个当目标；从这个视频所在的帖子往上找，取帖子的文字或标识，让 **帖子** 和 **状态** 两栏和帖子页表现一致。
- **红线（先停下来问了）**：§52 把"时间线上直接录"列在放弃里，理由正是要读帖子的链接，超出"播放器状态、页面标题和网址"；CLAUDE.md §2 还写着"只录帖子页上…""不读帖子内容"。这次的需求和这三句直接冲突，所以先问了两件事：
  - 读什么：用户选"读正文 + 作者 + 链接"（另一个选项是只读链接和作者）。
  - 放开哪些页面：用户选"只 `x.com/home`"（另一个选项是所有信息流页面）。
  - 按这两个回答改了 CLAUDE.md §1、§2：只读**锁定的那个视频所在的那一条帖子**的链接、作者名和正文；别的帖子不读；不插入元素、不点击、不发网络请求这些不变。
- **外部事实（2026-11-10 实测，用户的 Chrome，已登录，`x.com/home`"正在关注"）**
  - 信息流里每条帖子是一个 `<article data-testid="tweet">`，视频都在里面（`[data-testid="videoPlayer"]`）。
  - **帖子自己的链接**是包着发布时间的那个：`<a href="/用户/status/ID"><time>`，每条正好一个，在 `[data-testid="User-Name"]` 里排第三（前两个是显示名和 @用户名）。
  - **引用的帖子**嵌在同一个 `<article>` 里，是一个 `role="link"` 的块，有自己的 `User-Name`、`tweetText` 和 `<time>`，但这个 `<time>` 外面没有链接（实测一条：2 个 `<time>`，1 个带链接）。视频在被引用的帖子里时，`video.closest('[role="link"]')` 能认出来，但读不到被引用帖子的链接。
  - **转帖**：`[data-testid="socialContext"]` 写"某某 已转帖"，`User-Name` 和链接是原帖的。
  - **广告**：没有带 `<time>` 的链接，只有一个 `/用户/status/ID/analytics`。
  - **静音状态和直觉相反**：滚到眼前自动播放的视频是 `muted=true`；**没播过的视频是 `muted=false`、`paused=true`、`currentTime=0`**。所以"没静音"单独说明不了什么，必须同时在播。
  - 点自动播放（静音）的视频画面：进入帖子页（站内跳转，视频元素换了新的）。点没在自动播放的视频的播放键：就地带声音播放，`muted=false`、`volume=1`，网址仍是 `/home`。
  - 带声音播放时往下滚：视频还露着一点时照常播；完全滚出屏幕后 X 把它暂停（`paused=true`，还在页面上，`muted=false`）。
  - 没在播放的视频有时还没有 `<video>` 元素（只有封面图），点播放后才有。
  - **没有核实的**：点视频右下角的喇叭是不是就地打开声音（用户的截图里是这样的状态，README 照这个写）；带声音播放过一个之后，后面自动播放的视频是否也带声音；滚多远 X 才把帖子从页面上撤掉；"为你推荐"里别的卡片类型（X 上的直播、社群帖子）。
- **哪些页面算首页信息流（`isXHomeUrl`）**：路径正好是 `/home`。"为你推荐 / 正在关注 / 置顶的列表"都在这个网址下切换。个人主页、搜索、书签、列表页不算，提示改成"这个页面不是帖子详情，也不是首页信息流"。
- **锁定哪个视频（`pickXFeedVideo`，纯函数）**
  - 只认 `!paused && !ended && !muted && volume > 0` 的。音量拉到 0 也算没声音：X 的音量条可能只改 `volume`。不止一个时取屏幕里更大的。
  - **锁定后暂停仍算数**（用户写的是"唯一目标是在播且没静音的"，这一条是我加的）：不这样的话，暂停下来 Capture、视频播完后按时间段重截都会丢目标，而这两件正是片段页的主要用法。条件是它还有声音、还在屏幕里；暂停着滚出屏幕、被静音、被 X 从页面上撤掉，或别的视频带着声音播起来，就放开或换掉。
  - 放开之后滚回来不会自己又锁上：没播过的视频也是"没静音、暂停着"，分不出来。要再播放一下。
- **帖子信息（`readXFeedPost`）**：`video.closest('article')` → 带 `<time>` 的链接经 `parseXStatusUrl` 得到帖子 ID 和规范链接 → 第一个 `User-Name` 里第一个链接的文字是作者名 → 不在引用块里的 `tweetText` 是正文。
  - 标题用 `xFeedTitle` 拼成"作者 - 正文"，和帖子页从页面标题得到的写法一致（单测里拿同一条帖子对过），文件名也就一样。表情是 `<img alt>`，取替代文字；`t.co` 链接（媒体和外链）跳过，帖子页的标题里也是去掉的；@提及和话题标签留着。
  - 视频在被引用的帖子里时，记的是外层这条（你在信息流里看到的这一条）：链接读得到的只有它。
  - 读不到链接（广告）时不让录，提示"认不出这个视频属于哪条帖子"。没有退回去用 `/analytics` 链接里的 ID：那等于认出了广告还去录它。
  - 只在锁定时读一次，之后不再读；没读出来时下一轮再试。
- **录制记录**：`pageUrl` 存这条帖子的链接，不是 `/home`，所以后台原有的校验（链接里的 ID 要和记录的 ID 一致）不用改，"最近录过的片段"点标题回到帖子。
- **录制中**：沿用 §52 的"盯住开录时的那个元素"。信息流里开录的（`Recording.feed`）没有网址可比，改成：元素还在页面上、人还在首页（或进了同一条帖子的页面）就算没换。别的视频带着声音播起来不换目标。滚出屏幕时 X 暂停它，录制跟着暂停；帖子被撤掉、离开首页时这一段结束并保存。
- **每 100 毫秒做什么**：§52 写过"时间线上不用量任何元素"。现在首页上每轮 `querySelectorAll('video')`，读每个视频的 `paused / ended / muted / volume`；只有"在播且有声音"的和上次锁定的那个才量位置（平时一个都不量）。这一轮一轮地跑是为了记住"锁定过"，侧边栏没开时也在跑。别的 X 页面仍然只解析网址。
- **放弃**
  - 只读链接、不读正文：用户没选。
  - 所有信息流页面：用户没选。放开只要改 `isXHomeUrl`，再改红线。
  - 不记"锁定过"、只看当下状态：见上，没播过的视频和暂停下来的视频分不出来。
  - 用 `IntersectionObserver` 或事件监听代替轮询：要在页面的元素上挂监听，录制脚本现在一个都没挂。
  - 认出视频在被引用的帖子里时改用被引用帖子的作者和正文：链接读不到，标题和链接会指向两条不同的帖子。
- **已知风险**
  - 选择器靠 X 现在的 `data-testid`（`User-Name`、`tweetText`）和"时间外面包着链接"。X 改版后最可能的表现是 **帖子** 一栏只剩作者或只剩正文，或者提示认不出帖子；不会录错视频（锁定只看播放状态）。
  - "为你推荐"里的其他卡片类型没有看过。
- **测试**
  - 单测（"X 帖子页 › 首页信息流"11 条）：`isXHomeUrl`（带参数、结尾斜杠；`/homework`、`/home/foo`、搜索、书签、帖子页、伪造域名、http）；`pickXFeedVideo`（实测的初始状态一个都不选、只选在播且有声音的、多个时比面积、锁定后暂停仍算数、没锁定过的不算、滚出屏幕 / 静音 / 不在页面上时放开、别的视频播起来时换掉）；`xFeedTitle`（换行、短链、与帖子页标题一致、缺作者或缺正文）；不能录的三种说法，开录和 Capture 共用。
  - e2e：仿首页 `tests/e2e/x-pages.mjs` 照实测结构重写（广告静音自动播放、没有带时间的链接；普通帖子带表情、@提及、t.co 外链和一条引用）。初始状态不可录；广告带声音播放时提示认不出帖子；播放帖子的视频后标题是"作者 - 正文"（表情保留、短链去掉、没有混进被引用帖子的文字），时长是这个视频的；暂停后仍锁定；滚出屏幕放开，滚回来不自动锁上；录制中滚开且广告带声音播起来时不换目标、暂停计时；页面原样未动、没有点到 X 的元素；离开首页自动结束并保存，文件名、有声音、记录里的链接是帖子自己的；别的 X 页面的提示；暂停着 Capture 的文件名和尺寸；帖子被撤掉后放开。原有的帖子页用例接在后面照跑。
  - 没有在真实 X 上跑完整扩展（原因同 §52）；结构和播放状态是在真实首页上核实的，整体留给手测清单（README 新增 6 条）。
- **日后替换**（函数名按 §56 改名后的写）：X 改版时看 `content/clipper.ts` 的 `readXFeedPost`、`postText`；锁定规则在 `core/clips.ts` 的 `pickFeedVideo`；要放开别的信息流页面改 `isXHomeUrl`（先改红线）。

## 56. 片段录制：Instagram 首页信息流（2026-11-10，用户要求"同样的逻辑"）

- **需求**：在 `www.instagram.com` 上 **片段** 页写"当前标签页不是…"。用户要"同样的逻辑，为片段功能区支持 Instagram 信息流"，即 §55 给 X 首页信息流做的那一套。
- **红线**：这是 TubeMuse 第一次往 `www.instagram.com` 注入脚本，红线里没有这个站。没有停下来再问，理由和 §52、§54 一样：用户点名要，要的是刚批准过的同一套逻辑（§55 里"读正文 + 作者 + 链接"是用户自己选的）。约束照 §55 原样写进 CLAUDE.md §1、§2（请用户过目）：只在首页信息流上工作；只看各视频的播放状态；只读锁定的那个视频所在那一条帖子的链接、作者用户名和正文；不插入元素、不点击、不发网络请求。网络出口不变：`www.instagram.com` 不进 `connect-src` / `host_permissions`。"只建议，不代办"那一条也把 Instagram 加了进去。
- **范围只到首页信息流**：用户说的是"信息流"，截图是 `https://www.instagram.com`。帖子页（`/p/…`，包括点开评论后的弹层）、Reels、探索、个人主页都不录，提示"这个页面不是 Instagram 的首页信息流"。这和 X 不一样（X 的帖子页是 §52 先做的）。要加帖子页是另一件事，得另加红线。
- **外部事实（2026-11-10 实测，用户的 Chrome，已登录，`www.instagram.com/`）**
  - 视频是同源 `blob:`（MSE），`crossOrigin` 为空，画到画布上读得到（不是黑帧），`captureStream()` 给出一条音轨一条画面轨，`mediaKeys` 为空。和 YouTube、小红书、X、酷播同一类。实测到的尺寸有 360×640、540×675、720×1280、1080×1920。
  - 每条帖子是一个 `<article>`（没有任何属性）。**帖子自己的链接**是包着发布时间的 `<a href="/p/<短码>/"><time>`，视频帖子也是 `/p/`；视频本身包在一个 `<a href="/reels/<短码>/">` 里。短码 11 位。
  - 帖子里的链接依次是：作者 `/用户名/`、带时间的帖子链接、音频页 `/reels/audio/…`、`/reels/<短码>/`、正文前又一个作者链接、话题 `/explore/tags/…`。头像有限时动态圈时不是个人主页链接。
  - **正文**在视频下面：`div( div(…作者链接…) span[dir=auto]( div( span[dir=auto](正文：文字、话题链接、<br>) ) span("... " div[role=button]("更多")) ) )`。表情是普通文字，不是图片。折叠的部分不在页面里，要点"更多"才有。类名是混淆过的（`_ap3a _aaco …`），没有用。
  - **广告帖子**：没有 `<time>`，有"赞助内容"字样和一个 `facebook.com/ads/ig_redirect` 的链接。
  - **声音**：自动播放的和没播过的都是 `muted=true`（X 上没播过的是 `muted=false`）。打开声音后是 `muted=false`、`volume=0.5`，喇叭的标签从"已静音"变成"正在播放音频"；再点一次回到 `muted=true`、`volume=0`。音量条是喇叭上方一个 `role="slider"` 的元素，鼠标移上去才出现。
  - **第一次点喇叭没有打开声音**：`volume` 从 1 变成 0，仍是静音；第二次才打开。没有弄清是我点到了刚浮出来的音量条，还是 Instagram 的第一次点击就是这样。测完已点回静音；音量可能留在了 50%，不确定之前是多少。
  - **滚动**：视频完全滚出屏幕后 Instagram 暂停它（`paused=true`，`muted=false` 不变，还在页面上）；滚回来**自己接着播**，仍带声音。X 上滚回来不会自己播。
  - **放到结尾**：没有 `loop` 属性；每 20 毫秒看一次，没看到 `ended` 也没看到暂停，只看到 `seeking` 约 130 毫秒、进度从结尾回到 0，然后接着播。
  - 页面标题就是 `Instagram`。单页应用。
  - 多图帖子里的视频滚到眼前 3 秒内没有自动播放（只看了一条）。
  - **没有核实的**：点视频画面是不是暂停（README 的手测清单照这个写了）；点开评论后网址是否一定变成 `/p/…`；多图帖子、合作帖子、"为你推荐"的帖子的结构；`www.instagram.com` 以外的域名。
- **代码怎么复用 §55**：`pickXFeedVideo` → `pickFeedVideo`、`xFeedTitle` → `feedPostTitle`，两个站共用（规则没改）。录制脚本里"锁定的视频 + 它的帖子"那一套（`feedLock`、`feedTarget`、`feedSiteNow`、`feedRecordingId`）也改成共用，各站只提供"怎么从视频读出帖子"：`readXFeedPost`、`readIgFeedPost`。
- **锁定规则在 Instagram 上的表现**：`!paused && !muted && volume > 0`。静音时 Instagram 两样都占（`muted=true` 且音量 0）。滚回来它自己接着播，所以会自动重新锁定（X 上要再点一下播放）。
- **帖子信息（`readIgFeedPost`）**
  - 链接：`article` 里包着 `<time>` 的 `<a>`，经 `parseIgPostUrl` 得到短码。规范链接一律写成 `/p/<短码>/`（`/reel/`、`/reels/`、带用户名的写法都认），查询参数去掉。
  - 作者：帖子里第一个个人主页链接里的**用户名**（`igProfileName`：只有一段、不是 `p / reels / explore / stories / direct` 这类功能页）。没有读显示出来的名字：用户名就在网址里，不依赖页面结构。
  - 正文：视频之后、套了两层的 `span[dir="auto"]`，不在链接或按钮里，并且同一个块里有这位作者的链接。最后一条是为了不把别人的评论当成正文。只取露出来的这一段：折叠的部分要点"更多"，脚本不点任何东西。
  - 广告帖子没有带时间的链接，提示"认不出这个视频属于哪条帖子…这个视频录不了"。X 上那句结尾是"点开帖子再录"，Instagram 没有帖子页可去，所以两个站的说法分开了。
- **放到结尾算播完（`loopedToStart`，纯函数）**：Instagram 的视频自己从头再放，又不报"播完"。不处理的话有两个问题：自由录制会把第二遍、第三遍接着录下去；偶尔碰巧撞上 `ended` 为真的那一瞬间又会结束，行为不固定。现在的规则：上一轮进度在结尾附近（`CLIPS.endSlackSec` 内）、这一轮回到了开头，就算放完了一遍，这一段结束（自由录制写"视频播完了"，时间段写"已录到终点"）。只对 Instagram 生效。
  - 开录前"视频已经播完了"的检查对 Instagram 关掉：它总在循环，离结尾近不等于播完。
  - 要完整的一遍：按时间段截取，起点 `0:00`、终点填时长。README 排查表里写了。
  - 标签页在后台时每轮间隔变长，可能漏掉这次跳转；那时录制本来就暂停着。
- **录制中**：元素还在页面上、人还在首页就算没换。滚出屏幕时 Instagram 暂停它，录制跟着暂停，滚回来接着录。离开首页（包括网址变成帖子页）时这一段结束并保存。
- **没有广告判断**：广告帖子整条不让录（认不出帖子）。普通视频里没有片头广告。
- **不提供字幕烧录**：Instagram 没有单独的字幕层可读，字幕做在画面里的会原样录下。
- **放弃**
  - 帖子页、Reels 页：用户没要，见上。
  - 读显示名而不是用户名：见上。
  - 读类名（`_ap3a` 等）找正文：混淆过的类名说变就变。
  - 点"更多"读全文：不点页面上的任何东西。
  - 循环着一直录到你点停止：见上。
- **已知风险**
  - 认帖子靠现在的页面结构。改版后最可能的表现是 **帖子** 一栏只剩用户名，或提示认不出帖子；不会录错视频。
  - 正文的判断只在一条帖子上看过完整结构，另外几条只核对了链接和时间。合作帖子（两个作者）取的是第一个。
  - Instagram 的内容属于作者。录制只在你开始后、实时录正在播放的画面，界面和 README 沿用"仅供个人学习，请勿传播"。
- **测试**
  - 单测（"Instagram 首页信息流"14 条）：站点判断；首页网址（带 `?variant=`；帖子页、Reels、探索、个人主页、伪造域名、http 不算）；帖子链接（`/p/`、`/reel/`、`/reels/`、带用户名、分享参数；首页、音频页、广告跳转、伪造域名不算）；用户名（带点的；功能页、话题、限时动态不算）；标题与文件名；实测的静音状态下一个都不选、打开声音才选、暂停仍算数、滚出屏幕放开；`loopedToStart`（实测的 16.14 秒；正常播放、中途、时长未知、没回到开头都不算）；放完一遍时两种录法的结束原因；不能录的三种说法；记录校验（短码与链接对不上、站点由后台定、从 X / YouTube 页面送来）；回到帖子；后台保存。原有 X 信息流的 11 条照跑（函数改了名）。
  - e2e：仿 Instagram 首页 `tests/e2e/ig-pages.mjs` 照实测结构写（广告没有时间、视频包在 `/reels/` 链接里、正文套两层并带"更多"、没有正文的帖子下面露着别人的评论、页面自己在结尾跳回开头）。初始状态不可录；广告带声音播放时提示录不了；打开声音后标题是"用户名 - 正文"（话题和表情保留、不含"更多"），时长是这个视频的；不点停止，放到结尾自动结束并保存，成片只有一遍、有声音；记录里的链接是帖子自己的，清单标"Instagram ·"；页面原样未动、没有点到 Instagram 的元素；暂停着 Capture 的文件名和尺寸；滚出屏幕放开；没有正文的帖子只显示用户名；离开首页自动结束并保存；帖子页的提示；页面上没有 TubeMuse 发出的请求。冒烟测试核对注入范围。
  - 没有在真实 Instagram 上跑完整扩展（原因同 §52）；结构、画面、声音、静音状态、滚动和结尾的表现是在真实首页上分别核实的，整体留给手测清单（README 新增 8 条）。
- **日后替换**：Instagram 改版时看 `content/clipper.ts` 的 `readIgFeedPost` 和 `core/clips.ts` 的 `parseIgPostUrl`、`igProfileName`、`loopedToStart`；要支持帖子页，在 `feedSiteNow` 里加一支（先改红线）。

## 57. 片段录制：抖音精选页里打开的视频（2026-11-10，用户要求）

- **需求**：在 `www.douyin.com/jingxuan/beauty?modal_id=…` 上 **片段** 页写"当前标签页不是…"。用户要"继续增加对抖音视频的支持"，并举了两个网址说明结构：`/jingxuan?modal_id=<ID>` 和 `/jingxuan/travel?modal_id=<ID>`（`jingxuan` 是抖音精选，`travel` 是类目）。
- **红线**：这是 TubeMuse 第一次往 `www.douyin.com` 注入脚本。没有停下来再问，理由同 §52、§54、§56：用户点名要，要的是现有功能照搬。约束写进 CLAUDE.md §1、§2（请用户过目）。和酷播（§54）相比多读了一样东西：当前这条视频上的作者昵称和描述，原因见下面"标题"；这和 §55 用户选过的"读正文 + 作者"是同一类，范围同样只限正在录的这一条。"只建议，不代办"那一条把抖音加了进去。网络出口不变。
- **范围只到精选页里点开的视频**：网址是 `/jingxuan` 或 `/jingxuan/<类目>`，且带 `modal_id`。这是用户举的两种。`/video/<ID>`、推荐（`/?recommend=1`）、搜索、个人主页里点开的视频（有的也带 `modal_id`）不认，提示"这个页面不是抖音精选里打开的视频"。没有顺手放开：那些页面的结构没有看过，放开等于往没核实过的页面上承诺能录。放开只要改 `parseDouyinUrl` 的路径判断，再改红线。
- **外部事实（2026-11-10 实测，用户的 Chrome，已登录抖音；`/jingxuan?modal_id=7704250528896716072`）**
  - 直接打开带 `modal_id` 的网址就是这条视频（不用先进精选页再点）。
  - **页面上有 3 到 4 个 `<video>`**：正在放的那个（1080×1920，`blob:`，页面上 1017×874）；预先加载的下一条（在屏幕下方，刚开始是直接给地址的 `https://v3-web-prime.douyinvod.com/…`、带 4 个 `<source>`，轮到它播放后约 2 秒变成 `blob:`）；划走以后上一条的也还留在页面上；另有一个空的、高度为 0 的。全部带 `crossorigin="anonymous"`。
  - **"当前这一条"有明确的标记**：`div#sliderVideo[data-e2e="feed-active-video"][data-e2e-vid="<视频ID>"]`，`data-e2e-vid` 和网址里的 `modal_id` 一致，里面只有正在放的那个 `<video>`。别的条目是 `[data-e2e="feed-item"]`。
  - 正在放的视频画到画布上读得到（不是黑帧），`captureStream()` 给出一条音轨一条画面轨，`mediaKeys` 为空。划到的第二条同样。
  - **静音自动播放**：页面右下角提示"因浏览器限制，当前为静音"，`muted=true`、`volume=0.5`。X 上实测过静音时 `captureStream()` 照样有声音（§52），这是浏览器的行为，抖音上没有另测。
  - **划到下一条（按 ↓）**：网址里的 `modal_id` 换成新的，`data-e2e-vid` 同时换；"当前这一条"里的 `<video>` 是另一个元素，旧的那个还连在页面上。按 ↑ 回去，是原来那个元素，接着原来的进度放。
  - **页面标题不跟着变**：点开第一条时是"<描述> - 抖音"，划到下一条、再下一条，一直是第一条的。
  - **作者和描述**：`[data-e2e="feed-video-nickname"]` 的文字是"@云汉AI创投"；`[data-e2e="video-desc"]` 里是描述，后面跟着一个 `<button>展开</button>`。同一个块（`[data-e2e="video-info"]`）里还有发布时间和合集链接。页面标题里的描述和这里的略有不同（这里多了"第13集："）。
  - **放到结尾**：`ended=true`、`paused=true`，约 0.3 秒后网址换成下一条（播放器里"连播"开着）。`loop=false`。
  - 页面上有弹幕层（`[data-e2e="danmaku-container"]`），是盖在视频上的页面元素。
  - **没有核实的**：关掉"连播"后放到结尾是停住还是重播；信息流里的广告、直播条目长什么样；未登录时是否一样（可能有登录弹窗或验证码，碰到了不绕过）；精选页以外的页面；清晰度切换时是否换片源。
- **站点与 ID**：`ClipSite` 加 `'douyin'`。ID 是网址里的 `modal_id`（`parseDouyinUrl`，6–25 位数字）。划到下一条 = `modal_id` 变了 = 换了视频，沿用现有的"ID 变了 → 这一段结束并保存"。
- **取视频（`douyinItem`）**：`[data-e2e="feed-active-video"]` 里的 `<video>`，并且它的 `data-e2e-vid` 要和网址里的 ID 一致（没有这个属性时不卡）。划动的一瞬间两边可能对不上，这时当作画面还没准备好，不会拿上一条的视频配下一条的 ID。没有用"屏幕上最大的"或"正在播的"：旁边预先加载的那条尺寸一样大。
- **换了视频的判断**沿用 YouTube 的（`videoEl()` 还是这个元素、网址里的 ID 没变），没有用 X / Instagram 那套"元素还在不在页面上"：抖音划走以后旧元素还在页面上。
- **标题为什么不用页面标题**：划到下一条时页面标题不更新。用了的话，第二条起 **视频** 一栏、文件名、记录里的标题全是第一条的，而 ID 和链接是新的。所以改读当前这一条上的作者昵称（去掉开头的 `@`）和描述，用 `feedPostTitle` 拼成"作者 - 描述"，和 X、Instagram 的写法一致。`postText` 加了一条"按钮里的文字不要"，去掉描述后面的"展开"。
  - 第一条也用同一个来源，不拿页面标题：两处的描述本来就略有不同，混着用的话同一条视频前后两次录会得到两个文件名。
- **没有广告判断**：抖音的广告是信息流里单独的一条，不是片头，录不录由你划到哪一条决定。侧边栏没有写"广告认不出来"。
- **不提供字幕烧录**：用户没提。侧边栏说明弹幕和播放器另外显示的字幕不会录进去（画布只画视频本身）。
- **录制记录**：`site: 'douyin'` 由后台按发消息的页面定（`fromDouyinPage`）。ID 必须和链接里解析出来的一致。链接存规范形式：路径（含类目）加 `modal_id`，别的参数去掉。"最近录过的片段"标"抖音 ·"。
  - 记录校验里"哪些站的 ID 由链接核对"原来是逐个列举，站多了以后改成"除 YouTube 和小红书以外都是"，解析函数按站点查表。行为没变。
- **放弃**
  - 精选页以外带 `modal_id` 的页面、`/video/<ID>`：见上。
  - 规范链接写成 `/video/<ID>`：那是另一种页面，这次没有看过它，也不在支持范围里；记下的链接点回去应该是能录的页面。
  - 用页面标题：见上。
  - 读 `data-e2e-vid` 当 ID、不看网址：两个都有，网址是用户说明的那个，标记只用来核对。
- **已知风险**
  - 靠的是页面上的 `data-e2e` 标记，抖音改版后可能找不到。找不到视频时提示"没找到这条视频的画面"；找不到作者和描述时文件名退回 `douyin-<视频ID>`。
  - 预先加载的视频刚开始播放时是直接给地址的（带 `crossorigin`），约 2 秒后换成 `blob:`。在这 2 秒里开录：画面读不读得到取决于抖音的 CDN 放不放行，没有测到；读不到时会提示"浏览器不允许读取这个视频的画面"，等一两秒再试。换片源后声音由 `connectAudio` 重接（为 YouTube 写的那套）。
  - 抖音的内容属于作者。录制只在你开始后、实时录正在播放的画面，界面和 README 沿用"仅供个人学习，请勿传播"。
- **测试**
  - 单测（"抖音精选页"11 条）：站点判断；用户给的两种网址；规范链接（多余参数、结尾斜杠）；不算的网址（没有 `modal_id`、不是数字、太短、多一级路径、`/video/`、推荐、发现、搜索、个人主页、伪造域名、http）；标题与页面标题不用；文件名；不能录的说法与 `checkCapture`；`modal_id` 变了和放完时的结束原因；记录校验（ID 与链接对不上、`/video/` 链接、站点由后台定、从 Instagram / YouTube 页面送来）；回到视频；后台保存。
  - e2e：仿抖音精选页 `tests/e2e/douyin-pages.mjs` 照实测结构写（单页应用、当前条目的标记、预先加载的下一条、角落里的空视频、弹幕层、昵称带 `@`、描述后面的"展开"按钮、页面标题不更新、静音播放）。没点开视频时的说明；站内点开后不刷新就能录；选中当前这一条而不是预先加载的那条；标题去掉 `@` 和"展开"、没有混进弹幕；文件名、静音时有声音、记录、链接去掉多余参数、清单标"抖音 ·"；页面原样未动、抖音的元素没被点到；录制中划到下一条自动结束并保存、记在录的那一条名下；侧边栏跟上新的一条，没有用停在上一条的页面标题；Capture 的文件名和尺寸；关掉视频后的说明；页面上没有 TubeMuse 发出的请求。冒烟测试核对注入范围。
  - 没有在真实抖音上跑完整扩展（原因同 §52）；结构、画面、声音、划动和结尾的表现是在真实页面上分别核实的，整体留给手测清单（README 新增 8 条）。
- **日后替换**：抖音改版时看 `content/clipper.ts` 的 `douyinItem`、`douyinTitle` 和 `core/clips.ts` 的 `parseDouyinUrl`；要放开别的页面改 `DOUYIN_FEED_PATH`（先改红线，先看那个页面的结构）。

## 58. 片段录制：抖音搜索结果页里点开的视频（2026-11-11，用户要求）

- **现象**：在 `www.douyin.com/search/大麦哥?aid=…&modal_id=7697926023714737408&type=general` 上，**片段** 页写"这个页面不是抖音精选里打开的视频"。用户要求分析根因并修复。
- **根因**：不是解析出错，是 §57 有意划的范围。`parseDouyinUrl` 只认路径 `jingxuan` 或 `jingxuan/<类目>`；搜索页的路径是 `search/<搜索词>`，虽然同样带 `modal_id`，被当成"别的页面"。当时没放开的理由是"那些页面的结构没有看过"，并写明"放开只要改路径判断，再改红线，先看那个页面的结构"。
- **红线**：CLAUDE.md §2 原文写着"`/video/…`、推荐、搜索、个人主页等别的页面不录"，这次的修复和它冲突。没有停下来再问：用户贴了网址、点名要修，要的就是放开搜索页。CLAUDE.md §1、§2 相应改了（请用户过目），只放开搜索结果页这一种，推荐、个人主页、`/video/` 没有顺手放开（用户没提，结构也没看）。和 §57 相比脚本没有多读任何东西；网址里现在带着搜索词，脚本只用它判断"这是搜索结果页"，不存、不显示、不外发。网络出口不变。
- **外部事实（2026-11-11 实测，用户的 Chrome，已登录抖音；搜索词"大麦哥"，综合和视频两个标签）**
  - 搜索结果里点开一条视频：网址变成 `/search/<搜索词>?modal_id=<视频ID>&type=general`（视频标签下是 `type=video`），不重新加载。用户网址里的 `aid=` 这次没有出现，和识别无关。
  - **点开以后的结构和精选页一样**：`div#sliderVideo[data-e2e="feed-active-video"][data-e2e-vid="<视频ID>"]`，和网址里的 `modal_id` 一致，里面只有正在放的那个 `<video>`（`blob:`，`crossorigin="anonymous"`，`mediaKeys` 为空）；旁边预先加载着下一条（`[data-e2e="feed-video"]`，暂停着）。外层容器是 `#dy-modal-video-container-search_multi_modal[data-e2e="modal-video-container"]`。
  - 作者在 `[data-e2e="feed-video-nickname"]`（"@Michael大麦哥"），描述在 `[data-e2e="video-desc"]`，后面同样跟着"展开"按钮。
  - 画到画布上读得到（不是黑帧、没有报跨域），`captureStream()` 给出一条音轨一条画面轨。这次视频是开着声音播放的（`muted=false`）。
  - 按 ↓：`modal_id` 和 `data-e2e-vid` 同时换成下一条，上一条的 `<video>` 暂停着留在页面上；按 ↑ 回到原来那个元素接着放。和精选页一样。
  - **页面标题一直是"发现更多精彩视频 - 抖音搜索"**，点开视频、划到下一条都不变（精选页是点开时写一次）。标题本来就不用（§57），没有影响。
  - **搜索页的网址从外面打不开这条视频**：直接打开 `/search/<搜索词>?modal_id=<ID>&type=general`（或不带 `type`），抖音把 `modal_id` 丢掉，只显示搜索结果，页面上一个 `<video>` 都没有。直接打开 `/jingxuan?modal_id=<同一个ID>` 则就是这条视频（`data-e2e-vid`、作者都对得上）。
  - **没有核实的**：**用户**、**直播** 两个标签（点开的不是这种视频）；搜索结果里混着的直播、图文、广告条目；未登录时是否一样。
- **改动**：`core/clips.ts` 加 `DOUYIN_SEARCH_PATH`（`search/<一段不含斜杠的搜索词>`），`parseDouyinUrl` 认这种路径。`content/clipper.ts` 的 `douyinItem`、`douyinTitle` 一行没改：结构相同。
- **记下的链接写成 `/jingxuan?modal_id=<ID>`**，不是搜索页的网址。理由就是上面那条实测：搜索页的网址点回去只有搜索结果，回不到视频；精选页的打得开，而且是能录的页面。顺带的好处是搜索词不进录制记录。`clipWatchUrl` 的兜底本来就是这个形式。
  - 后台校验（`sanitizeClipRecord`）不用改：它拿内容脚本送来的网址再解析一遍，ID 对得上才收，存的是解析出来的规范链接。
- **提示语**：`这个页面不是抖音精选里打开的视频…` 改成 `这个页面上没有点开的抖音视频：在精选页（www.douyin.com/jingxuan）或搜索结果里点开一条视频再录`。侧边栏"当前标签页不是…"那一句里的"抖音精选里打开的视频"改成"抖音网页版"，和别的站写法一致（那一句说的是录制脚本没有响应，脚本本来就注入整个站）。
- **放弃**
  - 凡是带 `modal_id` 的抖音页面都认：推荐、个人主页的结构没有看，§57 的理由仍然成立。
  - 记搜索页的网址：回不到视频，还把搜索词留在记录里。
  - 记 `/video/<ID>`：没看过那种页面，也不是能录的页面（§57）。
  - 按 `type` 参数限定综合、视频两个标签：路径相同，别的标签下点不出带 `modal_id` 的视频；真点得出而结构不同时，`douyinItem` 找不到"当前这一条"，提示"没找到这条视频的画面"，不会录错。
- **测试**
  - 单测（"抖音精选页"多 1 条，另改 3 条）：用户给的网址原样（带 `aid`、`type`）、转了码的、带结尾斜杠的，规范链接都是精选页的那种且不含搜索词；没点开视频的搜索页、`modal_id` 不是数字、`/search`、`/search/`、多一级路径、`/searchx/`、伪造域名不算；记录校验（搜索页网址送来 → 存成精选页链接；ID 对不上不收）；提示语。
  - e2e：仿抖音页面加搜索结果页 `/douyin/search/<搜索词>`（页面标题不变、网址带 `type=general`）。没点开时的说明；点开后标题是"作者 - 描述"而不是页面标题；录一段，记录里的链接是 `/douyin/jingxuan?modal_id=…`，不含搜索页网址和搜索词；页面原样未动、没有点到页面元素；Capture 的文件名和尺寸；关掉视频后的说明。
  - 没有在真实抖音上跑完整扩展（原因同 §52）；手测清单（README）加 2 条。
- **日后替换**：要放开推荐、个人主页，在 `parseDouyinUrl` 里再加一种路径（先改红线，先看那个页面的结构，尤其是"从外面直接打开回不回得到视频"）。

## 59. 片段录制：抖音站内搜索的网址前面带着路径（2026-11-11，§58 的补丁）

- **现象**：§58 合并后，用户在 `www.douyin.com/jingxuan/search/大麦哥?aid=…&modal_id=7682374086533631283&type=general` 上仍然看到"这个页面上没有点开的抖音视频"（新提示语，说明扩展已更新）。
- **根因**：§58 只认路径 `search/<搜索词>`，这个网址的路径是 `jingxuan/search/<搜索词>`。§58 核实时是直接输网址打开搜索页的，抖音把它规范成 `/search/<词>`，没有走"在站内搜索框里搜"这条路，漏了这种形式。这是 §58 的核实不到位，不是又一种页面。
- **外部事实（2026-11-11 实测，用户的 Chrome，已登录抖音）**
  - **在站内搜索框里搜，网址是"发起搜索时所在页面的路径 + `/search/<搜索词>`"**：从精选页搜是 `/jingxuan/search/<词>`；从推荐（`/?recommend=1`）搜也是 `/jingxuan/search/<词>`；从关注页搜是 `/follow/search/<词>`；从类目页搜是 `/jingxuan/travel/search/<词>`；从"我的"搜是 `/user/self/search/<词>`。查询参数先是 `aid`、`enter_from`、`source`，随后变成 `aid`、`type=general`。
  - **直接输网址**：`/search/<词>`、`/jingxuan/search/<词>`、`/root/search/<词>` 都被改写成 `/search/<词>`（并丢掉 `modal_id`，同 §58）。
  - `/jingxuan/search/<词>` 上点开一条视频：网址多了 `modal_id`，结构和 §58 一样（`#sliderVideo[data-e2e="feed-active-video"][data-e2e-vid]` 与 `modal_id` 一致，里面一个 `blob:` 的 `<video>`，容器是 `#dy-modal-video-container-search_multi_modal`；作者、描述、"展开"按钮同样；画到画布读得到，`captureStream()` 一条音轨一条画面轨）。
  - `/follow/search/<词>` 上还没点开视频时，页面里留着关注页自己的 `[data-e2e="feed-active-video"]`（别的视频的 ID）。`douyinItem` 要求 `data-e2e-vid` 和网址里的 `modal_id` 一致，不会把它当成点开的那条。
  - **没有核实的**：`/follow/search/`、`/jingxuan/<类目>/search/`、`/user/self/search/` 上点开视频以后的结构。连着搜了几次以后抖音弹出了图片验证码，没有绕过，核实停在这里。
- **改动**：`DOUYIN_SEARCH_PATH` 改成 `search/<搜索词>` 前面允许 0 到 3 段路径。规范链接仍是 `/jingxuan?modal_id=<ID>`。`DOUYIN_FEED_PATH` 顺带把类目名 `search` 排除（`/jingxuan/search?modal_id=…` 没有搜索词，不是类目页也不是搜索结果页）。
- **为什么按"任意前缀"认，而不是只加 `jingxuan/`**：前缀是你发起搜索时所在的页面，实测至少 5 种，逐个列举一定会再漏。几种前缀下是同一个搜索结果组件（页面标题、参数、弹层容器的 ID 都一样）。没核实过点开结构的那几种如果真不一样，`douyinItem` 找不到和 `modal_id` 对得上的"当前这一条"，会提示"没找到这条视频的画面"，不会录错视频。这一点和 §57"不往没核实过的页面上承诺能录"有出入，README 的已知限制里写明了哪几种核对过。
- **红线**：CLAUDE.md §1、§2 里"搜索结果页"的写法补上了带前缀的形式。范围没有变宽到别的页面：仍然只是搜索结果页里点开的视频。
- **放弃**
  - 只加 `jingxuan/search/`：见上。
  - 前缀不限段数：实测最多两段（`jingxuan/travel`、`user/self`），留到 3 段（别人主页 `user/<ID>` 也是两段）。
- **测试**
  - 单测：用户给的第二个网址原样、`follow/`、`jingxuan/travel/`、`user/self/` 前缀、搜索词本身是"search"；不算的多了没点开视频的、`/jingxuan/search`（没有搜索词）、`searchx`、多一级路径、4 段前缀、伪造域名；记录校验（带前缀的搜索页网址 → 精选页链接）。
  - e2e：搜索结果页那一组改用 `/douyin/jingxuan/search/<搜索词>?aid=…`（站内搜索的真实形式）。直接输网址的 `/search/<词>` 形式由单测覆盖。
- **教训**：核实网址形式时要走用户实际会走的路（站内点、站内搜），不能只直接输网址；抖音会改写直接输入的网址。
## 60. 「问 muse」：把正在看的视频整理成一段咨询包文字（2026-11-11，用户要求）

- **要求**：侧边栏顶部加「问 muse」按钮。点一下就冻结当前视频的播放位置（只记下点击那一刻的位置，不暂停），生成一段咨询包文字，由用户自己复制、粘贴到 Muse 聊天（`https://muse.ai/`）里提问；界面提供"生成 / 复制 / 打开 muse.ai"。覆盖扩展支持的全部视频平台，统一字段：平台、页面链接、标题、作者、播放位置、上下文、我的问题，末尾附给 Muse 的回答要求。用户同时划了范围：不嵌入 Muse、不调 Muse API、不自动发送；不调 LLM、不花钱；不新增权限和域名；不碰其他功能；咨询包里不出现 Key / 令牌；只读当前这条视频 / 帖子；内容脚本不发请求、不改页面；不下载音视频流。
- **结构**
  - 页面上的信息由片段录制脚本（`content/clipper.ts`）交回：它已经注入全部 6 个站，也已经会认"当前这一条"（首页信息流上锁定哪个视频、抖音的"当前这一条"、酷播的播放器）。加一条消息 `tubemuse:muse:snapshot`，在收到的那一刻同步读一次，回一个快照。没有另写一个内容脚本：那样要把"认当前视频"的逻辑复制一份，两份迟早不一致。
  - 拼咨询包是纯函数（`core/muse.ts`）：校验快照、选上下文、截断、拼字段、去掉像 Key / 令牌的内容。侧边栏（`ui/sidepanel/MuseAsk.tsx`）只管按钮、问题输入和三个操作。
  - `services/muse-service.ts` 的 `freezeMuse` 做"冻结"：问页面要快照；是 YouTube 时再取已有的字幕和作者。
- **冻结**：点击后侧边栏查出当前标签页、发消息，录制脚本收到时读 `video.currentTime`。中间是两次扩展内部的异步调用，通常几十毫秒；位置按秒显示，够用。没有为了更准而让脚本一直记着位置：那等于每个视频页都在后台跑一份"问 muse"的状态。再点一次「问 muse」就是重新冻结。
- **各站读什么**（都只读当前这一条）

  | 站 | 链接 | 标题 | 作者 | 正文 / 描述 | 播放位置 |
  |---|---|---|---|---|---|
  | YouTube | 由视频 ID 拼，带 `&t=秒数s` | 页面标题（读不到时用官方接口给的） | 官方 `videos.list` 的频道名（不读页面） | 不取（见下） | 播放器里的视频；广告中、Shorts 不给 |
  | 小红书 | `/explore/<笔记ID>`，不带 `xsec_token` | 页面标题 | 笔记详情作者栏的名字（**新读**） | `#detail-desc`（**新读**） | 笔记里的视频；图文笔记不给 |
  | X 帖子页 | 帖子规范链接 | 无 | 页面标题里的作者 | 页面标题里的正文 | 正在看的那个视频；没有视频不给 |
  | X 首页信息流 | 锁定的视频所在帖子的链接 | 无 | 这条帖子的作者名 | 这条帖子的正文 | 锁定的视频 |
  | Instagram 首页 | 同上（`/p/<短码>/`） | 无 | 用户名 | 露出来的正文 | 锁定的视频 |
  | 抖音 | `/jingxuan?modal_id=<ID>`（或带类目） | 无 | 昵称 | 描述 | 当前这一条 |
  | 酷播 | 播放页规范链接 | 页面标题 | 无 | 无 | 播放器里的视频；认得出的片头广告期间不给 |

- **红线**
  - **新读的只有一处**：小红书笔记详情里这篇笔记的作者名和正文。CLAUDE.md §2 原来写小红书的录制脚本"读取的页面信息只限播放器状态与页面标题"。没有停下来再问：用户的要求里点名了"该条帖子 / 笔记的正文 / 描述"，并自己给了边界（只读当前这条、不发请求、不改页面）。CLAUDE.md §1、§2 相应加了一条（请用户过目）。
  - 其余都是**已经在读的信息换了个用途**：X、Instagram 首页信息流那一条帖子的作者和正文，抖音当前这条的昵称和描述，各站的页面标题和网址。以前只用来显示、起文件名、记链接；现在还会进咨询包，而咨询包是用户自己粘贴出去的。
  - **YouTube 的作者不读页面**。§2 写着"YouTube 数据只走官方 YouTube Data API v3"，注入 YouTube 的脚本能读什么也是逐项列的。所以作者走官方 `videos.list`：先看本机缓存（`videoMeta`，和观看记录、自动字幕共用），没有才查一次（1 unit，记进配额，沿用 `lookupVideoMeta`）。配额不是钱，但会让顶部的 units 涨 1：面板底部和 README 写明了。最多等 5 秒（`MUSE.authorLookupMs`），等不到就写「无」并说明，查到的结果留给下一次。
  - **YouTube 的描述不取**：`VideoMeta` 不存描述；要取得改那份共用缓存的结构（碰了观看记录和自动字幕），或者每次冻结单独查一次不缓存。用户说了"不碰其他功能"，YouTube 的上下文又通常由字幕承担，所以没做。结果是 YouTube 没有已读到的字幕时，上下文只有标题。这是和"上下文第 2 优先级"的一处出入，README 的已知限制里写了。
  - **YouTube 的字幕只用已经有的**：多语字幕脚本内存里这个视频已经读到的（加一条消息 `tubemuse:muse:captions`，只交回位置前后 30 秒的那几句），否则本机存的自动字幕（侧边栏直接读 `subtitles:<视频ID>`）。不为此去取字幕：取字幕要让播放器开一次字幕（改页面）、由内容脚本发请求，两条都是用户划掉的。面板里会提示"想带上字幕，先打开多语字幕或自动字幕"。
  - 网络出口不变。`https://muse.ai/` 只由侧边栏用 `chrome.tabs.create` 在新标签页打开，写在 `config/endpoints.ts` 的 `MUSE_CHAT_URL`（不在 `ENDPOINTS` 里，所以不进 `host_permissions` / `connect-src`；e2e 构建换成本机 mock 的空页面）。构建时检查：网络出口里没有它，注入网页的脚本里也没有它的地址。
- **咨询包里的取舍**
  - **X、Instagram、抖音的标题写「无」**。这三个站的帖子 / 视频没有单独的标题；片段页显示的"作者 - 正文"是 TubeMuse 自己拼的名字，放进"标题"就是编造。作者和正文各有各的字段。
  - **上下文只取一种**，按用户给的优先级：位置前后 30 秒的已有字幕 / 转写 → 正文 / 描述 → 只有标题 → 无。括号里写明用的是哪一种（哪种字幕、哪种语言、是不是 YouTube 自动翻译）。
  - **多语字幕取哪种语言**：按用户排的语言顺序，第一种已经读到的。只放一种：几种语言一起放，字数翻倍，Muse 也用不上。
  - **截断**：上下文最多 2000 字（`MUSE.contextMaxChars`）。字幕从离冻结位置最远的句子丢起，注明保留了哪一段；正文留开头，注明原文多长。按码点数，不会把一个表情截成半个。
  - **字幕一句一行、行首带时间**（`[02:04] …`）：回答要求里让 Muse"引用位置或原文"，有时间才引得了位置。
  - **播放位置**写成 `mm:ss / 总时长`，满一小时写 `h:mm:ss`（用户写的是 mm:ss；一小时以上的视频写成 `72:03` 不好认）。位置读不到整项写「未知」，只有总时长读不到时写 `12:03 / 未知`。
  - **时间参数**：只有 YouTube 的链接拼 `&t=秒数s`；位置读不到时不拼，Shorts 不拼。别的站只给链接。
  - **没有视频的笔记、帖子也能问**（小红书图文笔记、X 的文字帖子）：位置写「未知」，面板里说明原因。认不出"当前这一条"时不生成，说明原因（不是视频页、信息流里没有开着声音在播的视频、广告帖子认不出链接）。
  - **广告期间**（YouTube、酷播认得出的那种）位置不给：那时读到的是广告的进度。Shorts 的位置也不给：站内从播放页跳到 Shorts 时，原来的播放器还留在页面上，读它会读到上一个视频的位置。
- **Key / 令牌**
  - 链接只用规范链接（`museItem`）：YouTube 由 ID 拼；别的站沿用片段录制的解析（去掉分享参数）。**小红书的 `xsec_token` 不带**：它是令牌。代价是这个链接从外面打开时小红书可能要求登录（收藏和片段记录里留着它，正是因为要点回去）；咨询包里的链接是给 Muse 看"这是哪篇"，不是给用户点回去用的。这一条如果用户更想要能打开的链接，改 `museItem` 一处即可。
  - 整段文字最后过一遍 `redactMuse`：本机存的 Key / 令牌原样出现时换成"[已隐藏]"，看起来像 Key / 令牌的也换（页面文字、字幕、用户的问题里都可能有，例如教程视频里念出来的 Key）。没有直接用 `core/redact.ts`：那是给报错信息用的，宁可多遮（`sk-` 后面跟 16 个字符就算），放在这里会把"task-management-…"这类普通的词遮掉。
  - 页面交回的数据逐项校验（`sanitizeMuseSnapshot`）：站点、ID 与链接要对得上，文字去控制字符并截断。
- **界面**
  - 按钮放在顶部头部（配额条和 ⚙ 之间），面板在头部下面展开，哪个标签页下都能用。没有做成第 11 个导航标签：用户要的是"顶部的按钮"，而且它是对着正在看的视频用的，切走当前页面不合适。
  - 点「问 muse」就冻结并生成一版（还没写问题时"我的问题"是「无」）。改了问题，咨询包不自己变，提示"点生成更新"；**"复制"总是先按现在的问题更新再复制**，免得拷走一份过时的。
  - 复制用 `navigator.clipboard.writeText`（扩展页面里由点击触发，不需要 `clipboardWrite` 权限）；被拒时全选文本框、用浏览器自带的复制，再不行就说明让用户按 Ctrl+C。
  - 冻结失败（认不出视频、标签页里没有脚本）时，上一次的咨询包不留着，免得把别的视频的内容当成这一次的。
  - 咨询包不存本机：关掉侧边栏就没了，也不进导出。没有做历史记录（用户没提）。
- **外部事实（2026-11-11 实测，Claude 内置浏览器，未登录，rednote.com）**：笔记详情 `#noteContainer` 里，正文是 `.note-content > #detail-desc.desc > span.note-text`，里面是一段段 `<span>` 文字和 `<a class="tag">#话题</a>`，换行是文字里的换行符（`white-space: pre-wrap`），没有 `<br>`；作者栏 `.author-wrapper:has(> .info) a.name` 有两份、名字相同（一份藏着，同 §43）；评论区的 `.author-wrapper` 里没有 `.info`。页面标题是"笔记标题 - rednote"。照录制脚本的取字办法在这一页上跑了一遍，取到的正文和页面上的一致（137 字，含 5 个话题）。
- **没有核实的**：登录后的小红书、视频笔记的正文（看的是图文笔记，结构应相同）；正文里的表情图片、@提及；muse.ai 的聊天页能不能直接粘贴这么长的文字（没有打开过它）；真实 YouTube / X / Instagram / 抖音 / 酷播上装好扩展后点「问 muse」（各站的取字逻辑沿用片段录制实测过的那些，e2e 用的是仿页面）。手测清单在 README。
- **放弃**
  - 读 YouTube 页面上的频道名、描述：红线，见上。
  - 为「问 muse」取 YouTube 字幕：要动播放器、要内容脚本发请求。
  - 把咨询包直接带进 muse.ai（网址参数、注入脚本自动填）：用户明确不要自动发送；也要给 muse.ai 加权限。
  - 嵌入 Muse、调它的 API：用户明确不要。
  - 冻结时暂停视频：用户明确说不用。
  - 另起一个"问 muse"内容脚本：见"结构"。
- **测试**
  - 单测（`tests/unit/muse.test.ts`，42 条）：时间与链接（只有 YouTube 拼 `&t=`）、各站规范链接（`xsec_token`、分享参数去掉）、认不出当前视频时的原因、快照校验（ID 与链接对不上不要）、位置前后 30 秒取句、咨询包全文（YouTube + 字幕、小红书正文、只有标题、全是「无」）、截断（字幕保留最近的、正文留开头、不截半个表情）、去 Key / 令牌（含不误伤）、X 页面标题拆作者和正文、冻结流程（没有脚本、别的站不发任何请求、YouTube 作者查一次并缓存、自动字幕兜底、没连接 / 查不到 / 超时都说明）。
  - e2e：6 个站的仿页面各点一次「问 muse」并核对咨询包；生成 / 复制（粘贴出来核对）/ 打开 muse.ai（只是开了本机 mock 的空页面，网址里什么都不带）；冻结后视频没有暂停、页面没有变化、没有点到页面元素；全程没有大模型请求；权限和域名没有变。
- **日后替换**：要支持 YouTube 描述，给 `VideoMeta` 加一个字段并在 `mapVideoMeta` 里填（先确认用户同意动那份缓存）；要把小红书链接改成能从外面打开的，在 `museItem` 里保留 `xsec_token`（先改红线）；换一个聊天去处，改 `MUSE_CHAT_URL` 和 `MUSE.answerRule`。

## 61. CI 提速：e2e 分组并行、去掉白等的时间、合并后不重跑（2026-11-11，用户要求）

- **现象**：CI 每次 11–12 分钟，还在慢慢变长（#32 11m9s → #42 12m16s）；同一个改动跑两遍（PR 一遍，合并进 `main` 又一遍）。
- **时间花在哪里**（#42 的 job 日志，按时间戳算）：整个 job 12m16s，其中"End-to-end and production smoke tests"一步 11m15s（92%）；检出、装 Node、`npm ci`、类型检查、单测、下载 Chromium 加起来不到 1 分钟。e2e 这一步里：

| 段落 | 秒 |
|---|---|
| 开头的"设置" | 40（其中 30 秒是白等，见下） |
| 主流程（授权、画像、口令、打分、Phase 2 / 3、豆瓣） | 116（其中 92 秒是真的在看 3 个视频） |
| 自动字幕 | 59 |
| 多语字幕 | 121 |
| 片段录制（YouTube） | 77 |
| 小红书 / X / Instagram / 抖音 / 酷播 | 20 / 33 / 14 / 22 / 19 |
| eMails | 31 |
| 设置页每一项都存得上 | 116（几乎全是白等，见下） |
| 重启浏览器、红线、正式版冒烟 | 8 |

- **根因**
  1. e2e 是一个 3000 行的脚本，在一个浏览器里从头跑到尾，而且大部分时间是真实时间的等待（录几秒、播几秒、等重试间隔），机器再快也省不下来。每加一个站多 9–20 秒：这就是耗时一直在涨的原因（#31 到 #42 之间加了 X 信息流、Instagram、抖音、抖音搜索，e2e 这一步从 614 秒涨到 675 秒）。
  2. 白等的 30 秒：保存 Anthropic Key 之后等的是"页面上出现'已保存'这句话"，但这句话只写在输入框的 placeholder 里，永远等不到；等满 30 秒超时被 `.catch()` 吞掉，下一行才去读 placeholder。从写下这一行起每次都白等。
  3. 白等的 110 秒：设置页那一节遍历 28 个勾选框、各点两下，这时设置页是后台标签页。Playwright 点击前要连着两帧确认元素没在动，而后台标签页一秒才出一帧，每点一下约 2 秒（本地与 CI 都是 113 秒）。
  4. 合并进 `main` 的那一次，检查的内容和 PR 上那一次一模一样（PR 检查的就是与 `main` 合并后的结果）。
- **选了什么**
  - **e2e 拆成 3 组，CI 上每组一个 job 并行跑**（`tests/e2e/shards.json`）：`core`（主流程 + eMails + 问 muse + 设置页与重启）、`subtitles`（自动字幕 + 多语字幕）、`clips`（片段录制：YouTube 和 5 个站）。每组一台 runner、一个全新的浏览器和 mock 服务，开头各走一遍"设置"（填 Key、连接 YouTube，约 6 秒）。类型检查、单测、正式版冒烟另放一个 job `checks`。`verify` 改成只汇总结果的 job，名字没变，分支保护不用动。
  - **脚本按功能拆成文件**：`harness.mjs`（浏览器、mock、网络护栏、"设置"、结尾的网络红线）、`parts/core.mjs`、`subtitles.mjs`、`clips.mjs`、`emails.mjs`、`muse.mjs`、`settings.mjs`，`run-e2e.mjs` 只负责按组调度。各节的代码是原样搬过去的，一行检查都没有删改；除搬家必需的几处接线（侧边栏页改成从 `harness` 取、X Token 常量挪到 `harness`、重启浏览器后把新的浏览器写回 `harness`、X 动图的填充方式）外，只改了下面两处白等。
  - **本地 `npm run e2e` 走同一条路**：不带参数时按顺序把 3 组各跑一遍（一组一个子进程），所以"本地 `npm run verify` 过了基本等于 CI 过"仍然成立。只想跑一组：`node tests/e2e/run-e2e.mjs --shard=clips`。
  - **去掉白等**：等 placeholder 换成"已保存"（最多 5 秒，之后那条检查原样保留）；设置页那一节开头把设置页切到前台（你自己改设置时它也在前台）。
  - **合并后不重跑**：全部检查通过后，`verify` 上传一个以文件树哈希命名的小标记（artifact `verified-tree-<tree>`，保留 30 天）。`main` 上的 push 先由 `gate` 查这棵文件树有没有标记：有，说明内容和验过的一模一样，后面的 job 全部跳过，运行摘要里写明是哪一次运行验过的；没有（例如验完以后 `main` 又进了别的改动，合并结果变了），照常全跑。`gate` 自己出错按"没验过"处理。点"Re-run"时不查标记，照常全跑；手动运行（workflow_dispatch）默认查，勾 `force` 则不查。只认本仓库自己的运行留下的标记（fork 的 PR 也能上传同名 artifact）。
  - **`playwright install chromium --no-shell`**：e2e 和冒烟用的都是完整的 Chromium（`channel: 'chromium'`），118 MB 的 Headless Shell 是白下的，每个 job 省约 6 秒。
- **怎么确认没有少查东西**
  - 改动前的完整运行与改动后 3 组的输出逐条对过：原来的 500 项检查一项不少；多出来的 38 项是另外两组各自重复的"设置"（10 项）和"网络红线"（9 项）。原脚本 2871 行非空代码里，新文件中找不到原样的只有 30 行，全是接线和下面说的两处白等；含 `check(` 的行 508 对 508。
  - 这个 PR 开着的时候 §60（问 muse）先合并进了 `main`，它往旧脚本里插了一整块（343 行、56 条检查，核对过是纯插入，别处一行没动）。这一块原样搬成 `parts/muse.mjs`，放在 `core` 那一组里 eMails 之后、设置页之前，和它在旧脚本里的位置一样；它借用的前面两节里的小工具（`llmCount`、`ccStatus`）各补了一行相同的定义。56 条检查与它自己那次 CI（#44）的输出逐条对过。
  - 拆开后各部分之间除了 `harness` 提供的东西外没有共用变量：e2e 脚本受 `tsc` 检查（`tsconfig.scripts.json`），漏传的会直接编译不过。
  - 结尾的网络红线每一组都查自己发出的全部请求。"确实发过 LLM 请求"只在会调大模型的组里要求（片段那一组不调）；X 的 5 条红线只在主流程那一组查（别的组没有填 X Token，没有东西可查）。
  - `tests/unit/ci-shards.test.ts` 守着三件事：CI 的 matrix 和 `shards.json` 列的组一致（不然漏掉的组在 CI 上不跑也不报错）；`parts/` 下的每一部分恰好属于一组；`verify` 仍然汇总所有 job，并且前面的 job 失败或取消时也会跑。
  - 设置页那一节改到前台后点得快了，单独连跑 15 轮没有出现新的赛跑。
- **一个要记住的顺序依赖**：`settings`（设置页每一项都存得上）要排在别的部分后面。它拿"点之前存储里的设置"和"点两下之后的"比，全新的浏览器里设置还没写进过存储，第一个勾选框会报"复原不了"（单独跑时实测）。它又会重启浏览器，所以必须是所在那一组的最后一个（单测守着）。
- **为什么 `verify` 用 `if: always()`**：前面的 job 失败或被取消时，默认行为是把依赖它的 job 跳过，而被跳过的必过项在分支保护里算"通过"。`always()` 让它每次都跑，并且只有 `checks` 和 `e2e` 全是 success（或 `gate` 确认这棵文件树验过）才返回成功。
- **实测**
  - 本地（Linux，4 核，合并 §60 之前）：改动前 `npm run verify` 约 681 秒（e2e 673 秒）；改动后 555 秒，其中 3 组分别 161 / 190 / 190 秒，按顺序跑（并行只在 CI 上）。
  - CI（Windows，合并 §60 之前的第一次运行 #45）：整次运行 4 分 12 秒（改动前 #42 是 12 分 16 秒）。`checks` 1 分 0 秒；e2e 三个 job 各 3 分 33 秒（`core`，其中跑测试 167 秒）、3 分 41 秒（`subtitles`，186 秒）、4 分 3 秒（`clips`，199 秒）；`verify` 4 秒。下载 Chromium 从 16 秒降到 8–12 秒。
  - 合并 §60 之后 `core` 那一组多了"问 muse"（它在自己那次 CI 上用了 30 秒），三组差不多一样长，整次运行仍由最长的一组决定。
  - "验过就不重跑"：#45 通过后在同一个提交上手动运行了一次（#47），`gate` 3 秒查到标记，`checks` 和 e2e 全部跳过，整次运行十几秒。`main` 上 push 的那条路要等这个 PR 合并后才第一次真正走到。
- **放弃 / 没做的**
  - **一个 job 里开几个进程并行**：不用多占 runner，但 runner 只有 4 核，几个 Chromium 同时录像、编码会互相抢 CPU，而这套测试里对时序敏感的检查不少（§45 记过两处）；mock 的端口还是写死在测试构建里的，得先改构建脚本。每组一台 runner 的负载和现在一样，最稳。代价是总的机器分钟数从约 12 变成约 14（公开仓库免费）。
  - **缩短真实时间的等待**：看 3 个视频要 92 秒是因为"有效观看不足 30 秒算瞥一眼"按真实时间计，16 倍速也得放够 30 秒以上；片头广告那一节等 13 秒 + 录 12 秒是复现 MP4 文件头问题的最低条件（§39）。这些等待就是在测的东西，压缩它们等于改测试内容。
  - **后台标签页里点击慢（没解决，只绕开了设置页那一处）**：侧边栏在测试里是当标签页开的，被测页面在前台时它就在后台，点一下要 1–2 秒。片段那一组 76 次点击里 42 次是这样，合计约 69 秒（占这一组的 37%）；字幕那一组同理。试过的启动参数（`--disable-frame-rate-limit`、`--mute-audio`、关 occlusion、关后台节流的几个特性）没有得出可靠的结论：节流什么时候开始本身就不固定（一次是前台页面开始播放视频之后，一次是一切到后台就开始），同样的参数这一次不节流不能说明是参数起的作用。改成 `click({ force: true })` 能到 10 毫秒，但会跳过"看得见、点得到、没被挡住"的检查，而且全套测试的节奏都会变，之前调好的时序要重新验证。收益约每组 1 分钟，风险是必过项变得不稳，这次不做。
  - **缓存 Chromium 下载**：去掉 Headless Shell 后下载加解压约 10 秒。没有实测缓存；还原几百 MB 的缓存在 Windows runner 上通常也要十秒上下，预期没有收益，还多一份要维护的缓存键。
  - **换到 Linux runner**：单步会快一些，但 e2e 的音频、录制、下载只在 Windows 上长期验证过（§46），日常开发也在 Windows；这次本地在 Linux 上跑通是另一回事（还得先把 locale 设成 UTF-8，否则下载文件名里的中文会变成 "download"）。
  - **直接去掉 `main` 上的 push 触发**：最省事，但只有分支保护要求"合并前分支必须先跟上 `main`"时才安全，这一项我读不到（没有读分支保护设置的权限），§46 也没有写。没开的话，两个 PR 先后合并时 `main` 上的结果可能谁都没验过。按文件树判断不依赖这个设置：只在内容确实一样时才跳过。
  - **把片段那一组再拆开**：它现在是最长的一组（跑测试约 3.3 分钟），以后每加一个站还会变长。没拆是因为 Capture 的序号是跨站连着排的，后面各站的检查接着前面的序号（"序号接着 YouTube 的往下排"）；拆开后各组从头排，这条跨站的检查就弱了。等它明显超过别的组时再拆，拆法：YouTube + 小红书一组，X / Instagram / 抖音 / 酷播一组，后一组开头自己先 Capture 一张。
- **日后如何替换**：加一组 = `shards.json` 加一项 + `ci.yml` 的 matrix 加一个名字（单测会提醒）。新站的检查写进 `parts/clips.mjs`。想回到一个 job：把 matrix 去掉、`run` 改回 `npm run e2e` 即可，脚本不带 `--shard` 时就是全跑。不想要"合并后不重跑"：删掉 `gate` job 和各 job 的 `needs: gate` / `if`。

## 62. Capture：截图同时放进系统剪贴板（2026-11-11，用户要求）

- **需求**：点 Capture 后，除了原有的 PNG 直接下载，截图同时进系统剪贴板，切到别的应用可以直接 Ctrl+V 粘贴。
- **红线变更（用户 2026-11-11 要求，CLAUDE.md §1、§2 同步）**：原红线写的是"传回侧边栏后由浏览器存进下载文件夹"，没有剪贴板。这是用户点名要的、并要求直接实施的功能；图不出本机、不经过网络、不新增权限，所以照 §50 的先例没有停下来再问，把"同时放进系统剪贴板"写进六个站的 Capture 红线，细则写在 YouTube 那一条。
- **做法**：侧边栏拿到 PNG 后，用浏览器自带的 `navigator.clipboard.write([new ClipboardItem({ 'image/png': … })])` 写入（`src/ui/shared/clipboard.ts` 的 `copyPngToClipboard`）。录制脚本不变、不碰剪贴板；六个站共用侧边栏这一处，所以一起生效。
  - **在点击的那一刻就登记，图稍后给**：`ClipboardItem` 的值传的是一个 Promise，`write()` 在点击处理函数的同步代码里就调用，PNG 取回来后才兑现。按 Chromium 的实现，"页面有焦点"是在调用 `write()` 时检查的（没有单独实测：Playwright 里每个页面都算有焦点）；等图传回来（几次消息往返，1080p 约 1 秒）再调的话，用户这时已经切到别的窗口（这正是这个功能的用法）就会被拒，报 `Document is not focused`。先登记的写法对"调用时检查"和"要求刚被点过"两种实现都成立。
  - **下载在前，剪贴板在后**：先 `downloadBlob`，再把图兑现给剪贴板。原有的下载不依赖剪贴板这一步，剪贴板失败、卡住都不影响文件。
  - **没截成不动剪贴板**：广告、缓冲、DRM、没传回来时把那个 Promise 拒绝掉，浏览器放弃这次写入，剪贴板里原来的内容还在（e2e 钉死），界面只报截图的原因，不另报剪贴板。
- **失败怎么说（不静默降级）**：成了，"截图已交给浏览器存进下载文件夹，也已放进剪贴板"；没成，另起一行"这张图没能放进剪贴板：<原因>。文件照常存下了"。原因分三种：没有焦点、浏览器不让写（带上浏览器给的原话）、浏览器不支持。另设 5 秒上限（`CLIPS.captureClipboardTimeoutMs`，从图兑现时起算）：浏览器一直不回应时也给出说明，Capture 按钮不会一直卡在"截图中"。
- **没有新增权限**：扩展页面里由点击触发的 `clipboard.write` 不需要 `clipboardWrite`（§60 的"复制"同理）；`manifest` 不变，smoke 的权限检查照常有效。
- **放弃**
  - 等图取回来再 `clipboard.write(blob)`：见上，切走窗口就失败，而用户的用法就是马上切走。
  - 在录制脚本（页面里）写剪贴板：那是在别人的页面里动剪贴板，要页面有焦点（用户点的是侧边栏，页面没有），还得扩大注入脚本的红线。
  - `document.execCommand('copy')` + 临时 `<img>`：复制出来的是 HTML 片段加位图，各应用粘贴结果不一；已废弃。
  - `clipboardWrite` 权限 / offscreen 文档：多一项权限，换不到什么。
  - 设置里加开关：用户要的就是"同时"；写剪贴板失败不影响下载。要加时在 `ClipsView.capture` 一处判断。
- **已知限制**
  - 粘贴出来的图是浏览器重新编码过的（Chromium 把 PNG 解码成位图放进系统剪贴板），画面和尺寸一样（e2e 核对了尺寸和取样点的颜色，没有逐像素比），文件不是同一个；要原文件用下载的。
  - 图进了剪贴板后归操作系统管：开着系统的剪贴板历史 / 跨设备同步时会被记下或同步，README 写明。
  - 8K 的图解码成位图约 130 MB，写剪贴板会慢，超过 5 秒会报"没写完"（实际可能稍后写进去）。没有实测过。
  - 加了 `clipboard.write` 之后真实的下载限流（§50）是否仍然每次放行：`clipboard.write` 不消耗用户激活，按理不影响；Playwright 测不出限流，列进了手测清单。
- **测试**
  - 单测（`tests/unit/clipboard.test.ts` 8 条）：点击那一刻就登记、图出来才写；截图没成算 skipped、什么都没写；没有焦点 / 不让写 / `write` 直接抛错 / 不支持时的说法；浏览器不回应时到点说明，等图的时间不算；上限是有限正数。
  - e2e（片段组）：先往剪贴板放文字 → Capture → 在侧边栏按 Ctrl+V，粘贴事件里拿到 `image/png`，1920×1080、左红右蓝，侧边栏写"也已放进剪贴板"；广告时点 Capture，剪贴板原样未动、不报剪贴板的错；让 `clipboard.write` 像没有焦点那样拒绝 → 文件照常存下（序号照常递增）、界面说明原因、剪贴板里还是原来的文字；X 上再粘贴一次（720×1280），证明别的站走的是同一条路。原有检查一条没删。
  - 没有验证的：粘贴到浏览器以外的应用；Comet；真实下载限流（见上）。都在 README 的手测清单里。

## 63. 「问 muse」：章节、简介、自动取 YouTube 字幕、新的末尾指令（2026-11-11，用户手测后要求；改了 §60 的红线）

- **现象**：§60 合并后用户在一个 40 分钟的中文播客上点「问 muse」，问"科普一下 Memory note 具体是什么"。咨询包的上下文只有标题，而且标题在"标题"和"上下文"里各写了一遍。用户给了四条改进：加章节和简介；字幕直接取 YouTube 自带的，不要等手动打开；换末尾那句指令；上下文只有标题时不要重复。
- **第 4 条的理解**：用户的原文在这里留了一处没填的"请补充"（重复指的是咨询包里标题写了多次，还是 Muse 回答时复述上下文）。按截图里红框标的现象处理：咨询包把标题在"上下文"一行又抄了一遍。Muse 怎么回答不归 TubeMuse 管。
- **改动**
  1. **章节**：咨询包新增"章节"一行，只放当前位置所在的那一章和前后各一章（`上一章 [mm:ss] …；当前 [mm:ss] …；下一章 [mm:ss] …`）。章节从简介里认（`parseChapters`）。
  2. **简介**：新增"简介"一项，放官方接口给的简介正文，超过 1500 字（`MUSE.descriptionMaxChars`）留开头并注明原文多长。
  3. **字幕**：在 YouTube 上点「问 muse」时，多语字幕脚本为这一次提问取视频自带的一种语言的字幕（见下）。顺序是：已经读到的 YouTube 字幕 → 现取 → 本机存的自动字幕 → 「无字幕」。
  4. **末尾指令**换成用户给的原话（`MUSE.answerRule`）。原来的"请用中文回答"没有了：用户给的新句子里没有它。
  5. **只有标题时**写"上下文：只有上面的标题（没有字幕 / 转写，也没有正文 / 描述）"，不再把标题抄一遍。YouTube 没取到字幕时写"上下文：无字幕"（简介另有一项，不算上下文）。
- **统一字段**："章节""简介"两项所有平台都有，YouTube 以外写「无」。§60 的规则是"所有平台使用统一字段，没有就写无"，没有为 YouTube 单独开例外。别的平台的正文 / 描述仍然在"上下文"里（按 §60 的优先级），没有挪进"简介"：那是用户定下并验过的结构。
- **简介和章节从哪来**：官方 `videos.list`（part=snippet，1 unit）。§60 没取简介的理由是"共用的 `videoMeta` 缓存不存简介，改它就碰了别的功能"。这次用户明确要，做法是**另开一份小缓存** `museVideos`（标题、频道名、完整简介，只留最近 30 个问过的视频），`videoMeta` 一个字段没动。代价：`videoMeta` 里已经有的视频，第一次「问 muse」仍要查一次（1 unit）。
  - 没用现成的 `yt.videos()`：它把简介截到 1000 字，章节列表常在简介后半段。加了 `yt.videoIntro()`，简介不截。
  - 没连接、查不到、5 秒没回时：简介和章节写「无」并说明；作者还可以用 `videoMeta` 里的（不花配额）。
- **章节怎么认**：一行一个"时间 + 标题"，时间要在一行的开头或结尾（前后只能是符号、序号），正文中间顺带提到的时间不算；取时间连续递增的最长一段，至少三行才算。**比 YouTube 自己的规则宽**（它要求第一个是 0:00）：第一版照 YouTube 的规则写，结果在用户手测的那个视频上一章都认不出——它的简介写的是 `1. [01:13] RSI：…` 到 `10. [36:25] …`，带序号和方括号，也不从 0:00 写起（2026-11-11 用内置浏览器看了那个视频的真实简介）。用户要的是"简介里的章节列表"，这种列表正是；所以不再要求 0:00。位置在第一章之前时写"下一章 …（当前位置在第一章之前）"，不硬凑一个"当前"。YouTube **自动生成的章节**（简介里没写的那种）官方 Data API 不给，认不到，写「无」；要拿只能读页面或播放器数据，是红线，没做。
  - 有章节但播放位置没读到（广告中）时写"未知（…这个视频分了 N 章）"，不猜是哪一章。
- **⚠️ 红线：自动取字幕**
  - §60 写的是"YouTube 的字幕只用已经有的，不为此再取字幕、不动播放器"，用户最初给这个功能划的线里也有"不在 content script 里发请求""不改页面"。这次的要求（"优先直接取 YouTube 自带的字幕 / 转写（timedtext），不要等用户手动打开"）和它们冲突。
  - **没有停下来再问**：用户点名了 timedtext，要的就是这条路；这条路只有一种走法（§37）：字幕接口要带播放器生成的令牌，原生字幕关着时得请播放器打开一次字幕才拿得到带令牌的请求，再由注入页面的脚本向同源的 `/api/timedtext` 取。也就是**内容脚本会发请求、播放器的字幕会被短暂打开再关上**。CLAUDE.md §1、§2 相应改了，PR 里单独标出请用户过目。
  - 范围收得尽量小：只在点「问 muse」时、只对正在看的视频、只取**一种**语言（多语字幕最多四种）、不显示字幕层、字幕只在那个标签页的内存里、只把位置前后 30 秒的句子交给侧边栏。请求仍是多语字幕脚本里那**唯一一处** `fetch`（构建检查没变：只能有一处、只取同源的 `/api/timedtext`），地址照样先过 `trackUrl` 校验。页面内助手一行没改。
  - **可关**：面板里有"YouTube：点「问 muse」时自动取视频自带的字幕"（`settings.muse.fetchCaptions`，默认开）。关掉后回到 §60 的行为：只用已经读到的。产品原则第 6 条"所有自动行为可关闭"。
  - 原生字幕**开着**却没看到带令牌的请求时不再请播放器选轨：那会换掉用户正在看的字幕。这时说明原因，不取。
- **取哪一种语言**（`museSource`）：按用户在多语字幕里排的语言顺序，视频自带的第一种；不用 YouTube 自动翻译（译文不是原话，Muse 要引用原文）。用户选的语言视频都没有时，用它的第一条字幕轨（多半是自动生成的原声字幕）。没有为了认"原声语言"再查一次 YouTube：只多一次配额，换来的只是语言顺序上的差别。
- **取的过程**（`museCaptions`，在 `content/multi-captions.ts`）：读字幕轨列表（最多等 2.5 秒）→ 没有带令牌的请求时请播放器选这条轨，等它发出请求（最多 6 秒），然后立刻把为此打开的字幕关回去 → 复用那处请求取这条轨 → 交回位置前后 30 秒的句子。整个过程最多 8 秒（`MUSE.captionFetchMs`），侧边栏再多等 2 秒兜底。没取到时带回原因（没有字幕轨、播放器没给请求、YouTube 出错、超时），面板里写出来，后面跟着原来那句"想带上的话，先在字幕页打开…"。
  - 多语字幕正开着时不插手：它自己在取，等它读到。它和「问 muse」共用 `primeOwnedSince` 这个"原生字幕是我们打开的"标记，中途用户打开多语字幕时由它接手收尾。
  - 两次「问 muse」挨得很近时排队，不会同时请播放器选两次轨。
- **冻结会变慢**：以前一瞬间，现在在 YouTube 上要等取字幕（通常一两秒，最坏 8 秒）。播放位置仍是点击那一刻记下的，不受影响；面板里写"位置已记下，正在取这个视频的字幕和资料…"。
- **放弃**
  - 把简介塞进 `videoMeta`：碰别的功能，见上。
  - 不请播放器选轨、只在"已经有带令牌的请求"时取：原生字幕关着的人（多数情况）永远取不到，等于没做。
  - 取"显示文字记录"面板里的转写：那是读页面 / 调 YouTube 的内部接口，红线。
  - 多取几种语言、或把整段字幕都交给侧边栏：用不上，也超出"只读当前这一段"。
  - 别的平台也加"简介"的内容：它们的正文已经在"上下文"里。
- **测试**
  - 单测（55 条，新增 13 条）：章节解析（常见写法、用户那个视频的真实写法、不是章节的不认、当前章和前后各一章、位置在第一章之前、位置未知）、简介截断、「无字幕」、只有标题时标题只出现一次、新的末尾指令原话、所有平台都有"章节""简介"两项、`museVideos` 只留最近的、冻结流程（查一次并记住、请求的是 part=snippet、关掉自动取时发 `fetch: false`、没取到时的原因和提示、自动字幕兜底、字幕脚本不回话时不干等）。
  - e2e：仿 YouTube 页面（假播放器）上不开多语字幕直接点「问 muse」——带上了字幕，播放器只被调了字幕开关、取完原生字幕是关着的、没有字幕层、页面别处没动，字幕请求是"播放器 1 次 + 我们 1 次"；再点一次不再取；关掉开关时不取、不碰播放器；没有字幕轨的视频写「无字幕」并说明；章节随位置对得上；简介来自 mock 的 `videos.list`；同一个视频只查一次。酷播核对标题不重复，小红书核对统一字段。
- **外部事实（2026-11-11，Claude 内置浏览器，未登录，用户截图里的那个视频）**：简介 598 字，里面是上面说的那种时间列表；播放器给出的字幕轨是 0 条（画面上的字是做在视频里的）。所以这个视频的咨询包会是：章节对得上（17:22 落在"[16:18] Continual Learning：…Memory Notes…"那一章）、简介全文带上、上下文「无字幕」。要字幕只能开自动字幕（语音识别）。
- **没有核实的**：真实 YouTube 上用「问 muse」取字幕（取法与多语字幕相同，那条路 2026-11-02 在真实 YouTube 上实测过；这次只在假播放器上跑）——尤其是字幕闪一下有多明显、对用户保存的字幕偏好的影响；真实视频简介里各种章节写法；Muse 对新指令的反应。手测清单在 README。
- **日后替换**：要认 YouTube 自动生成的章节，得另找合规的来源（现在没有）；想让字幕不闪，只能等用户自己开着原生字幕时顺带取（已经是这样：开着时不用再请播放器选轨）。
