// 意图 → 搜索计划。每个约束都会得到至少一条"落实方式"（Disposition），回显据此逐条展示。

import { formatHoursWindow, toRfc3339 } from './time';
import { languageName, FORMAT_LABELS } from './constraints';
import { matchedTerms, normalize, uniqueStrings } from './text';
import type {
  CheckSpec,
  Constraint,
  CoverageStatus,
  Disposition,
  Intent,
  PlannedQuery,
  RankDirectives,
  SearchPlan,
} from './types';

export interface PlannerContext {
  now: number;
  subscriptions: { id: string; title: string }[];
  profileSynced: boolean;
  searchCallsPerQuery: number;
  generalUnitsPerQuery: number;
  defaultResults: number;
  expandedResults: number;
  /** 设置里的默认地区，空表示不限定 */
  regionCode?: string;
}

const HOUR_MS = 3_600_000;

/** relevanceLanguage 需要 zh-Hans / zh-Hant 区分简繁 */
export function toRelevanceLanguage(code: string): string {
  if (code === 'zh') return 'zh-Hans';
  if (code === 'yue') return 'zh-Hant';
  return code;
}

/** 由分钟区间推导 search.list 的 videoDuration 档位（short <4 分钟，medium 4–20，long >20）。 */
export function deriveVideoDuration(minMinutes?: number, maxMinutes?: number): 'short' | 'medium' | 'long' | undefined {
  const min = minMinutes ?? 0;
  const max = maxMinutes ?? 0;
  if (min >= 20) return 'long';
  if (max > 0 && max <= 4) return 'short';
  if (min >= 4 && max > 0 && max <= 20) return 'medium';
  return undefined;
}

export function coverageStatus(ds: Disposition[]): CoverageStatus {
  const hard = ds.some((d) => d.type === 'api_param' || d.type === 'post_filter');
  const soft = ds.some((d) => d.type === 'query_term' || d.type === 'rank_factor' || d.type === 'result_count');
  const unsupported = ds.some((d) => d.type === 'unsupported');
  const ref = ds.some((d) => d.type === 'reference_only');
  if (unsupported && (hard || soft)) return 'partial';
  if (unsupported) return 'unsupported';
  if (hard) return 'enforced';
  if (soft) return 'approximate';
  if (ref) return 'reference_only';
  return 'unsupported';
}

function resolveChannels(names: string[], subs: { id: string; title: string }[]): { ids: string[]; titles: string[]; unresolved: string[] } {
  const ids: string[] = [];
  const titles: string[] = [];
  const unresolved: string[] = [];
  for (const name of names) {
    const n = normalize(name);
    const exact = subs.find((s) => normalize(s.title) === n);
    const fuzzy = exact ?? subs.find((s) => normalize(s.title).includes(n) || n.includes(normalize(s.title)));
    if (fuzzy) {
      ids.push(fuzzy.id);
      titles.push(fuzzy.title);
    } else unresolved.push(name);
  }
  return { ids, titles, unresolved };
}

export function planSearch(intent: Intent, ctx: PlannerContext): SearchPlan {
  const dispositions: Record<string, Disposition[]> = {};
  const add = (c: Constraint, d: Disposition) => (dispositions[c.id] ??= []).push(d);
  const common: Record<string, string> = { part: 'snippet', type: 'video', maxResults: '50' };
  const postFilters: CheckSpec[] = [];
  const softChecks: CheckSpec[] = [];
  const notes: string[] = [];
  const rank: RankDirectives = {
    freshness: false,
    popularity: false,
    engagement: false,
    authority: false,
    depth: false,
    formatTerms: [],
    topicTerms: [],
    referenceTerms: [],
    preferChannelIds: [],
    preferChannelNames: [],
  };
  let withinHours: number | undefined;
  let fixedLanguage: string | undefined;
  let resultCount = ctx.defaultResults;
  const exclusions: string[] = [];
  const queryAppend: string[] = [];
  let checkSeq = 0;
  const check = (c: Constraint, spec: Omit<CheckSpec, 'id' | 'constraintId' | 'label'>, label: string): CheckSpec => ({
    id: `k${++checkSeq}`,
    constraintId: c.id,
    label,
    ...spec,
  });
  const route = (c: Constraint, spec: CheckSpec, filterDetail: string, note?: string) => {
    if (c.importance === 'soft') {
      softChecks.push(spec);
      add(c, { type: 'rank_factor', detail: `软约束：满足「${spec.label}」的视频加分，不满足也保留`, note });
    } else {
      postFilters.push(spec);
      add(c, note ? { type: 'post_filter', detail: filterDetail, note } : { type: 'post_filter', detail: filterDetail });
    }
  };

  for (const c of intent.constraints) {
    const p = c.params;
    switch (c.kind) {
      case 'topic': {
        rank.topicTerms.push(...(p.terms ?? []));
        add(c, { type: 'query_term', detail: '检索词据此生成' });
        add(c, { type: 'rank_factor', detail: `主题命中：标题/标签含「${(p.terms ?? []).slice(0, 4).join('、')}」的加分` });
        break;
      }
      case 'language': {
        const lang = p.language ?? '';
        fixedLanguage = lang;
        add(c, {
          type: 'api_param',
          param: 'relevanceLanguage',
          value: toRelevanceLanguage(lang),
          note: '只影响相关性，不是语言过滤',
        });
        const latinOnly = !['zh', 'yue', 'ja', 'ko'].includes(lang) && lang !== 'en';
        route(
          c,
          check(c, { kind: 'language', language: lang }, languageName(lang)),
          `保留音频/默认语言为${languageName(lang)}的视频`,
          latinOnly
            ? '元数据缺失时无法区分拉丁语系语言，这类视频会保留并标注"语言未确认"'
            : '元数据缺失时按标题文字推断，可能有误差',
        );
        break;
      }
      case 'recency': {
        const h = p.withinHours ?? 0;
        if (c.importance === 'soft') {
          rank.freshness = true;
          softChecks.push(check(c, { kind: 'recency', withinHours: h }, formatHoursWindow(h)));
          add(c, { type: 'rank_factor', detail: `软约束：${formatHoursWindow(h)}发布的加分，新鲜度权重放大` });
          break;
        }
        withinHours = withinHours === undefined ? h : Math.min(withinHours, h);
        add(c, {
          type: 'api_param',
          param: 'publishedAfter',
          value: toRfc3339(ctx.now - h * HOUR_MS),
          note: `当前时间往前 ${formatHoursWindow(h).replace('内', '')}`,
        });
        postFilters.push(check(c, { kind: 'recency', withinHours: h }, formatHoursWindow(h)));
        add(c, { type: 'post_filter', detail: '复核发布时间（防止缓存期间越界）' });
        break;
      }
      case 'duration': {
        const minS = p.minMinutes ? p.minMinutes * 60 : undefined;
        const maxS = p.maxMinutes ? p.maxMinutes * 60 : undefined;
        const bucket = c.importance === 'hard' ? deriveVideoDuration(p.minMinutes, p.maxMinutes) : undefined;
        if (bucket) {
          common.videoDuration = bucket;
          add(c, {
            type: 'api_param',
            param: 'videoDuration',
            value: bucket,
            note: { short: '档位：4 分钟以内', medium: '档位：4–20 分钟', long: '档位：20 分钟以上' }[bucket],
          });
        }
        const spec: Omit<CheckSpec, 'id' | 'constraintId' | 'label'> = { kind: 'duration' };
        if (minS !== undefined) spec.minSeconds = minS;
        if (maxS !== undefined) spec.maxSeconds = maxS;
        route(
          c,
          check(c, spec, c.label.replace('时长：', '时长 ')),
          '按 videos.list 返回的精确时长过滤',
          bucket || c.importance === 'soft' ? undefined : 'API 的时长档位无法表达这个区间，只靠后置过滤，候选可能变少',
        );
        break;
      }
      case 'format': {
        const terms = p.terms ?? [];
        rank.formatTerms.push(...terms);
        const inQuery = intent.queries.some((q) => matchedTerms(q.q, terms).length > 0);
        if (inQuery) add(c, { type: 'query_term', detail: '检索词中已包含形式词' });
        add(c, {
          type: 'rank_factor',
          detail: `形式匹配：标题/简介含「${terms.slice(0, 4).join('、')}」的加分`,
          note: `API 无法可靠判定视频是否为${FORMAT_LABELS[p.format ?? 'other']}，只能按关键词近似`,
        });
        break;
      }
      case 'quality': {
        const aspect = p.aspect ?? 'other';
        const explain: Record<string, string> = {
          popular: '热度：播放量越高越加分',
          high_engagement: '口碑：点赞/播放比越高越加分',
          authoritative: '权威：频道规模与你的订阅关系加分',
          in_depth: '深度：时长更长、互动更好的加分',
          production: '制作：用播放量与互动近似',
          other: '质量：用播放量、点赞率、频道规模综合近似',
        };
        if (aspect === 'popular' || aspect === 'production' || aspect === 'other') rank.popularity = true;
        if (aspect === 'high_engagement' || aspect === 'production' || aspect === 'other') rank.engagement = true;
        if (aspect === 'authoritative') rank.authority = true;
        if (aspect === 'in_depth') rank.depth = true;
        add(c, { type: 'rank_factor', detail: explain[aspect] ?? explain.other!, note: '"质量"无法直接度量，这是近似信号' });
        break;
      }
      case 'caption': {
        if (c.importance === 'hard') {
          common.videoCaption = 'closedCaption';
          add(c, { type: 'api_param', param: 'videoCaption', value: 'closedCaption' });
        }
        route(c, check(c, { kind: 'caption' }, '有字幕'), '复核 contentDetails.caption', '只认上传者提供的字幕，自动生成字幕无法通过 API 查询');
        if (p.language) {
          add(c, {
            type: 'unsupported',
            reason: `无法确认字幕是否为${languageName(p.language)}（需逐条调用 captions.list，每次 50 units，成本过高）`,
          });
        }
        break;
      }
      case 'exclude_shorts': {
        postFilters.push(check(c, { kind: 'not_shorts' }, '非 Shorts'));
        add(c, { type: 'post_filter', detail: '剔除 Shorts', note: 'API 没有 Shorts 标记：按时长 ≤ 60 秒，或 ≤ 3 分钟且带 #shorts 判定' });
        break;
      }
      case 'exclude_terms': {
        const terms = p.terms ?? [];
        const queryable = terms.filter((t) => !/\s/.test(t));
        exclusions.push(...queryable);
        if (queryable.length) add(c, { type: 'query_term', detail: `检索词加上 ${queryable.map((t) => `-${t}`).join(' ')}` });
        postFilters.push(check(c, { kind: 'exclude_terms', terms }, `不含「${terms.join('、')}」`));
        add(c, { type: 'post_filter', detail: '标题/简介/标签/频道名含排除词的剔除' });
        break;
      }
      case 'channel': {
        const names = p.channelNames ?? [];
        const { ids, titles, unresolved } = resolveChannels(names, ctx.subscriptions);
        const mode = p.mode ?? 'prefer';
        if (mode === 'prefer') {
          rank.preferChannelIds.push(...ids);
          rank.preferChannelNames.push(...unresolved);
          add(c, { type: 'rank_factor', detail: `「${names.join('」「')}」的视频加分` });
          break;
        }
        if (mode === 'exclude') {
          postFilters.push(check(c, { kind: 'channel_exclude', channelIds: ids, channelNames: unresolved }, `排除「${names.join('、')}」`));
          add(c, { type: 'post_filter', detail: '剔除这些频道的视频', note: unresolved.length ? `「${unresolved.join('、')}」不在订阅中，按频道名文字匹配` : undefined });
          break;
        }
        // only
        if (ids.length === 1 && unresolved.length === 0) {
          common.channelId = ids[0]!;
          add(c, { type: 'api_param', param: 'channelId', value: ids[0]!, note: `你订阅的「${titles[0]}」` });
        } else if (unresolved.length) {
          queryAppend.push(...unresolved);
          add(c, { type: 'query_term', detail: `检索词加上频道名「${unresolved.join('」「')}」` });
        }
        postFilters.push(check(c, { kind: 'channel_only', channelIds: ids, channelNames: unresolved }, `只要「${names.join('、')}」`));
        add(c, {
          type: 'post_filter',
          detail: '只保留这些频道的视频',
          note: unresolved.length ? `「${unresolved.join('、')}」不在你的订阅中，只能按频道名文字匹配，可能不准` : undefined,
        });
        break;
      }
      case 'subscriptions_only': {
        if (!ctx.profileSynced) {
          add(c, { type: 'unsupported', reason: '还没有同步订阅列表，无法限定为订阅频道（先在"画像"页同步）' });
          break;
        }
        postFilters.push(check(c, { kind: 'subscribed' }, '订阅频道'));
        add(c, { type: 'post_filter', detail: '只保留你订阅的频道', note: 'search.list 不能直接限定订阅频道：先搜后滤，结果可能很少' });
        break;
      }
      case 'min_views': {
        route(c, check(c, { kind: 'min_views', minViews: p.minViews ?? 0 }, c.label), '按 videos.list 的播放量过滤');
        break;
      }
      case 'definition': {
        const wants4k = (p.terms ?? []).some((t) => /4k|8k|2160/i.test(t));
        if (c.importance === 'hard') {
          common.videoDefinition = 'high';
          add(c, { type: 'api_param', param: 'videoDefinition', value: 'high', note: '高清 = 720p 及以上' });
        }
        route(c, check(c, { kind: 'definition_hd' }, '高清'), '复核 contentDetails.definition = hd');
        if (wants4k) add(c, { type: 'unsupported', reason: 'API 只能区分高清/标清，无法筛选 4K 及以上' });
        break;
      }
      case 'live': {
        const ev = p.eventType ?? 'live';
        common.eventType = ev;
        add(c, { type: 'api_param', param: 'eventType', value: ev });
        if (ev !== 'completed') {
          postFilters.push(check(c, { kind: 'live', eventType: ev }, c.label));
          add(c, { type: 'post_filter', detail: '复核直播状态' });
        }
        break;
      }
      case 'region': {
        common.regionCode = p.regionCode ?? '';
        add(c, { type: 'api_param', param: 'regionCode', value: p.regionCode ?? '', note: '限定为可在该地区观看的视频，不代表内容来自该地区' });
        break;
      }
      case 'sort': {
        const by = p.sortBy ?? 'relevance';
        if (by === 'recency') {
          rank.freshness = true;
          add(c, {
            type: 'rank_factor',
            detail: '新鲜度权重放大，越新越靠前',
            note: '没有用 order=date：官方文档提示非相关度排序配合时间过滤时结果可能不全',
          });
        } else if (by === 'popularity') {
          rank.popularity = true;
          add(c, { type: 'rank_factor', detail: '热度权重放大，播放量高的靠前' });
        } else if (by === 'rating') {
          rank.engagement = true;
          add(c, { type: 'rank_factor', detail: '口碑权重放大，点赞率高的靠前' });
        } else {
          add(c, { type: 'rank_factor', detail: '以检索相关度为主排序' });
        }
        break;
      }
      case 'count': {
        const n = p.count ?? ctx.defaultResults;
        resultCount = Math.min(n, ctx.expandedResults);
        add(c, { type: 'result_count', detail: `显示前 ${resultCount} 条` });
        if (n > ctx.expandedResults) add(c, { type: 'unsupported', reason: `一次最多显示 ${ctx.expandedResults} 条` });
        break;
      }
      case 'other': {
        const terms = p.terms ?? [];
        if (terms.length) {
          rank.referenceTerms.push(...terms);
          add(c, {
            type: 'reference_only',
            reason: `仅作参考：标题/简介含「${terms.slice(0, 4).join('、')}」的轻度加分，不保证满足`,
          });
        } else {
          add(c, { type: 'unsupported', reason: '无法把这项要求转成搜索参数或可校验的信号' });
        }
        break;
      }
    }
    // 防御：任何约束都必须至少有一条落实方式
    if (!dispositions[c.id]?.length) add(c, { type: 'unsupported', reason: '系统未能处理这项要求' });
  }

  // 检索词
  const baseQueries = intent.queries.length
    ? intent.queries
    : [{ q: uniqueStrings(rank.topicTerms).join(' ') || intent.topic || intent.utterance }];
  const languages = new Set(baseQueries.map((q) => q.language).filter(Boolean));
  if (!fixedLanguage && languages.size > 1) notes.push('未指定语言：中英文检索词各搜一次，结果合并排序');
  if (!ctx.profileSynced) notes.push('尚未同步订阅与喜欢的视频，"个人品味"因子暂不生效');
  if (ctx.regionCode && !common.regionCode) common.regionCode = ctx.regionCode;

  const suffix = [...queryAppend, ...uniqueStrings(exclusions).map((t) => `-${t}`)].join(' ');
  const maxCalls = Math.max(1, ctx.searchCallsPerQuery);
  const queries: PlannedQuery[] = baseQueries.slice(0, maxCalls).map((q) => {
    const params: Record<string, string> = { ...common, q: suffix ? `${q.q} ${suffix}` : q.q };
    const lang = fixedLanguage ?? q.language;
    if (lang) params.relevanceLanguage = toRelevanceLanguage(lang);
    if (withinHours !== undefined) params.publishedAfter = toRfc3339(ctx.now - withinHours * HOUR_MS);
    return { q: params.q!, params };
  });
  if (baseQueries.length > maxCalls) notes.push(`检索词超过单次上限，只用前 ${maxCalls} 条`);

  const coverage: Record<string, CoverageStatus> = {};
  for (const c of intent.constraints) coverage[c.id] = coverageStatus(dispositions[c.id] ?? []);

  // 成本：每条检索词 1 次 search；videos.list 与 channels.list 每 50 个 id 各 1 unit
  const searchCalls = queries.length;
  const generalUnits = queries.length * 2;
  const maxExtraPages = Math.max(0, Math.min(maxCalls - searchCalls, Math.floor((ctx.generalUnitsPerQuery - generalUnits) / 2)));

  const plan: SearchPlan = {
    queries,
    postFilters,
    softChecks,
    rank: {
      ...rank,
      formatTerms: uniqueStrings(rank.formatTerms),
      topicTerms: uniqueStrings(rank.topicTerms),
      referenceTerms: uniqueStrings(rank.referenceTerms),
    },
    resultCount,
    dispositions,
    coverage,
    estimatedCost: { searchCalls, generalUnits },
    maxExtraPages,
    notes,
  };
  if (withinHours !== undefined) plan.withinHours = withinHours;
  return plan;
}

/** 回显里展示的"本次预计成本"文字。 */
export function describeCost(plan: SearchPlan): string {
  const extra = plan.maxExtraPages ? `；过滤后不足时最多再翻 ${plan.maxExtraPages} 页` : '';
  return `search ×${plan.estimatedCost.searchCalls}、其他接口约 ${plan.estimatedCost.generalUnits} units${extra}`;
}
