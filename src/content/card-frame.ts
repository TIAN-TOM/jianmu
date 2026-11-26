// 播放页右栏的卡片：一个 iframe，里面是扩展自己的卡片页，网页脚本碰不到卡片里的内容和按钮。
// 插在适配器给的位置，右栏都找不到时悬浮在右下角；定期核对位置（宽屏时挪到弹幕列表下面），换视频时只发一句提醒，不改地址。
// 卡片的明暗跟着周围的页面：插入时写在地址的 # 后面，卡片第一帧就对；之后页面换了明暗，发一句消息告诉它。
import { CARD_TONE, INJECTED } from "../shared/names.ts";
import type { PageTone } from "./page-tone.ts";
import { contentText } from "./text.ts";

export interface CardSlot {
  readonly parent: Element;
  readonly before: Node | null;
}

export interface CardFrameDeps {
  readonly document: Document;
  /** 卡片页的完整地址；扩展断了联系时是 null。 */
  readonly cardUrl: () => string | null;
  /** 扩展的根地址。卡片页只能从每次会话都变的地址加载，但它自己的来源仍是扩展的来源，核对消息按这个。 */
  readonly extensionRoot: () => string | null;
  readonly slot: () => CardSlot | null;
  /** 播放器正占满屏幕：页面临时改了右栏，这期间不挪卡片。 */
  readonly fillsScreen: () => boolean;
  /** 卡片周围的页面是浅色还是深色，认不出时是 null。不给就不管明暗，卡片按设置来。 */
  readonly tone?: () => PageTone | null;
  /** 框架的名字（读屏读的那个），跟着界面语言；不给时用中文。 */
  readonly title?: () => string;
}

export interface CardFrame {
  /** 定时自查时调：没插就插，被摘掉了补回去，位置不对就挪。 */
  readonly ensure: () => void;
  /** 换了视频，提醒卡片按标签页的地址重新核对。 */
  readonly videoChanged: () => void;
  readonly remove: () => void;
}

// 收起时只剩标题栏，载入前先按这个高度占位；之后卡片自己报高度，这里只夹一道上下限。
export const CARD_HEIGHT = { initial: 48, min: 48, max: 720 } as const;
const DOCKED_STYLE = "display:block;width:100%;border:0;margin:0 0 12px;background:transparent;";
const FLOATING_STYLE = `display:block;position:fixed;right:16px;bottom:16px;width:340px;max-width:calc(100vw - 32px);border:0;
  border-radius:12px;z-index:1000;background:transparent;box-shadow:0 6px 24px rgba(0,0,0,.18);`;
// 在右栏里时每隔几轮才全面核对一次位置：核对要读弹幕列表的计算样式。
const FULL_CHECK_TICKS = 5;

/** 扩展页面地址的来源部分：只取到主机为止，不经 URL 解析，非标准协议在规范里是不透明来源。 */
export function extensionOrigin(url: string): string {
  return /^[a-z-]+:\/\/[^/]+/i.exec(url)?.[0] ?? "";
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null;

export function createCardFrame({ document, cardUrl, extensionRoot, slot, fillsScreen, tone, title = () => contentText().cardTitle }: CardFrameDeps): CardFrame {
  const view = document.defaultView;
  let frame: HTMLIFrameElement | null = null;
  let origin = "";
  let floating = false;
  let skipped = 0;
  // 写在卡片地址上的明暗，和卡片现在知道的明暗。卡片报过高度才算在听：在那之前发的消息它收不到。
  let urlTone: PageTone | null = null;
  let told: PageTone | null = null;
  let listening = false;

  const readTone = (): PageTone | null => {
    try {
      return tone?.() ?? null;
    } catch {
      return null;
    }
  };

  // 页面换了明暗，或者插入时还认不出：告诉卡片。认不出时不发，卡片留着原来的样子。
  function syncTone(): void {
    if (!frame || !listening) return;
    const now = readTone();
    if (!now || now === told) return;
    try {
      frame.contentWindow?.postMessage({ source: INJECTED.hostMessage, type: CARD_TONE.message, tone: now }, origin);
      told = now;
    } catch {
      // 发不出去：下一轮自查再试。
    }
  }

  const inPlace = (node: HTMLIFrameElement, target: CardSlot): boolean =>
    node.parentElement === target.parent && (target.before === node || node.nextSibling === target.before);

  function needsMove(node: HTMLIFrameElement, target: CardSlot | null): boolean {
    if (!target) return false;
    if (floating) return true;
    return !fillsScreen() && !inPlace(node, target);
  }

  function place(node: HTMLIFrameElement, target: CardSlot | null): boolean {
    if (target) {
      node.style.cssText = DOCKED_STYLE;
      target.parent.insertBefore(node, target.before);
    } else {
      if (!document.body) return false;
      node.style.cssText = FLOATING_STYLE;
      document.body.appendChild(node);
    }
    node.style.height = `${CARD_HEIGHT.initial}px`;
    floating = !target;
    // 挪位置会让框架按原来的地址重新载入：卡片回到地址上写的明暗，等它再报高度才接着听。
    told = urlTone;
    listening = false;
    return true;
  }

  // 卡片只会报自己的高度。来源必须是插进去的那个框架、来自扩展自己，网页脚本伪造不了这两样。
  const onMessage = (event: MessageEvent): void => {
    if (!frame || event.source !== frame.contentWindow || event.origin !== origin) return;
    const data: unknown = event.data;
    if (!isRecord(data) || data.source !== INJECTED.cardMessage || data.type !== "resize") return;
    listening = true;
    syncTone();
    const height = Number(data.height);
    if (!Number.isFinite(height)) return;
    frame.style.height = `${Math.min(CARD_HEIGHT.max, Math.max(CARD_HEIGHT.min, Math.ceil(height)))}px`;
  };
  view?.addEventListener("message", onMessage);

  function insert(): void {
    const url = cardUrl();
    const root = extensionRoot();
    if (!url || !root) return;
    const node = document.createElement("iframe");
    node.id = INJECTED.cardFrame;
    node.title = title();
    urlTone = readTone();
    node.src = urlTone ? `${url}#${CARD_TONE.param}=${urlTone}` : url;
    if (!place(node, slot())) return;
    frame = node;
    origin = extensionOrigin(root);
    skipped = 0;
  }

  return {
    ensure() {
      if (!frame?.isConnected) {
        frame?.remove();
        frame = null;
        insert();
        return;
      }
      // 界面语言变了：名字跟着换，不动地址，框架不重载。
      const name = title();
      if (frame.title !== name) frame.title = name;
      if (!floating && skipped < FULL_CHECK_TICKS - 1) {
        skipped += 1;
        return;
      }
      skipped = 0;
      syncTone();
      const target = slot();
      if (!needsMove(frame, target)) return;
      // 换位置时框架会整页重载，所以只在悬浮着而右栏出现了、或者不在该在的那一侧时才挪。
      place(frame, target);
    },
    videoChanged() {
      // 不改框架地址：那是一次导航，会给标签页的历史多压一条，后退键只退卡片。
      try {
        frame?.contentWindow?.postMessage({ source: INJECTED.hostMessage, type: "recheck" }, origin);
      } catch {
        // 卡片还没载入完：它启动时自己会读标签页地址。
      }
    },
    remove() {
      view?.removeEventListener("message", onMessage);
      frame?.remove();
      frame = null;
    },
  };
}
