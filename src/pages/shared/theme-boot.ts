// 首帧外观：四个扩展页面 <head> 里第一个加载的经典脚本，第一帧之前把缓存的主题、明暗和字号写到 html 上。
// 外观设置要异步读回，没有这一步，选了别的主题、明暗或字号的人会先看到默认样子一闪；缓存由 theme.ts 每次落地外观时写。
// 不导入别的模块，打出来只有这一个小文件；键名和合法取值要和设置模块一致，单元测试核对。

export const CACHE_KEY = "jianmu_appearance";
/** 卡片嵌在视频页里时，内容脚本把页面的明暗写在卡片地址 # 后面的这个参数里。 */
export const TONE_PARAM = "tone";
export const THEMES = Object.freeze(["timecode", "marker", "band", "pinkblue", "redblack"] as const);
/** 默认主题：没有缓存时也写到 html 上，各套主题的版面规则都按这个属性写。 */
export const DEFAULT_THEME: (typeof THEMES)[number] = "marker";
export const MODES = Object.freeze(["system", "light", "dark"] as const);
export const FONT_SCALES = Object.freeze([100, 112, 125] as const);

export interface CachedAppearance {
  accentTheme?: (typeof THEMES)[number];
  themeMode?: (typeof MODES)[number];
  uiFontScale?: (typeof FONT_SCALES)[number];
}

export interface BootRoot {
  readonly dataset: Record<string, string | undefined>;
  readonly style: { setProperty(name: string, value: string): void };
}

const isOneOf = <T>(list: readonly T[], value: unknown): value is T => (list as readonly unknown[]).includes(value);

/** 读缓存，只留下合法的项；没有、损坏或读存储抛错时什么都不留。 */
export function readCache(storage: Pick<Storage, "getItem"> | null | undefined): CachedAppearance {
  let cached: unknown;
  try {
    cached = JSON.parse(storage?.getItem(CACHE_KEY) ?? "null");
  } catch {
    return {};
  }
  if (typeof cached !== "object" || cached === null) return {};
  const { accentTheme, themeMode, uiFontScale } = cached as Record<string, unknown>;
  const valid: CachedAppearance = {};
  if (isOneOf(THEMES, accentTheme)) valid.accentTheme = accentTheme;
  if (isOneOf(MODES, themeMode)) valid.themeMode = themeMode;
  if (isOneOf(FONT_SCALES, uiFontScale)) valid.uiFontScale = uiFontScale;
  return valid;
}

/** 地址 # 后面写的页面明暗；没写或写得不对是 null。 */
export function toneOf(hash: string): "light" | "dark" | null {
  const found = new RegExp(`(?:^#|&)${TONE_PARAM}=(light|dark)(?:&|$)`).exec(hash)?.[1];
  return found === "light" || found === "dark" ? found : null;
}

/**
 * 写法和 theme.ts 落地外观时一样：「跟随系统」按系统明暗解析成具体的一种。主题总写上，没有缓存就是默认主题；
 * 明暗和字号缺了不写，交给样式表的默认。给了所在页面的明暗（只有卡片有），明暗跟它，不跟缓存的设置。
 */
export function applyCache(cached: CachedAppearance, root: BootRoot, prefersDark: boolean, tone: "light" | "dark" | null = null): void {
  root.dataset.accentTheme = cached.accentTheme ?? DEFAULT_THEME;
  if (tone) root.dataset.themeMode = tone;
  else if (cached.themeMode) root.dataset.themeMode = cached.themeMode === "system" ? (prefersDark ? "dark" : "light") : cached.themeMode;
  if (cached.uiFontScale) root.style.setProperty("--ui-font-zoom", String(cached.uiFontScale / 100));
}

function boot(): void {
  let storage: Storage | null = null;
  try {
    storage = localStorage;
  } catch {
    // 存储被禁用时连读这个属性都会抛错，按默认画。
  }
  const prefersDark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  applyCache(readCache(storage), document.documentElement, prefersDark, typeof location === "undefined" ? null : toneOf(location.hash));
}

if (typeof document !== "undefined") boot();
