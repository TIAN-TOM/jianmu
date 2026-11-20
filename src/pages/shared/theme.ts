/// <reference types="chrome" />
// 扩展页面的外观：主题、明暗和界面字号落到根节点上，跟着设置变，每次落地都刷新首帧缓存（theme-boot.ts 同步读它）。
// 语言选项跟着外观一起写进首帧缓存（ui-lang.ts 启动时同步读它），每次落地也定下界面语言。设置里不含密钥，这里只取外观三项和语言。
import type { LanguageSetting } from "../../core/output-lang.ts";
import { APPEARANCE_CACHE_KEY, CARD_TONE, SETTINGS_STORAGE_KEY } from "../../shared/names.ts";
import { DEFAULTS, normalize, normalizeUiFontScale, THEME_MODES, type AccentTheme, type ThemeMode, type UiFontScale } from "../../shared/settings-schema.ts";
import type { PageApi } from "./api.ts";
import { setUiLanguage } from "./ui-lang.ts";

export interface Appearance {
  readonly accentTheme: AccentTheme;
  readonly themeMode: ThemeMode;
  readonly uiFontScale: UiFontScale;
  /** 界面文字和模型写的内容用的语言选项。 */
  readonly language: LanguageSetting;
}

export type ResolvedThemeMode = "light" | "dark";

interface MediaQueryLike {
  readonly matches: boolean;
  addEventListener?(type: "change", listener: () => void): void;
  removeEventListener?(type: "change", listener: () => void): void;
}

/** 根节点所在的页面，只列用到的。 */
interface PageView {
  readonly location?: { readonly protocol?: string };
  readonly localStorage?: Pick<Storage, "setItem">;
  readonly matchMedia?: (query: string) => MediaQueryLike;
}

/** 页面的根节点 html。测试里换成只有这几样的替身。 */
export interface AppearanceRoot {
  readonly dataset: Record<string, string | undefined>;
  readonly style?: { setProperty(name: string, value: string): void };
  readonly ownerDocument?: { readonly defaultView?: PageView | null } | null;
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** 设置里的外观三项和语言，不合法的按设置模块的规则规整。 */
export function appearanceOf(input: unknown): Appearance {
  const { accentTheme, themeMode, uiFontScale, language } = normalize(input);
  return { accentTheme, themeMode, uiFontScale, language };
}

// 根节点没有所在页面（单元测试的替身）时退回全局环境；Node 里没有 matchMedia。
const viewOf = (root: AppearanceRoot | null | undefined): PageView | undefined =>
  root?.ownerDocument?.defaultView ?? (typeof matchMedia === "function" ? { matchMedia: (query) => matchMedia(query) } : undefined);

/** 「跟随系统」解析成具体明暗；没有浏览器环境时按浅色。 */
export function resolveThemeMode(mode: ThemeMode = DEFAULTS.themeMode, view: Pick<PageView, "matchMedia"> | undefined = viewOf(null)): ResolvedThemeMode {
  if (mode === THEME_MODES.LIGHT || mode === THEME_MODES.DARK) return mode;
  return view?.matchMedia?.(DARK_QUERY).matches ? "dark" : "light";
}

/** 卡片地址 # 后面写的所在页面的明暗；没写或写得不对是 null。首帧脚本里有同样的一份，单元测试核对两边一致。 */
export function hostModeOf(hash: string): ResolvedThemeMode | null {
  const found = new RegExp(`(?:^#|&)${CARD_TONE.param}=(light|dark)(?:&|$)`).exec(hash)?.[1];
  return found === "light" || found === "dark" ? found : null;
}

/** 界面字号改根字号，四个页面的尺寸都用 rem。返回归档后的那一档。 */
export function applyUiFontScale(scale: unknown, root: AppearanceRoot | null | undefined): UiFontScale {
  const value = normalizeUiFontScale(scale);
  root?.style?.setProperty("--ui-font-zoom", String(value / 100));
  return value;
}

// 只写扩展自己的页面：这个模块万一被带进别人的网页，也不往那边的存储里写东西。
function cacheAppearance(appearance: Appearance, root: AppearanceRoot): void {
  try {
    const view = root.ownerDocument?.defaultView;
    if (view?.location?.protocol !== "chrome-extension:") return;
    view.localStorage?.setItem(APPEARANCE_CACHE_KEY, JSON.stringify(appearance));
  } catch {
    // 存储被禁用或写满了：下次打开时第一帧可能先按默认画，读回设置后就纠正。
  }
}

/**
 * 主题和明暗落在 html 的 data 属性上，由主题样式表按属性切换变量；字号写根字号。返回规整后的外观。
 * 给了 hostMode（嵌在视频页里的卡片所在页面的明暗），明暗跟它，不跟设置。
 */
export function applyAppearance(input: unknown, root: AppearanceRoot | null | undefined, hostMode: ResolvedThemeMode | null = null): Appearance {
  const appearance = appearanceOf(input);
  if (!root?.dataset) return appearance;
  root.dataset.accentTheme = appearance.accentTheme;
  root.dataset.themeMode = hostMode ?? resolveThemeMode(appearance.themeMode, viewOf(root));
  applyUiFontScale(appearance.uiFontScale, root);
  cacheAppearance(appearance, root);
  return appearance;
}

type StorageListener = (changes: { readonly [key: string]: { readonly newValue?: unknown } }, area: string) => void;

export interface WatchAppearanceDeps {
  readonly local: { get(key: string): Promise<Record<string, unknown>> };
  readonly onChanged?: { addListener(listener: StorageListener): void; removeListener(listener: StorageListener): void };
  /** 订阅清除广播。清除全部数据以后按存储里现在的设置（也就是默认值）重写外观和首帧缓存。 */
  readonly onDataCleared?: (listener: (scope: "cache" | "all") => void) => () => void;
  /** 嵌在视频页里的卡片：所在页面现在是浅色还是深色。给了而且认得出，明暗跟它，不跟设置。 */
  readonly hostMode?: () => ResolvedThemeMode | null;
}

export interface AppearanceWatch {
  /** 最近一次落地的外观；一次都没落地（读设置失败、也还没有变化）时是 null。 */
  readonly current: () => Appearance | null;
  /** 所在页面的明暗变了：按现在的重新落地。 */
  readonly refresh: () => void;
  readonly stop: () => void;
}

/** 页面里的真实来源：本机存储和它的变化事件。清除广播见 pageAppearanceSources。 */
export function browserAppearanceStorage(): Pick<WatchAppearanceDeps, "local" | "onChanged"> {
  return { local: chrome.storage.local, onChanged: chrome.storage.onChanged };
}

/** 页面接外观用的全部来源：本机存储和它的变化事件，加上消息客户端收到的清除广播。 */
export function pageAppearanceSources(
  api: Pick<PageApi, "on">,
  storage: Pick<WatchAppearanceDeps, "local" | "onChanged"> = browserAppearanceStorage(),
): WatchAppearanceDeps {
  return { ...storage, onDataCleared: (listener) => api.on("data.cleared", ({ scope }) => listener(scope)) };
}

/**
 * 先读一次设置落地外观，之后设置变了、「跟随系统」时系统明暗变了、清除了全部数据，都重新落地。
 * 读设置失败就留着首帧脚本画的样子。读的途中设置已经变了，以变化为准，不让旧值盖回去。
 */
export async function watchAppearance(deps: WatchAppearanceDeps, root: AppearanceRoot): Promise<AppearanceWatch> {
  let last: Appearance | null = null;
  let generation = 0;
  let stopped = false;
  const land = (raw: unknown): void => {
    if (stopped) return;
    last = applyAppearance(raw, root, deps.hostMode?.() ?? null);
    setUiLanguage(last.language);
  };
  const reload = async (fallback: unknown): Promise<void> => {
    const started = generation;
    let raw = fallback;
    try {
      raw = (await deps.local.get(SETTINGS_STORAGE_KEY))[SETTINGS_STORAGE_KEY];
    } catch {
      if (fallback === undefined) return;
    }
    if (generation === started) land(raw);
  };

  const onStorage: StorageListener = (changes, area) => {
    const change = changes[SETTINGS_STORAGE_KEY];
    if (area !== "local" || !change) return;
    generation += 1;
    land(change.newValue);
  };
  deps.onChanged?.addListener(onStorage);

  const media = viewOf(root)?.matchMedia?.(DARK_QUERY);
  const onScheme = (): void => {
    if (last?.themeMode === THEME_MODES.SYSTEM) land(last);
  };
  media?.addEventListener?.("change", onScheme);

  const unsubscribeCleared = deps.onDataCleared?.((scope) => {
    if (scope === "all") void reload(DEFAULTS);
  });

  await reload(undefined);
  return {
    current: () => last,
    refresh() {
      if (stopped) return;
      if (last) return land(last);
      // 设置还没读回来：先只换明暗，主题和字号留着首帧的样子。
      const mode = deps.hostMode?.();
      if (mode && root.dataset) root.dataset.themeMode = mode;
    },
    stop() {
      stopped = true;
      deps.onChanged?.removeListener(onStorage);
      media?.removeEventListener?.("change", onScheme);
      unsubscribeCleared?.();
    },
  };
}
