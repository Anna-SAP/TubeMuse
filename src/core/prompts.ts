// 发给 LLM 的全部内容都在这里组装（数据最小化：只放完成任务所需的信息，绝不含 Key、Token、账号标识、频道 ID）。
// README「发给 LLM 的数据」一节与本文件一一对应。

import { LLM_LIMITS } from '../config/defaults';
import { CHANNEL_MODES, CONSTRAINT_KINDS, EVENT_TYPES, FORMAT_KINDS, QUALITY_ASPECTS, SORT_BYS } from './types';
import type { ChannelInfo, InterestCluster, LikedVideo, UnderstandingCorrection } from './types';
import { truncate } from './text';

export type JsonSchema = Record<string, unknown>;

const str = { type: 'string' };
const num = { type: 'number' };
const strArr = { type: 'array', items: { type: 'string' } };
const enumOf = (values: readonly string[]) => ({ type: 'string', enum: [...values, 'none'] });

/** 意图解析输出结构。未用字段用空值（""、0、[]、"none"），避免各家对 null 支持不一。 */
export const INTENT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['interpretation', 'topic', 'queries', 'constraints'],
  properties: {
    interpretation: str,
    topic: str,
    queries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['q', 'language'],
        properties: { q: str, language: str },
      },
    },
    constraints: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'kind',
          'span',
          'label',
          'importance',
          'terms',
          'language',
          'withinHours',
          'minMinutes',
          'maxMinutes',
          'format',
          'aspect',
          'channelNames',
          'mode',
          'minViews',
          'count',
          'sortBy',
          'eventType',
          'regionCode',
          'description',
        ],
        properties: {
          kind: { type: 'string', enum: [...CONSTRAINT_KINDS] },
          span: str,
          label: str,
          importance: { type: 'string', enum: ['hard', 'soft'] },
          terms: strArr,
          language: str,
          withinHours: num,
          minMinutes: num,
          maxMinutes: num,
          format: enumOf(FORMAT_KINDS),
          aspect: enumOf(QUALITY_ASPECTS),
          channelNames: strArr,
          mode: enumOf(CHANNEL_MODES),
          minViews: num,
          count: num,
          sortBy: enumOf(SORT_BYS),
          eventType: enumOf(EVENT_TYPES),
          regionCode: str,
          description: str,
        },
      },
    },
  },
};

export interface IntentPromptInput {
  utterance: string;
  nowIso: string;
  timeZone: string;
  clusters: Pick<InterestCluster, 'name' | 'keywords'>[];
  corrections: UnderstandingCorrection[];
}

export function buildIntentPrompt(input: IntentPromptInput): { system: string; user: string } {
  const clusterLines = input.clusters
    .slice(0, 12)
    .map((c) => `- ${c.name}：${c.keywords.slice(0, 8).join('、')}`)
    .join('\n');
  const correctionLines = input.corrections
    .map((c) => {
      const what = c.constraint ? `「${c.constraint.span || c.constraint.label}」被理解为「${c.constraint.label}」，这是错的` : '整体意图被理解错了';
      return `- 原句「${truncate(c.utterance, 80)}」中${what}${c.note ? `。用户说明：${truncate(c.note, 150)}` : ''}`;
    })
    .join('\n');

  const system = [
    '你是 TubeMuse 的意图解析器。把用户的一句找片口令解析成结构化 JSON，程序会据此调用 YouTube Data API 搜索。只做解析，不要推荐具体视频。',
    `当前时间：${input.nowIso}（用户时区 ${input.timeZone}）。`,
    '',
    '规则：',
    '1. 找出口令里的每一个约束。类别：topic 主题、language 语言、recency 时效、duration 时长、format 形式、quality 质量、caption 字幕、exclude_shorts 排除 Shorts、exclude_terms 排除词、channel 频道、subscriptions_only 只看订阅频道、min_views 最低播放量、definition 清晰度、live 直播、region 地区、sort 排序偏好、count 数量；不属于这些类别的任何要求都用 other。',
    '2. span 必须逐字复制原句中的连续片段（不改写、不翻译、不补字）。一个片段只归入一个约束。',
    '3. 宁可多列，不可漏列；但不要编造原句里没有的要求。拿不准类别就用 other，并在 description 里用中文说明。',
    '4. importance：明确要求或排除的为 hard；"最好""尽量""偏向"之类的偏好为 soft。',
    '5. 未使用的字段填空值：字符串 ""，数字 0，数组 []，枚举 "none"。',
    '   - language：ISO 639-1 小写代码（en、zh、ja……）。',
    '   - recency.withinHours：从当前时间往前推的小时数，如"两天内"=48，"近一周"=168，"今天"=24。',
    '   - duration：minMinutes / maxMinutes，如"一小时以上" minMinutes=60。',
    '   - format：terms 给出可用于匹配标题的中英文关键词（如 访谈、interview、对谈）。',
    '   - caption：若要求特定语言的字幕，把语言写进 language。',
    '   - definition：要求 4K 等具体规格时把原词写进 terms。',
    '   - channel：channelNames + mode（only 只要 / exclude 排除 / prefer 优先）。',
    '   - sort："最新的"= sort/recency；"最火的"= sort/popularity。',
    '   - other：description 说明要求；若能用关键词近似判断，在 terms 里给出关键词，否则 terms 为空。',
    '6. 主题必须作为一个 kind=topic 的约束列出，terms 给出中英文核心检索词。',
    '7. queries：1–3 条给 YouTube 搜索框用的检索词，简短、像真人会搜的词。用户限定了语言时用该语言写；未限定时可中英文各一条（language 填对应代码）。时长、字幕、时效等能用参数表达的约束不要写进检索词。',
    '8. interpretation：用一句中文复述你理解的意图。topic：用几个字概括主题。',
    clusterLines ? `\n用户的兴趣簇（只用于消歧，不要据此添加约束）：\n${clusterLines}` : '',
    correctionLines ? `\n用户过去对理解结果的纠正（请遵守）：\n${correctionLines}` : '',
  ]
    .filter((l) => l !== '')
    .join('\n');

  return { system, user: truncate(input.utterance, LLM_LIMITS.utteranceMaxChars) };
}

export const CLUSTER_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['clusters'],
  properties: {
    clusters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'description', 'keywords', 'channelRefs', 'nature'],
        properties: { name: str, description: str, keywords: strArr, channelRefs: strArr, nature: { type: 'string', enum: ['learning', 'entertainment', 'other'] } },
      },
    },
  },
};

export interface ClusterPromptInput {
  channels: ChannelInfo[];
  likedVideos: LikedVideo[];
  locked: Pick<InterestCluster, 'name' | 'description' | 'keywords'>[];
  /** Takeout 观看历史里常看的频道（只有名称与观看次数） */
  watchedChannels?: { id: string; title: string; count: number }[];
}

/** 频道用本地短编号（c1、c2…）引用，返回编号 → 真实频道 ID 的映射，ID 不出本机。 */
export function buildClusterPrompt(input: ClusterPromptInput): { system: string; user: string; refs: Map<string, string> } {
  const refs = new Map<string, string>();
  const refOf = new Map<string, string>();
  const known = new Set(input.channels.map((c) => c.id));
  const extra: ChannelInfo[] = (input.watchedChannels ?? [])
    .filter((w) => !known.has(w.id))
    .slice(0, LLM_LIMITS.clusterMaxWatchedChannels)
    .map((w) => ({ id: w.id, title: w.title, description: '', topicCategories: [] }));
  const watchCount = new Map((input.watchedChannels ?? []).map((w) => [w.id, w.count]));
  const channels = [...input.channels, ...extra].slice(0, LLM_LIMITS.clusterMaxChannels);
  channels.forEach((c, i) => {
    const ref = `c${i + 1}`;
    refs.set(ref, c.id);
    refOf.set(c.id, ref);
  });
  const channelLines = channels.map((c) => {
    const topics = c.topicCategories.map((t) => decodeURIComponent(t.split('/').pop() ?? '').replace(/_/g, ' ')).filter(Boolean);
    const desc = truncate(c.description.replace(/\s+/g, ' '), LLM_LIMITS.channelDescriptionChars);
    const watched = watchCount.get(c.id);
    return `${refOf.get(c.id)} | ${c.title}${desc ? ` | ${desc}` : ''}${topics.length ? ` | 主题：${topics.join(', ')}` : ''}${watched ? ` | 看过 ${watched} 次` : ''}`;
  });
  const likedLines = input.likedVideos.slice(0, LLM_LIMITS.clusterMaxLikedTitles).map((v) => {
    const ref = refOf.get(v.channelId);
    return `${ref ?? '-'} | ${truncate(v.title, 100)}`;
  });
  const lockedLines = input.locked.map((c) => `- ${c.name}：${c.description}（关键词：${c.keywords.join('、')}）`);

  const system = [
    '你是 TubeMuse 的兴趣画像助手。根据用户订阅的频道和点赞过的视频标题，归纳 4–10 个兴趣簇。',
    '每个簇给出：name（简短中文名）、description（一句话）、keywords（5–12 个中英文关键词，用于匹配视频标题）、channelRefs（属于该簇的频道编号，如 c3）、nature（这个兴趣主要是 learning 学习 / entertainment 娱乐 / other 说不清）。',
    '规则：每个频道最多归入一个簇；不好归类的频道不要硬塞；只使用输入里出现过的编号。',
    lockedLines.length ? `以下簇已被用户确认，必须原样保留名称（可以往里补充频道）：\n${lockedLines.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const user = [`订阅/相关频道（编号 | 名称 | 简介 | YouTube 主题 | 观看次数）：`, ...channelLines, '', '点赞过的视频（频道编号 | 标题）：', ...likedLines].join('\n');
  return { system, user, refs };
}

export const PING_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['ok'],
  properties: { ok: { type: 'boolean' } },
};

// ───────────────────────── Phase 2：每日总结 / 每周自省 ─────────────────────────

export const DAILY_SUMMARY_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['headline', 'learned', 'revisit', 'goalLink'],
  properties: {
    headline: str,
    learned: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['ref', 'takeaway'], properties: { ref: str, takeaway: str } },
    },
    revisit: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['ref', 'reason'], properties: { ref: str, reason: str } },
    },
    goalLink: str,
  },
};

export interface DailyPromptItem {
  ref: string;
  title: string;
  channelTitle: string;
  category: string;
  nature: string;
  status: string;
  completionPct: number;
  minutes: number;
  background: boolean;
}

export interface DailyPromptInput {
  day: string;
  goals: string;
  items: DailyPromptItem[];
  previous: { day: string; headline: string; learned: string[] }[];
  utterances: string[];
}

/** 每日总结：只发标题、频道名、分类、观看程度与时长；条目用本地编号 v1、v2… 引用，不发视频 ID。 */
export function buildDailySummaryPrompt(input: DailyPromptInput): { system: string; user: string } {
  const system = [
    '你是 TubeMuse 的学习记录助手。根据用户今天在 YouTube 上真正看过的视频，写一份简短、具体、不夸大的每日学习总结。',
    '输出 JSON：',
    '- headline：一句话概括今天（20–40 字）。',
    '- learned："今日学了什么"。只从看完或部分观看、且属于学习/其他的条目里挑，每条给出 ref 和一句具体收获（根据标题合理推断，不编造细节；拿不准就写"了解了……的基本内容"）。没有就给空数组。',
    '- revisit："值得回看"。挑出没看完但值得补完、或信息密度高值得复习的条目，给出 ref 和理由。没有就给空数组。',
    '- goalLink："与近期目标的关联"。结合用户的近期目标与过去几天的总结，说明今天的观看和目标的关系（推进了什么、偏离了什么、明天可以做什么），2–4 句。用户没写目标时，根据最近几天的学习主题推断其可能的方向，并明确说明是推断。',
    '规则：只能引用输入里出现过的 ref；不要评判娱乐内容，也不要说教；不要输出任何链接。',
  ].join('\n');
  const lines = input.items.map(
    (i) =>
      `${i.ref} | ${truncate(i.title, 100)} | ${truncate(i.channelTitle, 40)} | ${i.category || '未知分类'} | ${i.nature} | ${i.status}${i.status === '部分观看' ? ` ${i.completionPct}%` : ''} | 有效观看 ${i.minutes} 分钟${i.background ? ' | 后台收听' : ''}`,
  );
  const prev = input.previous.map((p) => `- ${p.day}：${truncate(p.headline, 60)}${p.learned.length ? `；学了：${truncate(p.learned.join('；'), 200)}` : ''}`);
  const user = [
    `日期：${input.day}`,
    `近期目标：${input.goals.trim() ? truncate(input.goals.trim(), 300) : '（用户没有填写）'}`,
    '',
    '今天的观看（编号 | 标题 | 频道 | YouTube 分类 | 学习/娱乐/其他 | 观看程度 | 时长）：',
    ...lines,
    '',
    input.utterances.length ? `今天在 TubeMuse 里说过的找片口令：${input.utterances.map((u) => `「${truncate(u, 60)}」`).join('、')}` : '',
    prev.length ? `过去几天的总结（保持连续性）：\n${prev.join('\n')}` : '过去几天没有总结。',
  ]
    .filter((l) => l !== '')
    .join('\n');
  return { system, user };
}

export const WEEKLY_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['overview', 'patterns'],
  properties: {
    overview: str,
    patterns: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['pattern', 'suggestion', 'refs'],
        properties: { pattern: str, suggestion: str, refs: strArr },
      },
    },
  },
};

export interface WeeklyPromptCase {
  ref: string;
  title: string;
  channelTitle: string;
  rating: number;
  attribution: string;
  utterance: string;
  note: string;
}

/** 每周自省：只发低分案例（标题、频道、分数、归因、当时的口令、用户说明），条目用 r1、r2… 引用。 */
export function buildWeeklyPrompt(cases: WeeklyPromptCase[], adjustments: string[]): { system: string; user: string } {
  const system = [
    '你是 TubeMuse 的自省助手。下面是用户本周打了低分（≤5 分）的推荐，以及系统已经据此自动做出的调整。',
    '找出这些低分案例的共性（例如：某类口令总被理解偏、某类频道总排得太前、标题党、语言不对……），每条共性给出：pattern（一句话）、suggestion（用户或系统下一步可以怎么做，具体可执行）、refs（支持这条共性的案例编号）。',
    '另给 overview：2–3 句总体观察。只依据输入，不编造；案例太少看不出共性时如实说明。',
  ].join('\n');
  const user = [
    '低分案例（编号 | 标题 | 频道 | 分数 | 归因 | 当时的口令 | 用户说明）：',
    ...cases.map((c) => `${c.ref} | ${truncate(c.title, 80)} | ${truncate(c.channelTitle, 40)} | ${c.rating} 分 | ${c.attribution} | ${truncate(c.utterance, 60)} | ${c.note ? truncate(c.note, 120) : '—'}`),
    '',
    '系统本周已自动做出的调整：',
    ...(adjustments.length ? adjustments.map((a) => `- ${a}`) : ['- 无']),
  ].join('\n');
  return { system, user };
}

// ───────────────────────── Phase 3：X 热点 ─────────────────────────

export const HOTSPOT_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['hotspots'],
  properties: {
    hotspots: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'summary', 'refs', 'utterance'],
        properties: { title: str, summary: str, refs: strArr, utterance: str },
      },
    },
  },
};

export interface HotspotPromptPost {
  ref: string;
  topic: string;
  text: string;
  likes: number;
  reposts: number;
  hoursAgo: number;
}

/** X 热点：只发帖子正文与互动数（不发作者、帖子 ID、Token）；帖子用 p1、p2… 引用。 */
export function buildHotspotPrompt(posts: HotspotPromptPost[], minItems: number, maxItems: number): { system: string; user: string } {
  const system = [
    `你是 TubeMuse 的热点编辑。下面是用户各个兴趣主题在 X 上最近 24 小时互动较高的帖子。把它们归纳成 ${minItems}–${maxItems} 条"热点"（帖子不够时可以少于 ${minItems} 条，宁缺毋滥）。`,
    '每条热点：title（中文，15 字以内）、summary（一句中文，说清发生了什么、为什么值得关注；只依据帖子内容，不编造）、refs（支持这条热点的帖子编号，至少 1 个）、utterance（一句可直接交给 TubeMuse 在 YouTube 找片的中文口令，例如"找最近两天讲解 XX 的视频"，要具体、能搜到视频）。',
    '规则：只使用输入里出现过的编号；同一事件合并成一条；广告、抽奖、纯情绪发泄、无信息量的帖子不要做成热点；不输出链接。',
  ].join('\n');
  const user = ['帖子（编号 | 主题 | 点赞 | 转发 | 多久前 | 正文）：', ...posts.map((p) => `${p.ref} | ${p.topic} | ${p.likes} | ${p.reposts} | ${p.hoursAgo} 小时前 | ${p.text.replace(/\s+/g, ' ')}`)].join('\n');
  return { system, user };
}
