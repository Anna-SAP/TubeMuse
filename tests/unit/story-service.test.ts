// 故事（DECISIONS §88）：联网调研的请求与解析（Anthropic、OpenAI）、两步调研的记账（token + 搜索费）、缓存、
// 整理失败时不再重复花搜索的钱、预算不够时一个请求都不发。全部用假的 fetch，不发真实网络请求。
import { beforeEach, describe, expect, it } from 'vitest';
import { ENDPOINTS } from '../../src/config/endpoints';
import { sanitizeStoryRead, type StoryPage } from '../../src/core/story';
import type { AppContext } from '../../src/services/context';
import { anthropicResearchRaw, anthropicWebSearchTool, openaiResearchRaw } from '../../src/services/llm';
import { mergeSettings, stores } from '../../src/services/repo';
import { memoryKV, memoryLocker } from '../../src/services/storage';
import { estimateStoryUsd, researchStory, resetStoryMemory } from '../../src/services/story-service';
import { taskMonthlyUsd } from '../../src/services/llm-factory';
import { AppError } from '../../src/services/errors';
import { fakeSecret } from './fake-secrets';
import { NOW } from './helpers';

const ANTHROPIC_KEY = fakeSecret('sk-ant-', 'test-key-for-story-tests');
const OPENAI_KEY = fakeSecret('sk-proj-', 'test-key-for-story-tests');

const RESEARCH_BLOCKS = [
  { type: 'text', text: '我先搜一下 Duffy 的回应。' },
  { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'Duffy Starlink FAA ground network' } },
  {
    type: 'web_search_tool_result',
    tool_use_id: 'srvtoolu_1',
    content: [
      { type: 'web_search_result', url: 'https://www.reuters.com/world/us/duffy-starlink', title: 'Duffy responds to Musk', encrypted_content: 'enc1', page_age: 'November 17, 2026' },
      { type: 'web_search_result', url: 'https://apnews.com/faa-modernization', title: 'FAA modernization plan', encrypted_content: 'enc2', page_age: null },
    ],
  },
  { type: 'server_tool_use', id: 'srvtoolu_2', name: 'web_search', input: { query: 'Musk free Starlink FAA offer' } },
  { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_2', content: { type: 'web_search_tool_result_error', error_code: 'too_many_requests' } },
  {
    type: 'text',
    text: 'Duffy 说 FAA 更想要地面网络。',
    citations: [{ type: 'web_search_result_location', url: 'https://www.reuters.com/world/us/duffy-starlink', title: 'Duffy responds to Musk', encrypted_index: 'ei', cited_text: 'We thought that the best method is to have a network based on the ground.' }],
  },
];

const BRIEF = {
  headline: 'Duffy 回应马斯克：FAA 要地面网络',
  summary: '马斯克说曾免费提供 Starlink 被拒，Duffy 回应称更倾向地面网络。',
  claims: [
    { text: 'Duffy 说最好的办法是地面网络', speaker: 'Sean Duffy', status: 'confirmed', note: '路透社报道了原话', sources: ['S1'] },
    { text: '马斯克提供过免费 Starlink', speaker: 'Elon Musk', status: 'confirmed', note: '', sources: ['P'] },
  ],
  timeline: [{ when: '2026-11-17', event: 'Duffy 回应', sources: ['S1'] }],
  perspectives: [],
  context: [],
  analysis: [],
  openQuestions: [],
  caveat: '',
};

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const anthropicMessage = (content: unknown[], usage: Record<string, unknown>, stop = 'end_turn') => json({ id: 'msg', type: 'message', role: 'assistant', model: 'm', content, stop_reason: stop, stop_sequence: null, container: null, usage });

interface Recorded {
  url: string;
  body: Record<string, unknown>;
  headers: Headers;
}

function makeCtx(opts: { provider?: 'anthropic' | 'openai'; research?: (call: number, body: Record<string, unknown>) => Response; brief?: (call: number) => Response; budget?: number; enabled?: boolean } = {}) {
  const research: Recorded[] = [];
  const brief: Recorded[] = [];
  const http = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const rec = { url, body, headers: new Headers(init?.headers) };
    const isResearch = Array.isArray(body.tools) && (body.tools as { type: string }[]).some((t) => t.type.startsWith('web_search'));
    if (isResearch) {
      research.push(rec);
      if (opts.research) return opts.research(research.length, body);
      return url.startsWith(ENDPOINTS.openai) ? json(openaiResearchResponse()) : anthropicMessage(RESEARCH_BLOCKS, { input_tokens: 20_000, output_tokens: 1_500, server_tool_use: { web_search_requests: 2 } });
    }
    brief.push(rec);
    if (opts.brief) return opts.brief(brief.length);
    return url.startsWith(ENDPOINTS.openai)
      ? json({ id: 'r', object: 'response', status: 'completed', model: 'm', output: [{ type: 'message', id: 'm', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(BRIEF), annotations: [] }] }], usage: { input_tokens: 3000, output_tokens: 1000 } })
      : anthropicMessage([{ type: 'text', text: JSON.stringify(BRIEF) }], { input_tokens: 3_000, output_tokens: 1_000 });
  }) as typeof fetch;
  const kv = memoryKV();
  const auth = { status: async () => 'connected' as const } as unknown as AppContext['auth'];
  const ctx: AppContext = { kv, locker: memoryLocker(), http, now: () => NOW, auth, endpoints: ENDPOINTS, timeZone: 'Asia/Shanghai' };
  const init = async () => {
    await stores.secrets.write(kv, { anthropicApiKey: ANTHROPIC_KEY, openaiApiKey: OPENAI_KEY });
    const s = mergeSettings(undefined);
    await stores.settings.write(kv, { ...s, llm: { ...s.llm, provider: opts.provider ?? 'anthropic', dailyBudgetUsd: opts.budget ?? s.llm.dailyBudgetUsd }, story: { ...s.story, enabled: opts.enabled ?? true } });
  };
  return { ctx, research, brief, init };
}

function openaiResearchResponse() {
  return {
    id: 'resp',
    object: 'response',
    status: 'completed',
    model: 'gpt-6-luna',
    output: [
      { type: 'reasoning', id: 'rs', summary: [] },
      { type: 'web_search_call', id: 'ws1', status: 'completed', action: { type: 'search', query: 'Duffy Starlink FAA', sources: [{ type: 'url', url: 'https://apnews.com/faa-modernization' }] } },
      { type: 'web_search_call', id: 'ws2', status: 'completed', action: { type: 'open_page', url: 'https://www.reuters.com/world/us/duffy-starlink' } },
      {
        type: 'message',
        id: 'm',
        status: 'completed',
        role: 'assistant',
        content: [
          {
            type: 'output_text',
            text: 'Duffy 说 FAA 更想要地面网络。马斯克说提供过。',
            annotations: [{ type: 'url_citation', start_index: 0, end_index: 20, url: 'https://www.reuters.com/world/us/duffy-starlink', title: 'Reuters' }],
          },
        ],
      },
    ],
    usage: { input_tokens: 5_000, output_tokens: 800, total_tokens: 5_800 },
  };
}

const PAGE: StoryPage = (() => {
  const r = sanitizeStoryRead(
    {
      kind: 'x',
      url: 'https://x.com/elonmusk/status/2122810772967575759',
      docTitle: 'X',
      statusId: '2122810772967575759',
      user: 'elonmusk',
      post: { name: 'Elon Musk', handle: '@elonmusk', text: '🤷‍♂️', media: [] },
      quoted: { name: 'Eric Daugherty', handle: '@EricLDaugh', text: 'JUST IN: Sec. Sean Duffy RESPONDS to Elon Musk', media: ['video'] },
    },
    NOW,
  );
  if (!r.ok) throw new Error('fixture');
  return r.page;
})();

beforeEach(() => resetStoryMemory());

describe('解析服务方的联网调研结果', () => {
  it('Anthropic：文字段落与引用、搜索结果、搜索词、搜索出错的错误码', () => {
    const raw = anthropicResearchRaw(RESEARCH_BLOCKS);
    expect(raw.queries).toEqual(['Duffy Starlink FAA ground network', 'Musk free Starlink FAA offer']);
    expect(raw.results.map((r) => r.url)).toEqual(['https://www.reuters.com/world/us/duffy-starlink', 'https://apnews.com/faa-modernization']);
    expect(raw.results[0]!.date).toBe('November 17, 2026');
    expect(raw.errors).toEqual(['too_many_requests']);
    expect(raw.segments[1]!.cites[0]).toMatchObject({ url: 'https://www.reuters.com/world/us/duffy-starlink', quote: expect.stringContaining('based on the ground') });
  });

  it('OpenAI：按引用的位置切开文字；只有 search 动作算一次搜索（打开网页不收费）', () => {
    const { raw, searches, refused } = openaiResearchRaw(openaiResearchResponse().output);
    expect(searches).toBe(1);
    expect(refused).toBe(false);
    expect(raw.queries).toEqual(['Duffy Starlink FAA']);
    expect(raw.results.map((r) => r.url)).toEqual(['https://apnews.com/faa-modernization', 'https://www.reuters.com/world/us/duffy-starlink']);
    expect(raw.segments).toEqual([
      { text: 'Duffy 说 FAA 更想要地面网络。', cites: [{ url: 'https://www.reuters.com/world/us/duffy-starlink', title: 'Reuters' }] },
      { text: '马斯克说提供过。', cites: [] },
    ]);
  });

  it('Anthropic 的搜索工具：Claude 4.6 及以后用带筛选的新版，更早的模型用基础版', () => {
    expect(anthropicWebSearchTool('claude-haiku-5-5', 5)).toEqual({ type: 'web_search_20260209', name: 'web_search', max_uses: 5 });
    expect(anthropicWebSearchTool('claude-opus-4-6', 3).type).toBe('web_search_20260209');
    for (const m of ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-5-20250929', 'claude-opus-4-1', 'claude-sonnet-4-20250514', 'claude-3-7-sonnet-latest']) {
      expect(anthropicWebSearchTool(m, 3).type, m).toBe('web_search_20250305');
    }
  });
});

describe('调研一个故事（Anthropic）', () => {
  it('两步：联网调研（带搜索工具和次数上限）→ 整理（结构化输出、不联网）；来源编号、降级、花费都对', async () => {
    const t = makeCtx();
    await t.init();
    const stages: string[] = [];
    const r = await researchStory(t.ctx, PAGE, { onStage: (s) => stages.push(s) });
    expect(stages).toEqual(['search', 'brief']);
    expect(t.research).toHaveLength(1);
    expect(t.brief).toHaveLength(1);
    const rb = t.research[0]!.body;
    expect(rb.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }]);
    expect(rb.model).toBe('claude-haiku-5-5');
    expect(String(rb.system)).toContain('不可信的数据');
    expect(JSON.stringify(rb)).not.toContain(ANTHROPIC_KEY);
    // SDK 1.x 以 Authorization: Bearer 发送 Key（旧版为 x-api-key），只在请求头里
    expect([t.research[0]!.headers.get('x-api-key'), t.research[0]!.headers.get('authorization')]).toContain(t.research[0]!.headers.get('x-api-key') ? ANTHROPIC_KEY : `Bearer ${ANTHROPIC_KEY}`);
    const bb = t.brief[0]!.body;
    expect(bb.tools).toBe(undefined);
    expect((bb.output_config as { format?: { type?: string } }).format?.type).toBe('json_schema');
    expect(JSON.stringify(bb)).toContain('[S1]');

    const rec = r.record;
    expect(r.cached).toBe(false);
    expect(rec.sources.map((s) => `${s.id} ${s.site}`)).toEqual(['S1 reuters.com', 'S2 apnews.com']);
    expect(rec.queries).toHaveLength(2);
    expect(rec.searchErrors).toEqual(['too_many_requests']);
    expect(rec.searches).toBe(2);
    expect(rec.brief.claims[0]).toMatchObject({ status: 'confirmed', sources: ['S1'] });
    // 只有页面本身（P）的"已证实"降为"只是说法"
    expect(rec.brief.claims[1]).toMatchObject({ status: 'claimed', downgraded: true });
    // 花费：调研（Haiku 5.5：20,000 输入 × $0.1/M + 1,500 输出 × $0.5/M）+ 2 次搜索 × $0.01 + 整理（3,000 × 0.1 + 1,000 × 0.5）
    const expected = (20_000 * 0.1 + 1_500 * 0.5) / 1e6 + 0.02 + (3_000 * 0.1 + 1_000 * 0.5) / 1e6;
    expect(rec.usd).toBeCloseTo(expected, 6);
    const ledger = await stores.llmLedger.read(t.ctx.kv);
    const day = Object.values(ledger.days)[0]!;
    expect(day.byTask.storyResearch?.usd).toBeCloseTo((20_000 * 0.1 + 1_500 * 0.5) / 1e6 + 0.02, 6);
    expect(day.byTask.storyBrief?.calls).toBe(1);
    expect(day.holds ?? []).toEqual([]);
    expect((await stores.stories.read(t.ctx.kv)).items).toHaveLength(1);
  });

  it('同一个页面缓存时间内再调研：直接给上次的结果，一个请求都不发；"重新调研"才重发', async () => {
    const t = makeCtx();
    await t.init();
    await researchStory(t.ctx, PAGE);
    const again = await researchStory(t.ctx, PAGE);
    expect(again.cached).toBe(true);
    expect(t.research).toHaveLength(1);
    const forced = await researchStory(t.ctx, PAGE, { force: true });
    expect(forced.cached).toBe(false);
    expect(t.research).toHaveLength(2);
    expect((await stores.stories.read(t.ctx.kv)).items).toHaveLength(1);
  });

  it('服务方说这一轮没做完（pause_turn）：把这一段原样交回去接着做，用量和搜索次数累加', async () => {
    const t = makeCtx({
      research: (call) =>
        call === 1
          ? anthropicMessage(RESEARCH_BLOCKS.slice(0, 3), { input_tokens: 8_000, output_tokens: 300, server_tool_use: { web_search_requests: 1 } }, 'pause_turn')
          : anthropicMessage(RESEARCH_BLOCKS.slice(3), { input_tokens: 12_000, output_tokens: 1_200, server_tool_use: { web_search_requests: 1 } }),
    });
    await t.init();
    const r = await researchStory(t.ctx, PAGE);
    expect(t.research).toHaveLength(2);
    const second = t.research[1]!.body.messages as { role: string; content: unknown }[];
    expect(second.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(second[1]!.content)).toContain('srvtoolu_1');
    expect(r.record.searches).toBe(2);
    expect(r.record.sources[0]!.id).toBe('S1');
    expect(r.record.searchErrors).toEqual(['too_many_requests']);
  });

  it('接着做了几次还没做完：用做到一半的结果，并标出来', async () => {
    const t = makeCtx({ research: () => anthropicMessage(RESEARCH_BLOCKS, { input_tokens: 100, output_tokens: 10, server_tool_use: { web_search_requests: 1 } }, 'pause_turn') });
    await t.init();
    const r = await researchStory(t.ctx, PAGE);
    expect(t.research).toHaveLength(3);
    expect(r.record.searchErrors).toContain('paused');
  });

  it('整理这一步没成：报错；再点一次只重做整理，不再搜索（不再花搜索的钱）', async () => {
    const t = makeCtx({ brief: (call) => (call === 1 ? anthropicMessage([{ type: 'text', text: '{"headline":"","summary":""}' }], { input_tokens: 10, output_tokens: 10 }) : anthropicMessage([{ type: 'text', text: JSON.stringify(BRIEF) }], { input_tokens: 10, output_tokens: 10 })) });
    await t.init();
    await expect(researchStory(t.ctx, PAGE)).rejects.toThrow('整理出的结果不可用');
    const r = await researchStory(t.ctx, PAGE);
    expect(t.research).toHaveLength(1);
    expect(t.brief).toHaveLength(2);
    expect(r.reusedNotes).toBe(true);
    // 两次整理的钱都算在这一条上
    expect(r.record.usd).toBeCloseTo((20_000 * 0.1 + 1_500 * 0.5) / 1e6 + 0.02 + (2 * (10 * 0.1 + 10 * 0.5)) / 1e6, 6);
  });

  it('模型拒绝调研：说清楚，按已经计费的用量记账', async () => {
    const t = makeCtx({ research: () => anthropicMessage([], { input_tokens: 500, output_tokens: 5, server_tool_use: { web_search_requests: 0 } }, 'refusal') });
    await t.init();
    await expect(researchStory(t.ctx, PAGE)).rejects.toThrow('模型拒绝调研这个页面');
    const day = Object.values((await stores.llmLedger.read(t.ctx.kv)).days)[0]!;
    expect(day.byTask.storyResearch?.calls).toBe(1);
    expect(day.holds ?? []).toEqual([]);
  });

  it('预算不够：一个请求都不发，说明还剩多少', async () => {
    const t = makeCtx({ budget: 0.001 });
    await t.init();
    const err = await researchStory(t.ctx, PAGE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).kind).toBe('llm_budget');
    expect(t.research).toHaveLength(0);
    expect(t.brief).toHaveLength(0);
  });

  it('预扣按最坏情况算上搜索费：预算够整理、不够搜满次数时，调研这一步就停下', async () => {
    // 整理最坏约 $0.005；调研最坏 = 5 次 × $0.01 + 网页内容和输出的 token ≈ $0.06
    const t = makeCtx({ budget: 0.03 });
    await t.init();
    await expect(researchStory(t.ctx, PAGE)).rejects.toMatchObject({ kind: 'llm_budget' });
    expect(t.research).toHaveLength(0);
  });

  it('在设置里关掉了：不调研', async () => {
    const t = makeCtx({ enabled: false });
    await t.init();
    await expect(researchStory(t.ctx, PAGE)).rejects.toThrow('故事已在设置中关闭');
  });
});

describe('调研一个故事（OpenAI）', () => {
  it('Responses 接口带 web_search 工具、要来源清单；按 search 动作的次数收搜索费', async () => {
    const t = makeCtx({ provider: 'openai' });
    await t.init();
    const r = await researchStory(t.ctx, PAGE);
    const rb = t.research[0]!.body;
    expect(t.research[0]!.url).toBe(`${ENDPOINTS.openai}/responses`);
    expect(rb.tools).toEqual([{ type: 'web_search' }]);
    expect(rb.include).toEqual(['web_search_call.action.sources']);
    expect(rb.store).toBe(false);
    expect(r.record.searches).toBe(1);
    expect(r.record.provider).toBe('openai');
    expect(r.record.sources.map((s) => s.site)).toEqual(['reuters.com', 'apnews.com']);
    expect(t.research[0]!.headers.get('authorization')).toBe(`Bearer ${OPENAI_KEY}`);
  });
});

describe('花费估算', () => {
  it('调研一次的估算按典型的搜索次数算，设置里的上限更小时按上限；设置页的每月估算带上搜索费', () => {
    const s = mergeSettings(undefined);
    const typical = estimateStoryUsd(s);
    expect(typical.searches).toBe(4);
    expect(typical.model).toBe('claude-haiku-5-5');
    // 调研：30,000 × $0.1/M + 2,500 × $0.5/M + 4 × $0.01；整理：6,000 × 0.1 + 2,000 × 0.5
    expect(typical.usd).toBeCloseTo((30_000 * 0.1 + 2_500 * 0.5) / 1e6 + 0.04 + (6_000 * 0.1 + 2_000 * 0.5) / 1e6, 6);
    const capped = estimateStoryUsd({ ...s, story: { ...s.story, maxSearches: 2 } });
    expect(capped.searches).toBe(2);
    expect(typical.usd - capped.usd).toBeCloseTo(0.02, 6);
    expect(taskMonthlyUsd(s, 'storyResearch')).toBeCloseTo(((30_000 * 0.1 + 2_500 * 0.5) / 1e6 + 0.04) * 30, 6);
  });
});
