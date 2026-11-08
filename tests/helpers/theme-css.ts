// 读主题样式表的文本：按选择器取规则，按主题和明暗解出颜色（含 color-mix 和半透明叠色），算 WCAG 对比度。
// 不靠浏览器，只认样式表里用到的写法：十六进制、transparent、var() 和 in oklab 的 color-mix。

export interface CssRule {
  /** 选择器，空白合成一个空格。 */
  readonly selector: string;
  /** 外面包着的 @media、@supports，没有是 null。 */
  readonly at: string | null;
  readonly body: string;
}

const squash = (text: string): string => text.replace(/\s+/g, " ").trim();

/** 和 from 处的左花括号配对的右花括号；引号里的不算。 */
function closingBrace(text: string, from: number): number {
  let depth = 0;
  let quote = "";
  for (let index = from; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("花括号没配对");
}

/** 去掉注释后的全部规则，@media、@supports 里的一层也拆出来。 */
export function cssRules(css: string): CssRule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: CssRule[] = [];
  const walk = (start: number, end: number, at: string | null): void => {
    let cursor = start;
    while (cursor < end) {
      const open = text.indexOf("{", cursor);
      if (open < 0 || open >= end) return;
      const close = closingBrace(text, open);
      const prelude = squash(text.slice(cursor, open));
      if (prelude.startsWith("@")) walk(open + 1, close, prelude);
      else rules.push({ selector: prelude, at, body: text.slice(open + 1, close) });
      cursor = close + 1;
    }
  };
  walk(0, text.length, null);
  return rules;
}

/** 选择器正好是这一个、外层也对得上的那条规则；没有或不止一条都抛错。 */
export function ruleBody(rules: readonly CssRule[], selector: string, at: string | null = null): string {
  const hits = rules.filter((rule) => rule.selector === squash(selector) && rule.at === at);
  if (hits.length !== 1) throw new Error(`${at ?? ""} ${selector} 有 ${hits.length} 条规则`);
  return hits[0]?.body ?? "";
}

/** 规则里的自定义属性，值去掉首尾空白、换行合成一个空格。 */
export function customProperties(body: string): Record<string, string> {
  return Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name = "", value = ""]) => [name, squash(value)]));
}

/** 同一个选择器（不在 @ 规则里）的全部规则按出现顺序合起来，后写的盖前面的。 */
export function propertiesOf(rules: readonly CssRule[], selector: string): Record<string, string> {
  return Object.assign({}, ...rules.filter((rule) => rule.selector === selector && rule.at === null).map((rule) => customProperties(rule.body)));
}

export type ThemeModeName = "light" | "dark";

/** 根节点写着这套主题和明暗时，样式表落下的全部自定义属性。 */
export function variablesFor(rules: readonly CssRule[], theme: string, defaultTheme: string, mode: ThemeModeName): Record<string, string> {
  return {
    ...propertiesOf(rules, ":root"),
    ...(theme === defaultTheme ? {} : propertiesOf(rules, `:root[data-accent-theme="${theme}"]`)),
    ...(mode === "dark" ? propertiesOf(rules, ':root[data-theme-mode="dark"]') : {}),
  };
}

/** sRGB 三个通道 0–255，透明度 0–1。 */
export type Rgba = readonly [number, number, number, number];

function splitArguments(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

const toLinear = (channel: number): number => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (value: number): number => {
  const c = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, c * 255));
};

function toOklab([r, g, b]: Rgba): [number, number, number] {
  const [lr, lg, lb] = [r, g, b].map(toLinear) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function fromOklab([L, a, b]: readonly [number, number, number]): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

/** color-mix(in oklab, …)：按透明度预乘后插值，再除回去，和浏览器一致。 */
function mixOklab(first: Rgba, firstShare: number, second: Rgba, secondShare: number): Rgba {
  const total = firstShare + secondShare;
  const [p, q] = [firstShare / total, secondShare / total];
  const alpha = first[3] * p + second[3] * q;
  if (alpha === 0) return [0, 0, 0, 0];
  const [x, y] = [toOklab(first), toOklab(second)];
  const lab = [0, 1, 2].map((i) => ((x[i] ?? 0) * first[3] * p + (y[i] ?? 0) * second[3] * q) / alpha) as [number, number, number];
  return [...fromOklab(lab), alpha * Math.min(1, total / 100)];
}

/** 解出一个颜色值。只认样式表里用到的写法，认不出就抛错。 */
export function evaluateColor(variables: Readonly<Record<string, string>>, expression: string, seen: readonly string[] = []): Rgba {
  const value = expression.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
    return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)).concat(1) as unknown as Rgba;
  }
  if (value === "transparent") return [0, 0, 0, 0];
  const reference = /^var\(\s*(--[\w-]+)\s*(?:,(.*))?\)$/.exec(value);
  if (reference) {
    const [, name = "", fallback] = reference;
    if (seen.includes(name)) throw new Error(`${name} 循环引用`);
    const target = variables[name] ?? fallback;
    if (target === undefined) throw new Error(`${name} 没有定义`);
    return evaluateColor(variables, target, [...seen, name]);
  }
  const mix = /^color-mix\(\s*in oklab\s*,(.*)\)$/.exec(value)?.[1];
  if (mix) {
    const [first = "", second = ""] = splitArguments(mix);
    const part = (text: string): [string, number | undefined] => {
      const share = /^(.*?)\s+([\d.]+)%$/.exec(text);
      return share ? [share[1] ?? "", Number(share[2])] : [text, undefined];
    };
    const [a, aShare] = part(first);
    const [b, bShare] = part(second);
    const p = aShare ?? 100 - (bShare ?? 50);
    const q = bShare ?? 100 - p;
    return mixOklab(evaluateColor(variables, a, seen), p, evaluateColor(variables, b, seen), q);
  }
  throw new Error(`认不出的颜色：${value}`);
}

/** 半透明的颜色叠到不透明的底色上，像画布那样按 sRGB 混合，取整到 8 位。 */
export function over(top: Rgba, base: Rgba): Rgba {
  const alpha = top[3];
  return [0, 1, 2].map((i) => Math.round((top[i] ?? 0) * alpha + (base[i] ?? 0) * (1 - alpha))).concat(1) as unknown as Rgba;
}

function luminance([r, g, b]: Rgba): number {
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 对比度。两边都要不透明，半透明的先用 over 叠好。 */
export function contrast(a: Rgba, b: Rgba): number {
  if (a[3] < 1 || b[3] < 1) throw new Error("算对比度前先把半透明的颜色叠到底色上");
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (high + 0.05) / (low + 0.05);
}
