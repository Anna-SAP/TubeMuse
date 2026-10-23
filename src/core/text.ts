// 文本工具：中英文混排下的词项匹配、文字脚本推断。

const CJK = /[㐀-鿿豈-﫿]/;
const KANA = /[぀-ヿ]/;
const HANGUL = /[가-힯]/;

export function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 词项是否出现在文本中：CJK 词按子串匹配，拉丁词按词边界匹配。 */
export function containsTerm(text: string, term: string): boolean {
  const t = normalize(term);
  if (!t) return false;
  const hay = normalize(text);
  if (CJK.test(t) || KANA.test(t) || HANGUL.test(t) || /^#/.test(t)) return hay.includes(t);
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(hay);
}

export function matchedTerms(text: string, terms: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const key = normalize(term);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (containsTerm(text, term)) out.push(term);
  }
  return out;
}

export type Script = 'han' | 'kana' | 'hangul' | 'latin' | 'unknown';

/** 按字符占比推断主要文字（只用于语言元数据缺失时的近似判断）。 */
export function dominantScript(text: string): Script {
  let han = 0;
  let kana = 0;
  let hangul = 0;
  let latin = 0;
  for (const ch of text) {
    if (KANA.test(ch)) kana++;
    else if (HANGUL.test(ch)) hangul++;
    else if (CJK.test(ch)) han++;
    else if (/[a-zA-Z]/.test(ch)) latin++;
  }
  if (kana > 0 && kana + han >= latin) return 'kana';
  if (hangul > 0 && hangul >= latin) return 'hangul';
  // 中文标题里常夹英文术语（"Transformer 原理"），而英文视频极少出现汉字：有 2 个以上汉字即判为中文
  if (han >= 2 || (han > 0 && han * 3 >= latin)) return 'han';
  if (latin > 0) return 'latin';
  return 'unknown';
}

export function uniqueStrings(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const s = v.trim();
    const key = normalize(s);
    if (!s || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

export function hasCjk(text: string): boolean {
  return CJK.test(text);
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…';
}

/** 稳定的 53 位哈希（cyrb53），用于缓存键。 */
export function hashString(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** 键排序后的 JSON，保证同一对象得到同一字符串。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
