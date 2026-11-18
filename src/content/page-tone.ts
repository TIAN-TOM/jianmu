// 卡片周围的页面是浅色还是深色：从卡片要插的地方往上找第一个有底色的节点，按底色的亮度分。
// 只看算出来的底色，不认站点自己的类名和属性；卡片的明暗跟着它，不跟系统。

export type PageTone = "light" | "dark";

/** 亮度低于这个算深色：常见的浅色页面在 0.8 以上，深色页面在 0.1 以下。 */
const DARK_BELOW = 0.4;
/** 不透明度不到这么多的底色当成没有，接着往上找。 */
const OPAQUE_ENOUGH = 0.5;

const NUMBER = "(-?\\d*\\.?\\d+)";
const ALPHA = `(?:\\s*[,/]\\s*${NUMBER}(%?))?`;
const RGB = new RegExp(`^rgba?\\(\\s*${NUMBER}\\s*,?\\s*${NUMBER}\\s*,?\\s*${NUMBER}${ALPHA}\\s*\\)$`);
const SRGB = new RegExp(`^color\\(srgb\\s+${NUMBER}\\s+${NUMBER}\\s+${NUMBER}${ALPHA}\\s*\\)$`);

interface Tint {
  /** 相对亮度，0 最暗、1 最亮。 */
  readonly luminance: number;
  readonly alpha: number;
}

const linear = (channel: number): number => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
const clamp = (value: number): number => Math.min(1, Math.max(0, value));

/** 算出来的底色读成亮度和不透明度；认不出的写法是 null。 */
export function tintOf(color: string): Tint | null {
  const text = color.trim();
  const rgb = RGB.exec(text);
  const srgb = rgb ? null : SRGB.exec(text);
  const found = rgb ?? srgb;
  if (!found) return null;
  const scale = rgb ? 255 : 1;
  const [r, g, b] = [found[1], found[2], found[3]].map((part) => linear(clamp(Number(part) / scale)));
  if (r === undefined || g === undefined || b === undefined) return null;
  const alpha = found[4] === undefined ? 1 : clamp(Number(found[4]) / (found[5] === "%" ? 100 : 1));
  if (![r, g, b, alpha].every(Number.isFinite)) return null;
  return { luminance: 0.2126 * r + 0.7152 * g + 0.0722 * b, alpha };
}

/**
 * 从 start 往上找第一个底色够不透明的节点，回它是浅色还是深色；一路都没有底色、或者写法认不出时是 null。
 * backgroundOf 回一个节点算出来的底色。
 */
export function pageTone<T extends { readonly parentElement: T | null }>(start: T | null, backgroundOf: (node: T) => string): PageTone | null {
  for (let node = start; node; node = node.parentElement) {
    const tint = tintOf(backgroundOf(node));
    if (tint && tint.alpha >= OPAQUE_ENOUGH) return tint.luminance < DARK_BELOW ? "dark" : "light";
  }
  return null;
}
