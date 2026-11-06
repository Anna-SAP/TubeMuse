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

- **选了什么**：`.github/workflows/ci.yml` 只有一个 job `verify`，依次跑 `npm ci`、`npm run setup`、类型检查、单元测试、装 Chromium、e2e（含正式版冒烟），与 `npm run verify` 检查内容相同。`main` 加分支保护：必须走 PR（0 个审批，不要求 review）、`verify` 必须通过，管理员不例外，禁止强推和删除。
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
- **CI**：只在 PR 和 `main` 上跑（取代 §46 的"所有分支 push"）。仓库是公开的，Actions 本来就免费，省的是等待：每次 push 从两遍 10 分钟变成一遍。通过的运行不再上传产物，保留 7 天。代价：没开 PR 的分支不自动检查，本地 `npm run verify` 仍是提交前的要求。
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
