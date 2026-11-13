// @ts-check
// e2e 用的仿小宇宙（www.xiaoyuzhoufm.com）单集页（由 mock 服务在 /xyz/ 下提供），结构照 2026-11-13 实测的真实页面：
// - Next.js 页面：header 里是封面（img.avatar）、h1 标题、.podcast-title a.name（指向 /podcast/<ID>）、time[datetime]；
//   节目简介在 section[aria-label="节目show notes"] 里；页面自带的数据在 script#__NEXT_DATA__（episode.eid / title / description / duration / enclosure / podcast）；
// - 底部播放器 section[aria-label="播放器"]：进度条 .progress-wrap、两个时间标签（.label.left / .label.right）、
//   "后退15秒 / 播放 / 前进15秒"三个按钮和一个 <audio>（真实页面的音频在 media.xyzcdn.net，是跨站的；这里同源，但 TubeMuse 一样不从它取声音）。
// 音频是测试夹具：每 3 秒一段音（0.5 秒起、1.8 秒长），第 k 段是 300 + 20k Hz，mock 转写据此认出"这是第几段"，用来核对字幕的时间。
// 页面记下自己按钮上的点击次数，用来确认 TubeMuse 从不点小宇宙的按钮。
import { readFileSync } from 'node:fs';

const MOCK = 'http://127.0.0.1:47321';

/** /xyzimg/…：仿小宇宙图片 CDN 的封面（一张 PNG，像真实 CDN 一样允许跨站使用） */
export function xyzImage(/** @type {string} */ p) {
  if (!p.startsWith('/xyzimg/')) return undefined;
  return { status: 200, headers: { 'content-type': 'image/png', 'access-control-allow-origin': '*' }, body: readFileSync(new URL('../../static/icons/icon-128.png', import.meta.url)) };
}

/** m4a（AAC）的那一集：92 秒，30 段音 */
export const XYZ_EP = {
  eid: '6af02451b4a4e20202f67f19',
  pid: '670f3da40d2f24f28978736f',
  title: '#817.测试单集：你的旧提示词正在让AI变差',
  podcast: '测试节目串门儿',
  file: 'xyz-tones.m4a',
  mime: 'audio/mp4',
  seconds: 92,
  cover: `${MOCK}/xyzimg/FgPi3C76e0yvQlUYo8TDbk1GTgp8.png@small`,
};
/** 可变码率 mp3 的那一集：600 秒；跳转后 Chrome 报告的时间与实际放的声音差几秒 */
export const XYZ_VBR = {
  eid: '6af0aaaab4a4e20202f6bbbb',
  pid: '5e5c52c9418a84a04625e6cc',
  title: '测试 VBR 单集：硅谷来信',
  podcast: '测试节目串门儿',
  file: 'xyz-tones-vbr.mp3',
  mime: 'audio/mpeg',
  seconds: 600,
  cover: `${MOCK}/xyzimg/Fkvbrcover0000000000000000.png@small`,
};
const EPISODES = [XYZ_EP, XYZ_VBR];

const files = new Map();
/** @param {string} name */
function fixture(name) {
  if (!files.has(name)) files.set(name, readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));
  return /** @type {Buffer} */ (files.get(name));
}

/** /xyzmedia/<节目>/<文件>：带 Range 支持的音频（和真实 CDN 一样回 206 + Content-Range） @param {string} p @param {string | undefined} range */
export function xyzMedia(p, range) {
  const ep = EPISODES.find((e) => p === `/xyzmedia/${e.pid}/${e.file}`);
  if (!ep) return undefined;
  const buf = fixture(ep.file);
  const m = /bytes=(\d+)-(\d*)/.exec(range ?? '');
  if (m) {
    const start = Number(m[1]);
    const end = m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
    if (start >= buf.length) return { status: 416, headers: { 'content-range': `bytes */${buf.length}` }, body: Buffer.alloc(0) };
    return { status: 206, headers: { 'content-type': ep.mime, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${buf.length}`, 'content-length': String(end - start + 1) }, body: buf.subarray(start, end + 1) };
  }
  return { status: 200, headers: { 'content-type': ep.mime, 'accept-ranges': 'bytes', 'content-length': String(buf.length) }, body: buf };
}

const clock = (/** @type {number} */ s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** 页面上的小播放器：点播放 / 暂停，进度条与时间标签跟着 <audio> 走 */
const PLAYER_SCRIPT = `
window.__nativeClicks = 0;
document.addEventListener('click', () => window.__nativeClicks++, true);
const a = document.querySelector('section[aria-label="播放器"] audio');
const pp = document.getElementById('pp');
pp.addEventListener('click', () => (a.paused ? a.play() : a.pause()));
const fmt = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(Math.floor(s % 60)).padStart(2, '0');
const sync = () => {
  document.querySelector('.label.left').textContent = fmt(a.currentTime);
  const d = a.duration || 1;
  document.querySelector('.progress').style.transform = 'translate3d(' + (-100 + (a.currentTime / d) * 100) + '%, 0px, 0px)';
  pp.setAttribute('aria-label', a.paused ? '播放' : '暂停');
};
for (const ev of ['timeupdate', 'play', 'pause', 'seeked']) a.addEventListener(ev, sync);
`;

/** @param {string} p */
export function xyzPage(p) {
  const m = /^\/xyz\/episode\/([0-9a-f]{24})$/.exec(p);
  if (!m) {
    if (p === '/xyz/' || p.startsWith('/xyz/podcast/')) return `<!doctype html><html><head><meta charset="utf-8"><title>小宇宙 - 听播客，上小宇宙</title></head><body><h1>节目页</h1><a href="/xyz/episode/${XYZ_EP.eid}">去单集</a></body></html>`;
    return undefined;
  }
  const ep = EPISODES.find((e) => e.eid === m[1]);
  if (!ep) return undefined;
  const audio = `${MOCK}/xyzmedia/${ep.pid}/${ep.file}`;
  const notes = `本期嘉宾 Lance Martin 是 Anthropic 的技术人员，聊 prompt 缓存、eval 与 effort。\n⏱️ 时间戳\n00:30 开场`;
  const next = {
    props: {
      pageProps: {
        episode: {
          type: 'EPISODE',
          eid: ep.eid,
          pid: ep.pid,
          title: ep.title,
          description: notes,
          duration: ep.seconds,
          enclosure: { url: audio },
          media: { source: { mode: 'PUBLIC', url: audio } },
          pubDate: '2026-11-08T23:00:00.000Z',
          podcast: { pid: ep.pid, title: ep.podcast, image: { smallPicUrl: ep.cover }, color: { original: '#b9b8ff' } },
        },
        comments: [{ text: '评论区的文字（TubeMuse 不读）' }],
      },
    },
    page: '/episode/[id]',
    query: { id: ep.eid },
  };
  return (
    `<!doctype html><html lang="zh-Hans"><head><meta charset="utf-8"><title>${ep.title} - ${ep.podcast} | 小宇宙 - 听播客，上小宇宙</title>` +
    `<meta property="og:title" content="${ep.title}"><meta property="og:image" content="${ep.cover.replace('@small', '')}"><meta property="og:audio" content="${audio}">` +
    `<style>body{margin:0;font:14px sans-serif}main{max-width:600px;margin:auto;padding-bottom:140px}header{text-align:center}.avatar{width:123px;height:123px}section[aria-label="播放器"]{position:fixed;left:0;right:0;bottom:0;height:90px;background:#fafafa;border-top:1px solid #ddd}.progress-wrap{position:relative;height:4px;background:#eee;overflow:hidden}.progress{position:absolute;inset:0;background:#a19dff;transform:translate3d(-100%,0,0)}.labels{display:flex;justify-content:space-between;padding:4px 8px}.ctl{text-align:center}</style></head>` +
    `<body style="--theme-color: hsl(242,100%,80.8%);"><div id="__next"><main>` +
    `<header class="wrap"><div class="avater-container"><img src="${ep.cover}" alt="${ep.title}" class="avatar"></div><h1 class="title">${ep.title}</h1>` +
    `<div class="podcast-title"><a class="name" href="/podcast/${ep.pid}">${ep.podcast}</a><a href="cosmos://page.cos/podcast/${ep.pid}" class="subscribe"><span>订阅</span></a></div>` +
    `<div class="info">${Math.round(ep.seconds / 60)}分钟 · <time datetime="2026-11-08T23:00:00.000Z">4天前</time></div></header>` +
    `<section aria-label="节目show notes"><div class="sn-content"><article>${notes
      .split('\n')
      .map((l) => `<p><span>${l}</span></p>`)
      .join('')}</article></div></section>` +
    `<section class="comments"><div class="comment">评论区的文字（TubeMuse 不读）</div></section></main>` +
    `<section aria-label="播放器" class="player"><div class="wrap"><div class="progress-wrap"><div class="progress"></div></div><div class="labels"><div class="label left">00:00</div><div class="label right">${clock(ep.seconds)}</div></div></div>` +
    `<div class="ctl"><button aria-label="后退15秒">-15</button><button aria-label="播放" id="pp">▶</button><button aria-label="前进15秒">+30</button></div>` +
    `<audio src="${audio}" preload="none" disableremoteplayback=""></audio><div class="lines"></div></section></div>` +
    `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script>` +
    `<script>${PLAYER_SCRIPT}</script></body></html>`
  );
}

/** mock 转写：从 WAV 里认出"第几段音"（对每个候选频率算 Goertzel 能量，取最强的），返回段号 @param {Buffer} wav */
export function xyzToneIndex(wav) {
  const at = wav.indexOf('RIFF');
  if (at < 0) return undefined;
  const dataAt = wav.indexOf('data', at);
  if (dataAt < 0) return undefined;
  const rate = wav.readUInt32LE(at + 24);
  const n = Math.min(Math.floor((wav.readUInt32LE(dataAt + 4) || 0) / 2), Math.floor((wav.length - dataAt - 8) / 2));
  const x = new Float64Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    x[i] = wav.readInt16LE(dataAt + 8 + i * 2) / 32768;
    energy += x[i] * x[i];
  }
  if (Math.sqrt(energy / Math.max(1, n)) < 0.02) return undefined;
  let best = -1;
  let bestK = -1;
  for (let k = 0; k < 60; k++) {
    const w = (2 * Math.PI * (300 + 20 * k)) / rate;
    const c = 2 * Math.cos(w);
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < n; i++) {
      const s0 = x[i] + c * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    const p = s1 * s1 + s2 * s2 - c * s1 * s2;
    if (p > best) {
      best = p;
      bestK = k;
    }
  }
  return bestK >= 0 ? bestK : undefined;
}
