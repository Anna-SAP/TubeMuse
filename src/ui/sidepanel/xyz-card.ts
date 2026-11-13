// 小宇宙的片段快照卡片（DECISIONS §72）：在侧边栏里用画布画出来，存成 PNG。
// 上：单集封面、标题、节目名、"TubeMuse × 小宇宙"；中：这一段的中文字幕（引文）与英文字幕；
// 下：播放按钮样式的圆、真实波形（所选区间高亮）、"04:52 – 05:18 (26s)"；底：单集链接。
// 波形来自这一段前后的真实音频（侧边栏解码后算的响度），不是装饰图案；读不到音频时画一条平线并在卡片上注明。

import { wrapText } from '../../core/clips';

export interface CardData {
  title: string;
  podcastTitle: string;
  cover?: HTMLImageElement | undefined;
  /** 节目主题色（#rrggbb） */
  color?: string | undefined;
  zh: string;
  en: string;
  /** 每根柱子的响度（0–1）；undefined = 没读到音频 */
  bars?: number[] | undefined;
  /** 所选区间在波形里的位置（0–1） */
  selFrom: number;
  selTo: number;
  label: string;
  url: string;
}

const W = 1080;
const PAD = 56;
const FONT = '"PingFang SC", "Microsoft YaHei", "Noto Sans SC", "Noto Sans CJK SC", system-ui, sans-serif';
const ACCENT = '#7c5cff';

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16)] : [185, 184, 255];
}

function mix(hex: string, white: number): string {
  const [r, g, b] = hexToRgb(hex);
  const f = (c: number) => Math.round(c + (255 - c) * white);
  return `rgb(${f(r)}, ${f(g)}, ${f(b)})`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 折行，超过 maxLines 时最后一行以"…"结尾 */
function lines(ctx: CanvasRenderingContext2D, text: string, width: number, px: number, weight: number, maxLines: number): string[] {
  ctx.font = `${weight} ${px}px ${FONT}`;
  const all = wrapText(text, width, px, (t) => ctx.measureText(t).width);
  if (all.length <= maxLines) return all;
  const out = all.slice(0, maxLines);
  let last = out[maxLines - 1]!;
  while (last && ctx.measureText(last + '…').width > width) last = last.slice(0, -1);
  out[maxLines - 1] = last + '…';
  return out;
}

/** 画好的卡片（画布）。高度随文字多少变化 */
export function drawCard(d: CardData, doc: Document = document): HTMLCanvasElement {
  const canvas = doc.createElement('canvas');
  const measure = doc.createElement('canvas').getContext('2d')!;
  const color = d.color ?? '#b9b8ff';
  const inner = W - PAD * 2;
  const textW = inner - 96 - 48;
  const titleLines = lines(measure, d.title || '（无标题）', inner - 48 - 168 - 32 - 40, 44, 700, 2);
  const zhLines = d.zh ? lines(measure, d.zh, textW, 44, 600, 8) : [];
  const enLines = d.en ? lines(measure, d.en, textW, 30, 400, 6) : [];
  const headH = 48 + Math.max(168, 70 + titleLines.length * 58 + 48) + 40;
  const quoteH = 90 + zhLines.length * 66 + (enLines.length ? 24 + enLines.length * 44 : 0) + (zhLines.length || enLines.length ? 0 : 60) + 40;
  const waveH = 200;
  const footH = 90;
  const H = PAD + headH + quoteH + waveH + footH + PAD;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;

  // 背景：节目主题色的渐变
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, mix(color, 0.25));
  bg.addColorStop(1, mix(color, 0.8));
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 卡片
  ctx.save();
  ctx.shadowColor = 'rgba(60, 40, 140, 0.18)';
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 12;
  roundRect(ctx, PAD, PAD, inner, H - PAD * 2, 40);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();

  const x0 = PAD + 48;
  let y = PAD + 48;
  // 封面
  ctx.save();
  roundRect(ctx, x0, y, 168, 168, 24);
  ctx.clip();
  if (d.cover && d.cover.complete && d.cover.naturalWidth) {
    ctx.drawImage(d.cover, x0, y, 168, 168);
  } else {
    ctx.fillStyle = mix(color, 0.1);
    ctx.fillRect(x0, y, 168, 168);
    ctx.fillStyle = '#ffffff';
    ctx.font = `700 72px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(Array.from(d.podcastTitle || d.title || '宇')[0] ?? '宇', x0 + 84, y + 88);
  }
  ctx.restore();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // 标识
  ctx.font = `600 24px ${FONT}`;
  const badge = 'TubeMuse × 小宇宙';
  const bw = ctx.measureText(badge).width + 36;
  const bx = PAD + inner - 40 - bw;
  roundRect(ctx, bx, y, bw, 48, 24);
  ctx.fillStyle = mix(ACCENT, 0.88);
  ctx.fill();
  ctx.fillStyle = ACCENT;
  ctx.fillText(badge, bx + 18, y + 32);

  // 标题与节目名
  const tx = x0 + 168 + 32;
  let ty = y + 70 + 44;
  ctx.fillStyle = '#1f1b2e';
  ctx.font = `700 44px ${FONT}`;
  for (const l of titleLines) {
    ctx.fillText(l, tx, ty);
    ty += 58;
  }
  ctx.fillStyle = '#6f6a85';
  ctx.font = `400 30px ${FONT}`;
  ctx.fillText(d.podcastTitle, tx, ty + 4);
  y += headH - 48;

  // 引文
  ctx.fillStyle = mix(ACCENT, 0.7);
  ctx.font = `700 120px Georgia, serif`;
  ctx.fillText('“', x0 - 8, y + 90);
  let qy = y + 90;
  ctx.fillStyle = '#1f1b2e';
  ctx.font = `600 44px ${FONT}`;
  for (const l of zhLines) {
    ctx.fillText(l, x0 + 48, qy);
    qy += 66;
  }
  if (enLines.length) {
    qy += 24 - 22;
    ctx.fillStyle = '#6f6a85';
    ctx.font = `400 30px ${FONT}`;
    for (const l of enLines) {
      ctx.fillText(l, x0 + 48, qy);
      qy += 44;
    }
  }
  if (!zhLines.length && !enLines.length) {
    ctx.fillStyle = '#9a95ad';
    ctx.font = `400 30px ${FONT}`;
    ctx.fillText('（这一段还没有字幕）', x0 + 48, qy);
  }
  y += quoteH;

  // 播放按钮 + 波形
  const cy = y + 70;
  ctx.fillStyle = ACCENT;
  ctx.beginPath();
  ctx.arc(x0 + 48, cy, 48, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(x0 + 36, cy - 22);
  ctx.lineTo(x0 + 36, cy + 22);
  ctx.lineTo(x0 + 70, cy);
  ctx.closePath();
  ctx.fill();
  const wx = x0 + 128;
  const ww = PAD + inner - 48 - wx;
  const bars = d.bars?.length ? d.bars : Array.from({ length: 72 }, () => 0);
  const step = ww / bars.length;
  for (let i = 0; i < bars.length; i++) {
    const frac = (i + 0.5) / bars.length;
    const on = frac >= d.selFrom && frac <= d.selTo;
    const h = d.bars ? Math.max(6, bars[i]! * 100) : 4;
    ctx.fillStyle = on ? ACCENT : '#d9d5e8';
    roundRect(ctx, wx + i * step + step * 0.2, cy - h / 2, Math.max(2, step * 0.6), h, Math.min(3, step * 0.3));
    ctx.fill();
  }
  // 起止标记
  for (const f of [d.selFrom, d.selTo]) {
    const x = wx + f * ww;
    ctx.fillStyle = ACCENT;
    ctx.fillRect(x - 2, cy - 62, 4, 124);
    ctx.beginPath();
    ctx.arc(x, cy + 64, 9, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.font = `600 28px ${FONT}`;
  const lw = ctx.measureText(d.label).width + 36;
  const lx = Math.min(PAD + inner - 48 - lw, Math.max(wx, wx + ((d.selFrom + d.selTo) / 2) * ww - lw / 2));
  roundRect(ctx, lx, cy + 86, lw, 48, 24);
  ctx.fillStyle = mix(ACCENT, 0.9);
  ctx.fill();
  ctx.fillStyle = ACCENT;
  ctx.fillText(d.label, lx + 18, cy + 120);
  if (!d.bars) {
    ctx.fillStyle = '#9a95ad';
    ctx.font = `400 22px ${FONT}`;
    ctx.fillText('（没读到这段音频，波形未画出）', wx, cy - 30);
  }
  y += waveH;

  // 底部
  ctx.fillStyle = '#9a95ad';
  ctx.font = `400 24px ${FONT}`;
  ctx.fillText(d.url.replace(/^https:\/\//, ''), x0, y + 40);
  ctx.textAlign = 'right';
  ctx.font = `600 24px ${FONT}`;
  ctx.fillText('TubeMuse', PAD + inner - 48, y + 40);
  ctx.textAlign = 'left';
  return canvas;
}

export function canvasPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('画布没能存成 PNG（封面图可能不允许跨站使用）'))), 'image/png'));
}
