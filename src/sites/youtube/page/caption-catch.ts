// 页面主世界里接住播放器自己取回的字幕：包住网页请求对象的打开和发出两步，只认播放器取字幕的那一种，回来时记下视频、语言、
// 是不是自动生成、是不是机器翻译和正文。只存内存、只留最近两份，不存地址和别的参数，不自己发请求，出了错也不碍页面自己的请求。
// 内容脚本带随机标记来问，交回这个视频最近的一份；新注入的一份顶替时停下，能还的把原来的函数还回去。
import { INJECTED } from "../../../shared/names.ts";
import { CAPTION_LIMITS, type PlayerCaption } from "./caption-types.ts";
import { LANG_CODE, VIDEO_ID } from "./panel-types.ts";

// 播放器取字幕的请求：同一个站点上路径以它结尾，带着视频编号和语言。
const CAPTION_PATH_END = "/timedtext";
const AUTO_KIND = "asr";
const TOKEN = /^[\w-]{8,64}$/;
const DONE = 4;
const OK_STATUS = 200;

type CaptionSource = Omit<PlayerCaption, "text">;

/** 网页的请求对象里用到的那几样。 */
interface PageRequest {
  readonly readyState: number;
  readonly status: number;
  readonly responseType: string;
  readonly responseText: string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

type Method = (this: PageRequest, ...args: unknown[]) => unknown;

interface RequestMethods {
  open: Method;
  send: Method;
}

export type CatchScope = typeof globalThis;

/** 这个请求地址是不是播放器取字幕的那一种；是的话认出视频、语言、是不是自动生成、是不是机器翻译和译成的语言。 */
export function captionSourceOf(address: string, origin: string): CaptionSource | null {
  let url: URL;
  try {
    url = new URL(address, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin || !url.pathname.endsWith(CAPTION_PATH_END)) return null;
  const query = url.searchParams;
  const videoId = query.get("v") ?? "";
  const lang = query.get("lang") ?? "";
  const target = query.get("tlang");
  if (!VIDEO_ID.test(videoId) || lang.length > 35 || !LANG_CODE.test(lang)) return null;
  if (target !== null && (target.length > 35 || !LANG_CODE.test(target))) return null;
  return { videoId, lang, auto: query.get("kind") === AUTO_KIND, translated: target !== null, targetLang: target ?? "" };
}

const addressOf = (value: unknown): string | null => (typeof value === "string" ? value : value instanceof URL ? value.href : null);

/** 开始接住播放器取回的字幕、回答内容脚本的问话，返回停下的函数。 */
export function startCaptionCatch(scope: CatchScope): () => void {
  const document = scope.document;
  const origin = scope.location.origin;
  const methods = scope.XMLHttpRequest.prototype as unknown as RequestMethods;
  const originalOpen = methods.open;
  const originalSend = methods.send;
  const kept: PlayerCaption[] = [];
  const sources = new WeakMap<PageRequest, CaptionSource>();
  let live = true;

  const keep = (request: PageRequest, source: CaptionSource): void => {
    try {
      if (!live || request.readyState !== DONE || request.status !== OK_STATUS) return;
      if (request.responseType !== "" && request.responseType !== "text") return;
      const text = request.responseText;
      if (typeof text !== "string" || text.length === 0 || text.length > CAPTION_LIMITS.text) return;
      kept.push({ ...source, text });
      if (kept.length > CAPTION_LIMITS.kept) kept.splice(0, kept.length - CAPTION_LIMITS.kept);
    } catch {
      // 读不到就当没接住。
    }
  };

  const open: Method = function (this: PageRequest, ...args: unknown[]) {
    try {
      const address = live ? addressOf(args[1]) : null;
      const source = address === null ? null : captionSourceOf(address, origin);
      if (source) sources.set(this, source);
      else sources.delete(this);
    } catch {
      // 认不出就当不是取字幕的请求。
    }
    return originalOpen.apply(this, args);
  };

  const send: Method = function (this: PageRequest, ...args: unknown[]) {
    try {
      const source = live ? sources.get(this) : undefined;
      if (source) {
        const request = this;
        const done = (): void => {
          request.removeEventListener("loadend", done);
          keep(request, source);
        };
        request.addEventListener("loadend", done);
      }
    } catch {
      // 挂不上就不接，页面的请求照常发。
    }
    return originalSend.apply(this, args);
  };

  methods.open = open;
  methods.send = send;

  const onAsk = (event: Event): void => {
    const detail: unknown = (event as CustomEvent<unknown>).detail;
    if (typeof detail !== "string" || detail.length > 200) return;
    let asked: unknown;
    try {
      asked = JSON.parse(detail);
    } catch {
      return;
    }
    const { token, videoId } = (typeof asked === "object" && asked !== null ? asked : {}) as { token?: unknown; videoId?: unknown };
    if (typeof token !== "string" || !TOKEN.test(token) || typeof videoId !== "string") return;
    const caption = kept.filter((item) => item.videoId === videoId).at(-1) ?? null;
    document.dispatchEvent(new CustomEvent(INJECTED.captionsAnswer, { detail: JSON.stringify({ token, caption }) }));
  };

  const stop = (): void => {
    live = false;
    kept.length = 0;
    // 别人又包了一层时还不回去：这时这一层只原样转过去。
    if (methods.open === open) methods.open = originalOpen;
    if (methods.send === send) methods.send = originalSend;
    document.removeEventListener(INJECTED.captionsAsk, onAsk);
    document.removeEventListener(INJECTED.bridgeRetire, stop);
  };
  document.addEventListener(INJECTED.captionsAsk, onAsk);
  document.addEventListener(INJECTED.bridgeRetire, stop);
  return stop;
}
