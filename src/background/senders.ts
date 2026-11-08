// 认发送方，分两段。启用闸门之前的 authenticate 只看扩展编号、来源、扩展页面自己的路径和标签页、窗口、框架编号，
// 不读网页地址；内容脚本在哪个站、看的哪个视频，过了闸门才由 resolveSite 按标签页地址认。
import type { Platform, VideoRef } from "../core/video-ref.ts";
import type { PageName } from "../shared/messages.ts";
import { PAGE_PATHS } from "../shared/names.ts";
import type { SiteRules } from "../sites/types.ts";

/** 闸门之前能知道的：只来自发送方认证，不含任何网页地址。 */
export interface SenderCtx {
  readonly kind: "panel" | "page" | "card" | "content";
  /** 扩展页面是哪一页；认不出的扩展页面是 other，路由一律不放行。 */
  readonly page?: PageName | "other";
  readonly tabId?: number;
  readonly windowId?: number;
  readonly frameId?: number;
}

/** 闸门之后才解析：内容脚本所在的站点和视频，从发送方标签页的地址重新认，消息里的视频只作提示。 */
export interface SiteSenderCtx extends SenderCtx {
  readonly kind: "content";
  readonly site: Platform;
  readonly video: VideoRef;
}

/** 浏览器给的发送方，只列认发送方可能用到的字段。 */
export interface MessageSender {
  readonly id?: string;
  readonly origin?: string;
  readonly url?: string;
  readonly frameId?: number;
  readonly tab?: {
    readonly id?: number;
    readonly windowId?: number;
    readonly url?: string;
    readonly pendingUrl?: string;
  };
}

export interface SenderDeps {
  readonly extensionId: string;
  /** 扩展里一个页面的完整地址，空串是扩展根地址。 */
  readonly extensionUrl: (path: string) => string;
  readonly rules: readonly SiteRules[];
}

export interface Senders {
  readonly authenticate: (sender: MessageSender | undefined) => SenderCtx | null;
  /** 只在过了启用闸门、路由确实要站点或视频时调。认不出是哪个站的视频页时是 null。 */
  readonly resolveSite: (ctx: SenderCtx, sender: MessageSender) => SiteSenderCtx | null;
}

const PAGES: readonly (readonly [string, SenderCtx["kind"], PageName | undefined])[] = [
  [PAGE_PATHS.sidepanel, "panel", undefined],
  [PAGE_PATHS.card, "card", undefined],
  [PAGE_PATHS.options, "page", "options"],
  [PAGE_PATHS.triage, "page", "triage"],
];

// 扩展根地址之后的那段路径：先解码再并掉重复的斜杠、转小写，编码过的路径和原样的认成同一页。
function pathAfter(prefix: string, url: string | undefined): string | null {
  if (typeof url !== "string" || !url.startsWith(prefix)) return null;
  const path = url.slice(prefix.length).split(/[?#]/)[0] ?? "";
  try {
    return decodeURIComponent(path).replace(/\/+/g, "/").replace(/^\//, "").toLowerCase();
  } catch {
    return null;
  }
}

const isTabId = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0;

export function createSenders({ extensionId, extensionUrl, rules }: SenderDeps): Senders {
  const prefix = extensionUrl("");
  const origin = prefix.replace(/\/$/, "");

  function extensionPage(sender: MessageSender, ids: Omit<SenderCtx, "kind">): SenderCtx {
    // 嵌在别的页面里的扩展框架一律按卡片：网页插进来的框架换个写法的路径也照样能跑起来，按路径认不可靠。
    if (sender.tab && sender.frameId !== 0) return { kind: "card", ...ids };
    const path = pathAfter(prefix, sender.url);
    const known = PAGES.find(([page]) => page === path);
    if (!known) return { kind: "page", page: "other", ...ids };
    const [, kind, page] = known;
    // 卡片只会嵌在播放页里；没带标签页的卡片页认不出来历，当成别的扩展页面。
    if (kind === "card" && !sender.tab) return { kind: "page", page: "other", ...ids };
    return page === undefined ? { kind, ...ids } : { kind, page, ...ids };
  }

  return {
    authenticate(sender) {
      if (!sender || sender.id !== extensionId) return null;
      const { id: tabId, windowId } = sender.tab ?? {};
      const { frameId } = sender;
      const ids: Omit<SenderCtx, "kind"> = {
        ...(isTabId(tabId) ? { tabId } : {}),
        ...(Number.isInteger(windowId) ? { windowId } : {}),
        ...(Number.isInteger(frameId) ? { frameId } : {}),
      };
      if (sender.origin === origin) return extensionPage(sender, ids);
      // 其余带标签页的是网页里的内容脚本。来源只和扩展自己的比，不看是哪个网站。
      if (typeof sender.origin === "string" && ids.tabId !== undefined) return { kind: "content", ...ids };
      return null;
    },
    resolveSite(ctx, sender) {
      if (ctx.kind !== "content") return null;
      const url = sender.tab?.url ?? sender.url;
      if (typeof url !== "string") return null;
      for (const rule of rules) {
        const video = rule.parseWatchUrl(url);
        if (video && video.platform === rule.platform) return { ...ctx, kind: "content", site: rule.platform, video };
      }
      return null;
    },
  };
}
