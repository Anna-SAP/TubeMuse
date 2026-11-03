// 多语字幕：json3 解析、按播放进度在每种语言自己的时间轴上找句子、按偏好选轨（原生 / 自动生成 / YouTube 机翻）、
// 复用播放器字幕请求的地址、页面内助手消息校验、设置合并、烧录颜色，以及后台查原声语言（mock YouTube API）。

import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, MULTI_CC } from '../../src/config/defaults';
import { ENDPOINTS } from '../../src/config/endpoints';
import { layoutBurnIn } from '../../src/core/clips';
import {
  AutoCaptionWindow,
  ORIGINAL,
  bestTrack,
  ccFetchRetry,
  ccOptions,
  ccWaitStatus,
  cleanCueText,
  fitLine,
  joinCueLines,
  langMatchKey,
  parseJson3,
  primeTrack,
  resolveSources,
  sanitizeCcLangs,
  sanitizeTrackList,
  textAt,
  timedtextVideoId,
  trackKey,
  trackUrl,
  type CcCue,
  type CcLoad,
  type CcTrack,
  type CcTrackList,
} from '../../src/core/multi-captions';
import type { AuthProvider } from '../../src/services/auth';
import type { AppContext } from '../../src/services/context';
import { multiCcVideoLanguage } from '../../src/services/multi-captions-service';
import { mergeSettings, stores } from '../../src/services/repo';
import { memoryKV, memoryLocker } from '../../src/services/storage';

const ORIGIN = 'https://www.youtube.com';
const VID = 'arj7oStGLkU';

/** 2026-11-02 实测：播放器自己发出的字幕请求（签名、令牌换成假的；参数名与顺序照真实请求） */
const PLAYER_URL =
  `${ORIGIN}/api/timedtext?v=${VID}&ei=C5Toapi5NbuPssUP&caps=asr&opi=112496729&exp=xpe&xoaf=5&xowf=1&hl=en&ip=0.0.0.0&ipbits=0&expire=1793652347` +
  `&sparams=ip,ipbits,expire,v,ei,caps,opi,exp,xoaf&signature=FAKE.SIG&key=yt8&lang=en&potc=1&pot=FAKE-POT-TOKEN&fmt=json3&xorb=2&xobt=3&xovt=3` +
  `&cbr=Chrome&cbrver=156.0&c=WEB&cver=2.20261030&cplayer=UNIPLAYER&cos=Windows&cosver=10.0&cplatform=DESKTOP`;

const track = (lang: string, over: Partial<CcTrack> = {}): CcTrack => ({ lang, kind: '', name: '', label: lang, vssId: `.${lang}`, translatable: true, ...over });

/** 用户截图里那支 MV 的字幕菜单：中文（简体）、English、印尼语、日语、韩语、西班牙语；没有自动生成的字幕 */
const MV: CcTrackList = {
  videoId: VID,
  tracks: [
    track('zh-Hans', { label: 'Chinese (Simplified)' }),
    track('en', { label: 'English' }),
    track('id', { label: 'Indonesian' }),
    track('ja', { label: 'Japanese' }),
    track('ko', { label: 'Korean' }),
    track('es', { label: 'Spanish' }),
  ],
  translationLangs: [
    { code: 'zh-Hans', label: 'Chinese (Simplified)' },
    { code: 'zh-Hant', label: 'Chinese (Traditional)' },
    { code: 'fr', label: 'French' },
    { code: 'de', label: 'German' },
  ],
  native: null,
};

/** 一场英文演讲：人工英文、自动生成英文、人工韩文、人工繁中 */
const TALK: CcTrackList = {
  videoId: VID,
  tracks: [track('en', { label: 'English' }), track('en', { kind: 'asr', label: 'English (auto-generated)', vssId: 'a.en' }), track('ko', { label: 'Korean' }), track('zh-TW', { label: 'Chinese (Taiwan)' })],
  translationLangs: [
    { code: 'zh-Hans', label: 'Chinese (Simplified)' },
    { code: 'ja', label: 'Japanese' },
  ],
  native: null,
};

describe('json3 解析', () => {
  it('人工字幕：多行句子保留换行，跳过只定义窗口的事件，按开始时间排序', () => {
    const cues = parseJson3(
      {
        wireMagic: 'pb3',
        events: [
          { tStartMs: 0, dDurationMs: 176160, id: 1, wpWinPosId: 1, wsWinStyleId: 1 },
          { tStartMs: 12645, dDurationMs: 1370, segs: [{ utf8: '대학에 다닐 때' }] },
          { tStartMs: 0, dDurationMs: 7000, segs: [{ utf8: '번역: Jihyeon J. Kim\n검토: Ju Hye Lim' }] },
          { tStartMs: 14100, dDurationMs: 2000, segs: [{ utf8: '  정치학을  ' }, { utf8: '전공했어요\r\n' }] },
        ],
      },
      { asr: false },
    );
    expect(cues).toEqual([
      { start: 0, end: 7, text: '번역: Jihyeon J. Kim\n검토: Ju Hye Lim' },
      { start: 12.645, end: 14.015, text: '대학에 다닐 때' },
      { start: 14.1, end: 16.1, text: '정치학을 전공했어요' },
    ]);
  });

  it('自动生成的字幕：去掉换行事件（aAppend），保留逐词时间，相邻句截到下一句开始（一种语言一次只占一行）', () => {
    const cues = parseJson3(
      {
        events: [
          { tStartMs: 0, dDurationMs: 176160, id: 1, wpWinPosId: 1, wsWinStyleId: 1 },
          { tStartMs: 160, dDurationMs: 4319, wWinId: 1, segs: [{ utf8: 'hey', acAsrConf: 0 }, { utf8: ' guys', tOffsetMs: 240 }, { utf8: ' welcome', tOffsetMs: 800 }] },
          { tStartMs: 2149, dDurationMs: 2330, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] },
          { tStartMs: 2159, dDurationMs: 4560, wWinId: 1, segs: [{ utf8: 'to' }, { utf8: ' the', tOffsetMs: 300 }, { utf8: ' show', tOffsetMs: 600 }] },
        ],
      },
      { asr: true },
    );
    expect(cues.map((c) => [c.start, c.end, c.text])).toEqual([
      [0.16, 2.159, 'hey guys welcome'],
      [2.159, 6.719, 'to the show'],
    ]);
    expect(cues[0]!.words?.map((w) => w.at)).toEqual([0, 0.24, 0.8]);
  });

  it('格式不对、时长为 0、文字为空或只有控制字符：跳过；不是对象时返回空', () => {
    expect(parseJson3(null, { asr: false })).toEqual([]);
    expect(parseJson3({ events: 'x' }, { asr: false })).toEqual([]);
    const zw = String.fromCharCode(0x200b);
    const cues = parseJson3(
      {
        events: [
          { tStartMs: 1000, dDurationMs: 0, segs: [{ utf8: '零时长' }] },
          { tStartMs: -5, dDurationMs: 100, segs: [{ utf8: '负数' }] },
          { tStartMs: 2000, dDurationMs: 500, segs: [{ utf8: `${zw}\u0007 ` }] },
          { tStartMs: 3000, dDurationMs: 500, segs: [{ utf8: 5 }, { utf8: `你${zw}好` }] },
          'junk',
        ],
      },
      { asr: false },
    );
    expect(cues).toEqual([{ start: 3, end: 3.5, text: '你好' }]);
  });

  it('句数与每句长度有上限', () => {
    const events = Array.from({ length: 50 }, (_, i) => ({ tStartMs: i * 1000, dDurationMs: 900, segs: [{ utf8: 'x'.repeat(800) }] }));
    const cues = parseJson3({ events }, { asr: false, maxCues: 10, maxChars: 100 });
    expect(cues).toHaveLength(10);
    expect(cues.every((c) => c.text.length === 100)).toBe(true);
    expect(MULTI_CC.cueMaxChars).toBeGreaterThan(100);
  });

  it('清理文字：统一换行、压缩空白、去掉空行', () => {
    expect(cleanCueText(' a \t b \r\n\r\n  c  ')).toBe('a b\nc');
  });
});

describe('按播放进度找这一句（各语言各自的时间轴）', () => {
  const cues: CcCue[] = [
    { start: 1, end: 3, text: 'one' },
    { start: 3.1, end: 5, text: 'two' },
    { start: 6, end: 8, text: 'three' },
  ];

  it('开始时刻包含、结束时刻不含；第一句之前、最后一句之后为空', () => {
    expect(textAt(cues, 0.99)).toBe('');
    expect(textAt(cues, 1)).toBe('one');
    expect(textAt(cues, 2.999)).toBe('one');
    expect(textAt(cues, 3.1)).toBe('two');
    expect(textAt(cues, 8)).toBe('');
    expect(textAt(cues, 100)).toBe('');
    expect(textAt([], 1)).toBe('');
  });

  it('两句之间的空档短于 0.3 秒时留着上一句（不闪）；空档长时照实消失', () => {
    expect(MULTI_CC.gapBridgeSec).toBe(0.3);
    expect(textAt(cues, 3.05)).toBe('one'); // 3.0–3.1 的 0.1 秒空档
    expect(textAt(cues, 5.5)).toBe(''); // 5–6 的 1 秒空档
  });

  it('同一种语言有句子重叠（对白、标牌）：最多显示两句，先开始的在上', () => {
    const overlap: CcCue[] = [
      { start: 0, end: 10, text: '[标牌] 出口' },
      { start: 2, end: 4, text: 'A：快走' },
      { start: 3, end: 5, text: 'B：等等' },
    ];
    expect(textAt(overlap, 1)).toBe('[标牌] 出口');
    expect(textAt(overlap, 2.5)).toBe('[标牌] 出口\nA：快走');
    expect(textAt(overlap, 3.5)).toBe('A：快走\nB：等等');
  });

  it('持续很久的长句在往前看的范围内仍能找到', () => {
    const long: CcCue[] = [{ start: 0, end: 30, text: 'title' }, ...Array.from({ length: 5 }, (_, i) => ({ start: 10 + i, end: 10.5 + i, text: `l${i}` }))];
    expect(textAt(long, 14.7)).toBe('title');
    expect(textAt(long, 12.2)).toBe('title\nl2');
  });

  it('自动生成的字幕逐词出现：只显示已经说到的词', () => {
    const [cue] = parseJson3({ events: [{ tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: 'hey' }, { utf8: ' guys', tOffsetMs: 500 }, { utf8: ' welcome', tOffsetMs: 1500 }] }] }, { asr: true });
    expect(textAt([cue!], 1.2)).toBe('hey');
    expect(textAt([cue!], 1.6)).toBe('hey guys');
    expect(textAt([cue!], 3)).toBe('hey guys welcome');
  });

  it('不同语言的断句、时间戳不同：同一时刻各自显示自己的那一句', () => {
    // 英文按短句切、中文按长句切，起止时间都不一样
    const en: CcCue[] = [
      { start: 12.6, end: 14.0, text: 'So in college,' },
      { start: 14.0, end: 15.5, text: 'I was a government major,' },
    ];
    const zh: CcCue[] = [{ start: 12.9, end: 15.8, text: '上大学那会儿，我主修政治学，' }];
    expect([textAt(en, 12.7), textAt(zh, 12.7)]).toEqual(['So in college,', '']);
    expect([textAt(en, 14.2), textAt(zh, 14.2)]).toEqual(['I was a government major,', '上大学那会儿，我主修政治学，']);
    expect([textAt(en, 15.6), textAt(zh, 15.6)]).toEqual(['', '上大学那会儿，我主修政治学，']);
  });

  it('二分查找与逐句扫描结果一致（1 万句）', () => {
    const many: CcCue[] = [];
    let t = 0;
    for (let i = 0; i < 10_000; i++) {
      const gap = (i * 7919) % 5 === 0 ? 0.5 : 0.05;
      const dur = 0.5 + ((i * 104729) % 30) / 10;
      many.push({ start: t, end: t + dur, text: `c${i}` });
      t += dur + gap;
    }
    const linear = (x: number) => {
      const act = many.filter((c) => c.start <= x && c.end > x);
      if (act.length) return act.slice(-2).map((c) => c.text).join('\n');
      const prevIdx = many.findLastIndex((c) => c.start <= x);
      const prev = many[prevIdx];
      const next = many[prevIdx + 1];
      return prev && next && next.start - prev.end < MULTI_CC.gapBridgeSec ? prev.text : '';
    };
    for (let i = 0; i < 2_000; i++) {
      const x = (i * 9.731) % t;
      expect(textAt(many, x)).toBe(linear(x));
    }
  });
});

describe('一种语言尽量只占一行（2026-11-03 用户要求）', () => {
  it('作者在一句里手动断的行接成一行：英文、韩文用空格；中文在全角标点后直接接', () => {
    expect(joinCueLines("We YG지, Yeah we be trimmin' trimmin'\nWe gon' shock yuh")).toBe("We YG지, Yeah we be trimmin' trimmin' We gon' shock yuh");
    expect(joinCueLines('我们是YG，没错，我们一直在修剪修剪\n我们会让你大吃一惊')).toBe('我们是YG，没错，我们一直在修剪修剪 我们会让你大吃一惊');
    expect(joinCueLines('上大学那会儿，\n我主修政治学。')).toBe('上大学那会儿，我主修政治学。');
    expect(joinCueLines('So in college,\nI was a government major,')).toBe('So in college, I was a government major,');
  });

  it('同时显示的几句（textAt 用换行隔开）也接成一行；空行、首尾空白去掉；没有换行时原样', () => {
    const overlap: CcCue[] = [
      { start: 0, end: 10, text: '[标牌] 出口' },
      { start: 2, end: 4, text: 'A：快走' },
    ];
    expect(joinCueLines(textAt(overlap, 3))).toBe('[标牌] 出口 A：快走');
    expect(joinCueLines('\n  a  \n\n b ')).toBe('a b');
    expect(joinCueLines('내 이름을 불러줘')).toBe('내 이름을 불러줘');
    expect(joinCueLines('')).toBe('');
  });

  it('放得下：原字号；放不下：等比缩小到正好放下；缩到 75% 还放不下：用 75% 并允许折行', () => {
    expect(fitLine(500, 600)).toEqual({ scale: 1, wrap: false });
    expect(fitLine(600, 600)).toEqual({ scale: 1, wrap: false });
    expect(fitLine(750, 600)).toEqual({ scale: 0.8, wrap: false });
    const tight = fitLine(799, 600);
    expect(tight.wrap).toBe(false);
    expect(799 * tight.scale).toBeLessThanOrEqual(600);
    expect(fitLine(900, 600)).toEqual({ scale: 0.75, wrap: true });
    expect(MULTI_CC.fitMinScale).toBe(0.75);
  });

  it('还没排版（宽度为 0）或不可见：不缩放', () => {
    expect(fitLine(0, 600)).toEqual({ scale: 1, wrap: false });
    expect(fitLine(500, 0)).toEqual({ scale: 1, wrap: false });
    expect(fitLine(Number.NaN, 600)).toEqual({ scale: 1, wrap: false });
  });
});

describe('选轨', () => {
  it('语言归并：中文按简 / 繁分，其他语言只看主语言；旧代码 iw / in 归到 he / id', () => {
    expect(['zh', 'zh-CN', 'zh-Hans', 'zh-SG', 'zh-Hans-CN'].map(langMatchKey)).toEqual(Array(5).fill('zh-hans'));
    expect(['zh-TW', 'zh-HK', 'zh-Hant', 'zh-Hant-TW', 'zh-MO'].map(langMatchKey)).toEqual(Array(5).fill('zh-hant'));
    expect(['en', 'en-GB', 'en-US'].map(langMatchKey)).toEqual(['en', 'en', 'en']);
    expect([langMatchKey('iw'), langMatchKey('in'), langMatchKey('pt-BR')]).toEqual(['he', 'id', 'pt']);
  });

  it('同一种语言：人工字幕优先于自动生成；同等时代码完全一致的优先', () => {
    expect(bestTrack(TALK.tracks, 'en')?.kind).toBe('');
    expect(bestTrack([track('en', { kind: 'asr' }), track('en-GB')], 'en')?.lang).toBe('en-GB');
    expect(bestTrack([track('pt-PT'), track('pt-BR')], 'pt-BR')?.lang).toBe('pt-BR');
    expect(bestTrack(TALK.tracks, 'zh-Hant')?.lang).toBe('zh-TW');
    expect(bestTrack(TALK.tracks, 'zh-Hans')).toBeUndefined();
  });

  it('用户截图的 MV：原声语言（YouTube 数据里写的韩语）、英文、简体中文——三行都是原生字幕', () => {
    const r = resolveSources(MV, ['original', 'en', 'zh-Hans'], { autoTranslate: true, videoLang: 'ko' });
    expect(r.sources.map((s) => [s.want, s.track.lang, s.autoTranslated])).toEqual([
      ['ko', 'ko', false],
      ['en', 'en', false],
      ['zh-Hans', 'zh-Hans', false],
    ]);
    expect(r.originalLang).toBe('ko');
    expect(r.missing).toEqual([]);
  });

  it('看不出原声语言（没有自动生成的字幕、也没查到）：这一项说明原因，其余照常', () => {
    const r = resolveSources(MV, ['original', 'en'], { autoTranslate: true });
    expect(r.sources.map((s) => s.want)).toEqual(['en']);
    expect(r.missing).toEqual([{ pref: 'original', reason: expect.stringContaining('看不出视频原声') }]);
  });

  it('原声语言按自动生成字幕的语言判断；与后面选的语言相同时只显示一次', () => {
    const r = resolveSources(TALK, ['original', 'en', 'ko'], { autoTranslate: true, videoLang: 'fr' });
    expect(r.originalLang).toBe('en');
    expect(r.sources.map((s) => [s.pref, s.want, s.track.kind])).toEqual([
      ['original', 'en', ''],
      ['ko', 'ko', ''],
    ]);
  });

  it('没有原生轨：用 YouTube 自动翻译补上（标注机翻），源轨优先原声语言的人工字幕', () => {
    const r = resolveSources(TALK, ['en', 'zh-Hans', 'ja'], { autoTranslate: true });
    const zh = r.sources[1]!;
    expect([zh.want, zh.tlang, zh.autoTranslated, zh.track.lang, zh.track.kind, zh.label]).toEqual(['zh-Hans', 'zh-Hans', true, 'en', '', 'Chinese (Simplified)']);
    expect(zh.key).toBe(`${trackKey(zh.track)}>zh-Hans`);
    expect(r.sources[2]).toMatchObject({ want: 'ja', tlang: 'ja', autoTranslated: true });
  });

  it('关掉自动翻译：没有原生轨的语言说明"没有"；原声语言从不用翻译补', () => {
    const off = resolveSources(TALK, ['zh-Hans'], { autoTranslate: false });
    expect(off.sources).toEqual([]);
    expect(off.missing[0]?.reason).toContain('没有这种语言');
    const noOriginal = resolveSources({ ...MV, tracks: MV.tracks.filter((t) => t.lang !== 'ko') }, ['original'], { autoTranslate: true, videoLang: 'ko' });
    expect(noOriginal.sources).toEqual([]);
    expect(noOriginal.missing[0]?.reason).toContain('原声语言');
  });

  it('YouTube 译不成这种语言、或字幕不许自动翻译：说明原因', () => {
    expect(resolveSources(TALK, ['ar'], { autoTranslate: true }).missing[0]?.reason).toContain('不能自动翻译成这种语言');
    const locked = { ...TALK, tracks: TALK.tracks.map((t) => ({ ...t, translatable: false })) };
    expect(resolveSources(locked, ['ja'], { autoTranslate: true }).missing[0]?.reason).toContain('不支持 YouTube 自动翻译');
  });

  it('最多 4 行', () => {
    const r = resolveSources(MV, ['zh-Hans', 'en', 'id', 'ja', 'ko', 'es'], { autoTranslate: true });
    expect(r.sources.map((s) => s.want)).toEqual(['zh-Hans', 'en', 'id', 'ja']);
    expect(MULTI_CC.maxLines).toBe(4);
  });

  it('侧边栏勾选项：先是选中的（按显示顺序，含"没有"的），再是这个视频其他的字幕（同一语言只列一次）', () => {
    const langs = ['original', 'zh-Hans', 'ar'];
    const r = resolveSources(TALK, langs, { autoTranslate: true });
    const opts = ccOptions(TALK, r, langs);
    expect(opts.map((o) => [o.code, o.kind, o.checked])).toEqual([
      ['original', 'native', true],
      ['zh-Hans', 'auto', true],
      ['ar', 'missing', true],
      ['ko', 'native', false],
      ['zh-TW', 'native', false],
    ]);
    expect(opts[0]).toMatchObject({ original: true, label: 'English' });
    expect(opts[2]!.note).toContain('不能自动翻译');
  });

  it('让播放器取一次字幕用哪条轨：第一行用到的轨；取过的、带名字的跳过', () => {
    const r = resolveSources(TALK, ['ko', 'en'], { autoTranslate: true });
    expect(primeTrack(TALK, r.sources, new Set())?.lang).toBe('ko');
    expect(primeTrack(TALK, r.sources, new Set([trackKey(TALK.tracks[2]!)]))?.lang).toBe('en');
    const all = new Set(TALK.tracks.map(trackKey));
    expect(primeTrack(TALK, r.sources, all)).toBeUndefined();
    expect(primeTrack({ ...TALK, tracks: [track('en', { name: 'CC1' })] }, [], new Set())).toBeUndefined();
  });
});

describe('原生字幕是谁打开的（2026-11-02 bug：播放器按你保存的偏好自动打开，被当成你按了 C）', () => {
  const O = { autoCaptionGracePlaySec: 1.5, autoCaptionGraceMaxMs: 8_000, autoCaptionMaxAbsorb: 2 };
  /** 每 250 毫秒喂一次，共 ms 毫秒 */
  const run = (w: AutoCaptionWindow, from: number, ms: number, s: { ad: boolean; playing: boolean }) => {
    for (let t = from + 250; t <= from + ms; t += 250) w.sample({ now: t, ...s });
    return from + ms;
  };

  it('正片刚开始（还没播放）：原生字幕被打开算播放器自动打开的，最多吸收 2 次，第 3 次算你按的', () => {
    const w = new AutoCaptionWindow(0, O);
    const t = run(w, 0, 800, { ad: false, playing: false }); // 实测：重新加载 0.8 秒后、还没开始播放就自动打开
    expect(w.isOpen(t)).toBe(true);
    expect([w.absorb(t), w.absorb(t), w.absorb(t)]).toEqual([true, true, false]);
  });

  it('正片播放满 1.5 秒后：再打开原生字幕就是你按的 C', () => {
    const w = new AutoCaptionWindow(0, O);
    const t = run(w, 0, 1_750, { ad: false, playing: true });
    expect(w.isOpen(t)).toBe(false);
    expect(w.absorb(t)).toBe(false);
  });

  it('一直停在开头没播：最多等 8 秒', () => {
    const w = new AutoCaptionWindow(0, O);
    expect(w.isOpen(run(w, 0, 7_750, { ad: false, playing: false }))).toBe(true);
    expect(w.isOpen(run(w, 7_750, 500, { ad: false, playing: false }))).toBe(false);
  });

  it('广告期间不计时；广告结束 = 正片重新开始，播放器会再按你的偏好打开一次', () => {
    const w = new AutoCaptionWindow(0, O);
    let t = run(w, 0, 3_000, { ad: false, playing: true });
    expect(w.isOpen(t)).toBe(false);
    t = run(w, t, 20_000, { ad: true, playing: true }); // 中插广告
    t = run(w, t, 500, { ad: false, playing: false });
    expect(w.isOpen(t)).toBe(true);
    expect(w.absorb(t)).toBe(true);
  });

  it('换视频重新计时；标签页在后台被节流时一轮最多按 1 秒算', () => {
    const w = new AutoCaptionWindow(0, O);
    w.sample({ now: 60_000, ad: false, playing: true }); // 一下子过了 60 秒：只算 1 秒
    expect(w.isOpen(60_000)).toBe(false); // 但墙钟已超过 8 秒
    w.restart(100_000);
    w.sample({ now: 100_250, ad: false, playing: true });
    expect(w.isOpen(100_250)).toBe(true);
    expect([MULTI_CC.autoCaptionGracePlaySec, MULTI_CC.autoCaptionGraceMaxMs, MULTI_CC.autoCaptionMaxAbsorb]).toEqual([2, 8_000, 2]);
  });
});

describe('复用播放器的字幕请求', () => {
  it('认得播放器自己发出的请求：同源、/api/timedtext、带 pot 令牌', () => {
    expect(timedtextVideoId(PLAYER_URL, ORIGIN)).toBe(VID);
    expect(timedtextVideoId(PLAYER_URL.replace('&pot=FAKE-POT-TOKEN', ''), ORIGIN)).toBeUndefined();
    expect(timedtextVideoId(PLAYER_URL, 'https://m.youtube.com')).toBeUndefined();
    expect(timedtextVideoId(PLAYER_URL.replace('/api/timedtext', '/api/stats'), ORIGIN)).toBeUndefined();
    expect(timedtextVideoId(PLAYER_URL.replace(`v=${VID}`, 'v=bad id'), ORIGIN)).toBeUndefined();
    expect(timedtextVideoId('not a url', ORIGIN)).toBeUndefined();
  });

  it('只换语言参数：令牌、签名等其余参数原样保留，格式固定 json3', () => {
    const u = new URL(trackUrl(PLAYER_URL, ORIGIN, VID, { track: track('ko') })!);
    const orig = new URL(PLAYER_URL);
    expect(u.origin + u.pathname).toBe(`${ORIGIN}/api/timedtext`);
    expect(u.searchParams.get('lang')).toBe('ko');
    expect(u.searchParams.get('fmt')).toBe('json3');
    for (const k of ['v', 'pot', 'potc', 'signature', 'sparams', 'expire', 'ei', 'c', 'cver']) expect(u.searchParams.get(k)).toBe(orig.searchParams.get(k));
    expect(u.searchParams.has('kind') || u.searchParams.has('tlang') || u.searchParams.has('name')).toBe(false);
  });

  it('自动生成的轨带 kind=asr；YouTube 机翻带 tlang；换回人工轨时去掉', () => {
    const asr = new URL(trackUrl(PLAYER_URL, ORIGIN, VID, { track: track('en', { kind: 'asr' }), tlang: 'zh-Hans' })!);
    expect([asr.searchParams.get('lang'), asr.searchParams.get('kind'), asr.searchParams.get('tlang')]).toEqual(['en', 'asr', 'zh-Hans']);
    const back = new URL(trackUrl(asr.toString(), ORIGIN, VID, { track: track('ko', { name: 'CC' }) })!);
    expect([back.searchParams.get('kind'), back.searchParams.get('tlang'), back.searchParams.get('name')]).toEqual([null, null, 'CC']);
  });

  it('广告期间播放器为广告视频取的字幕（2026-11-02 实测 v 是广告的 ID）：认得出是别的视频，不拿来用', () => {
    const adUrl = PLAYER_URL.replace(`v=${VID}`, 'v=QoI7QEvAljo').replace('lang=en', 'lang=en&kind=asr');
    expect(timedtextVideoId(adUrl, ORIGIN)).toBe('QoI7QEvAljo');
    expect(trackUrl(adUrl, ORIGIN, VID, { track: track('ko') })).toBeUndefined();
  });

  it('别的视频、别的站点、没有令牌的地址一律不用', () => {
    expect(trackUrl(PLAYER_URL, ORIGIN, 'otherVideo1', { track: track('ko') })).toBeUndefined();
    expect(trackUrl(PLAYER_URL.replace(ORIGIN, 'https://evil.example'), ORIGIN, VID, { track: track('ko') })).toBeUndefined();
    expect(trackUrl(PLAYER_URL.replace('&pot=FAKE-POT-TOKEN', ''), ORIGIN, VID, { track: track('ko') })).toBeUndefined();
  });
});

// 2026-11-03 用户报告：部分视频一直"正在读取字幕…"。实测 YouTube 的字幕接口（连同播放器自己的请求）20 秒后才回、多数 40 秒后 502（DECISIONS §42）
describe('取字幕失败与重试', () => {
  const o = { retryDelaysMs: [5_000, 15_000, 30_000], timeoutMs: 60_000 };

  it('YouTube 服务器出错（5xx）、限流（429）、超时、连不上：暂时的，按 5 / 15 / 30 秒重试', () => {
    expect(ccFetchRetry({ http: 502 }, 1, o)).toEqual({ message: 'YouTube 的字幕服务器出错（HTTP 502）', retryInMs: 5_000 });
    expect(ccFetchRetry({ http: 503 }, 2, o).retryInMs).toBe(15_000);
    expect(ccFetchRetry({ http: 429 }, 3, o)).toEqual({ message: 'YouTube 的字幕接口暂时限流（HTTP 429）', retryInMs: 30_000 });
    expect(ccFetchRetry({ timeout: true }, 1, o)).toEqual({ message: 'YouTube 的字幕接口 60 秒没有回应', retryInMs: 5_000 });
    expect(ccFetchRetry({ network: true }, 1, o)).toEqual({ message: '连不上 YouTube 的字幕接口', retryInMs: 5_000 });
  });

  it('重试用完：停下，说明重试了几次，并告诉你是 YouTube 那边的问题、怎么再试', () => {
    const r = ccFetchRetry({ http: 502 }, 4, o);
    expect(r.retryInMs).toBeUndefined();
    expect(r.message).toBe('YouTube 的字幕服务器出错（HTTP 502），重试 3 次仍不行');
    expect(r.hint).toContain('YouTube 那边');
    expect(r.hint).toContain('关掉再打开多语字幕即重试');
    expect(ccFetchRetry({ network: true }, 4, o).hint).toContain('检查网络');
    // 不重试时（retryDelaysMs 为空）第一次失败就停下，不说"重试 0 次"
    expect(ccFetchRetry({ http: 500 }, 1, { ...o, retryDelaysMs: [] }).message).toBe('YouTube 的字幕服务器出错（HTTP 500）');
  });

  it('其余 HTTP 错误（4xx）重试也没用：直接说明，不重试', () => {
    expect(ccFetchRetry({ http: 403 }, 1, o)).toEqual({ message: 'YouTube 的字幕接口返回 HTTP 403' });
    expect(ccFetchRetry({ http: 404 }, 1, o)).toEqual({ message: 'YouTube 的字幕接口返回 HTTP 404' });
  });

  it('默认参数来自配置：最多重试 3 次，一次最多等 60 秒（YouTube 自己的网关约 40 秒放弃）', () => {
    expect(MULTI_CC.fetchRetryDelaysMs.length).toBe(3);
    expect(MULTI_CC.fetchTimeoutMs).toBeGreaterThan(40_000);
    expect(ccFetchRetry({ http: 502 }, 1).retryInMs).toBe(MULTI_CC.fetchRetryDelaysMs[0]);
    expect(ccFetchRetry({ http: 502 }, MULTI_CC.fetchRetryDelaysMs.length + 1).retryInMs).toBeUndefined();
  });
});

describe('等字幕时说明在等什么（不再一直"正在读取字幕…"）', () => {
  const o = { slowFetchMs: 8_000, maxRetries: 3 };
  const now = 1_000_000;
  const loading = (ago: number, attempt = 1): CcLoad => ({ state: 'loading', since: now - ago, attempt });
  const retry = (inMs: number, attempt: number): CcLoad => ({ state: 'retry', message: 'YouTube 的字幕服务器出错（HTTP 502）', at: now + inMs, attempt });

  it('刚发出、或还没开始取：正在读取字幕…', () => {
    expect(ccWaitStatus([loading(2_000), undefined], now, o)).toBe('正在读取字幕…');
    expect(ccWaitStatus([], now, o)).toBe('正在读取字幕…');
  });

  it('请求等了 8 秒以上：说明是 YouTube 的字幕接口慢，按最早发出的那个算已等几秒；重试中的写明第几次', () => {
    expect(ccWaitStatus([loading(3_000), loading(25_400)], now, o)).toBe('YouTube 的字幕接口响应很慢，已等 25 秒…');
    expect(ccWaitStatus([loading(12_000, 2)], now, o)).toBe('YouTube 的字幕接口响应很慢，已等 12 秒…（第 1 次重试）');
  });

  it('都在等重试：出了什么错、几秒后重试、第几次（按最早到点的那个）', () => {
    expect(ccWaitStatus([retry(14_200, 3), retry(4_100, 2)], now, o)).toBe('YouTube 的字幕服务器出错（HTTP 502），5 秒后重试（第 1 次，最多 3 次）');
    expect(ccWaitStatus([retry(-300, 2)], now, o)).toBe('YouTube 的字幕服务器出错（HTTP 502），1 秒后重试（第 1 次，最多 3 次）');
  });

  it('有请求在途（还不算慢）、另一种在等重试：正在读取字幕…', () => {
    expect(ccWaitStatus([loading(1_000, 2), retry(10_000, 2)], now, o)).toBe('正在读取字幕…');
  });
});

describe('页面内助手报来的字幕轨列表（不可信）', () => {
  it('逐项校验：坏的语言代码丢掉，名字截断，kind 只认 asr', () => {
    const l = sanitizeTrackList({
      videoId: VID,
      tracks: [
        { lang: 'ko', kind: 'asr', name: '', label: 'Korean (auto-generated)', vssId: 'a.ko', translatable: true },
        { lang: '<script>', kind: '', label: 'x' },
        { lang: 'en', kind: 'weird', name: 'n'.repeat(400), label: 'L'.repeat(300), translatable: 'yes' },
        null,
      ],
      translationLangs: [{ code: 'zh-Hans', label: 'Chinese' }, { code: 'bad code' }, 5],
      native: { lang: 'en', kind: '', tlang: 'zh-Hans' },
    })!;
    expect(l.tracks).toHaveLength(2);
    expect(l.tracks[0]).toEqual({ lang: 'ko', kind: 'asr', name: '', label: 'Korean (auto-generated)', vssId: 'a.ko', translatable: true });
    expect([l.tracks[1]!.kind, l.tracks[1]!.name.length, l.tracks[1]!.label.length, l.tracks[1]!.translatable]).toEqual(['', 150, 120, false]);
    expect(l.translationLangs).toEqual([{ code: 'zh-Hans', label: 'Chinese' }]);
    expect(l.native).toEqual({ lang: 'en', kind: '', tlang: 'zh-Hans' });
  });

  it('视频 ID 不对或不是对象：整体不收；原生字幕关着是 null', () => {
    expect(sanitizeTrackList({ videoId: 'x y', tracks: [] })).toBeUndefined();
    expect(sanitizeTrackList('nope')).toBeUndefined();
    expect(sanitizeTrackList({ videoId: VID })).toEqual({ videoId: VID, tracks: [], translationLangs: [], native: null });
  });
});

describe('设置', () => {
  it('默认：启用、不自动开启、原声 + 英文 + 简体中文、用 YouTube 自动翻译补缺', () => {
    expect(DEFAULT_SETTINGS.multiCaptions).toEqual({ enabled: true, autoOn: false, langs: ['original', 'en', 'zh-Hans'], autoTranslate: true, fontScale: 1 });
    expect(mergeSettings(undefined).multiCaptions.langs).toEqual(['original', 'en', 'zh-Hans']);
  });

  it('旧数据没有这一节也能读；存下的语言列表去掉坏值、去重、最多 4 种', () => {
    expect(mergeSettings({ subtitles: { enabled: true } }).multiCaptions).toEqual(DEFAULT_SETTINGS.multiCaptions);
    const s = mergeSettings({ multiCaptions: { autoOn: true, langs: ['ko', 'ko', 'bad code', ORIGINAL, 'en', 'ja', 'fr'] } });
    expect(s.multiCaptions.autoOn).toBe(true);
    expect(s.multiCaptions.langs).toEqual(['ko', ORIGINAL, 'en', 'ja']);
    expect(mergeSettings({ multiCaptions: { langs: 'ko' } }).multiCaptions.langs).toEqual(['original', 'en', 'zh-Hans']);
  });

  it('sanitizeCcLangs：不是数组返回 undefined；空数组保留', () => {
    expect(sanitizeCcLangs('ko')).toBeUndefined();
    expect(sanitizeCcLangs([])).toEqual([]);
    expect(sanitizeCcLangs(['zh-Hant', 3, 'original'])).toEqual(['zh-Hant', 'original']);
  });
});

describe('片段录制烧录多语字幕', () => {
  it('每行保留自己的颜色', () => {
    const boxes = layoutBurnIn(
      [
        { text: '대학에 다닐 때', tone: 'source', color: '#ffffff' },
        { text: 'So in college,', tone: 'translation', color: '#ffe7a3' },
        { text: '上大学那会儿，', tone: 'translation', color: '#bfe4ff' },
      ],
      { width: 1280, height: 720, measure: (t, px) => t.length * px * 0.6 },
    );
    expect(boxes.map((b) => b.color)).toEqual(['#ffffff', '#ffe7a3', '#bfe4ff']);
    expect(boxes[0]!.y).toBeLessThan(boxes[2]!.y);
  });
});

describe('后台：视频原声的语言（官方 videos.list）', () => {
  function ctxWith(opts: { authStatus?: string; items?: unknown[]; enabled?: boolean }) {
    const requests: string[] = [];
    const http: typeof fetch = async (input, init) => {
      const req = input instanceof Request ? input : new Request(String(input), init);
      requests.push(req.url);
      if (!req.url.startsWith(ENDPOINTS.youtubeApi)) throw new Error(`未预期的请求 ${req.url}`);
      return new Response(JSON.stringify({ items: opts.items ?? [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const kv = memoryKV();
    const auth = { status: async () => opts.authStatus ?? 'connected', getToken: async () => 'tok', invalidate: async () => undefined, disconnect: async () => undefined } as unknown as AuthProvider;
    const ctx: AppContext = { kv, locker: memoryLocker(), http, now: () => Date.parse('2026-11-02T04:00:00Z'), auth, endpoints: ENDPOINTS, timeZone: 'Asia/Shanghai' };
    const init = async () => {
      const s = mergeSettings(undefined);
      await stores.settings.write(kv, { ...s, multiCaptions: { ...s.multiCaptions, enabled: opts.enabled ?? true } });
    };
    return { ctx, requests, init };
  }

  it('查一次（1 unit，记进配额），之后用缓存', async () => {
    const t = ctxWith({ items: [{ id: VID, snippet: { title: "TWS (투어스) '내 이름을 불러줘' Official MV", defaultAudioLanguage: 'ko' }, contentDetails: { duration: 'PT3M30S' } }] });
    await t.init();
    expect(await multiCcVideoLanguage(t.ctx, VID)).toEqual({ lang: 'ko' });
    expect(await multiCcVideoLanguage(t.ctx, VID)).toEqual({ lang: 'ko' });
    expect(t.requests).toHaveLength(1);
    expect(new URL(t.requests[0]!).pathname.endsWith('/videos')).toBe(true);
    const usage = Object.values((await stores.quotaLedger.read(t.ctx.kv)).days)[0]!;
    expect(usage.byMethod['videos.list']).toBe(1);
  });

  it('没连接 YouTube、数据里没写语言：说明原因；视频 ID 不对、功能关闭：什么也不查', async () => {
    const off = ctxWith({ authStatus: 'disconnected' });
    await off.init();
    expect((await multiCcVideoLanguage(off.ctx, VID)).note).toContain('没有连接 YouTube');
    const none = ctxWith({ items: [{ id: VID, snippet: { title: 'x' }, contentDetails: { duration: 'PT1M' } }] });
    await none.init();
    expect((await multiCcVideoLanguage(none.ctx, VID)).note).toContain('没写');
    const disabled = ctxWith({ enabled: false });
    await disabled.init();
    expect(await multiCcVideoLanguage(disabled.ctx, VID)).toEqual({});
    expect(await multiCcVideoLanguage(none.ctx, 'bad id!')).toEqual({});
    expect(off.requests.length + disabled.requests.length).toBe(0);
  });
});
