// 字幕翻译和整理字幕：经长连接发起，后台每做完一批推过来。只收和眼下这版字幕指纹一致的结果；
// 换了视频或字幕版本就关掉连接、清空结果，关连接只退订自己，别的页面接着的照常跑。
// 两样走同一个端口、同一套状态，整理字幕只是多带一个 purpose。点了就在后台做完，关掉侧边栏不停；
// 打开视频时先取本机存着的，同一份还在后台跑的就接上它的进度。
import { signal, type ReadonlySignal } from "@preact/signals";
import { describe } from "../../core/errors.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { TranscriptMode } from "../../shared/messages/transcript.ts";
import type { TextPurpose, TranslateOut } from "../../shared/messages/translate.ts";
import type { PagePort, PageApi } from "../shared/api.ts";
import type { UiLang } from "../shared/ui-lang.ts";
import { panelTextOf } from "./text.ts";

export interface TranslateState {
  readonly phase: "idle" | "running" | "done" | "failed";
  readonly done: number;
  readonly total: number;
  /** 给用户看的一句：失败原因，或者部分批次没译成。 */
  readonly message: string;
  /** 失败时模型服务自己说的话，显示在那一句下面，默认收着。 */
  readonly said?: string;
}

/** 此时主动选择译文或双语会尝试补译。 */
export function canStartTranslation(state: TranslateState): boolean {
  return state.phase === "idle" || state.phase === "failed" || state.message !== "";
}

export interface Translation {
  readonly mode: ReadonlySignal<TranscriptMode>;
  readonly state: ReadonlySignal<TranslateState>;
  /** 分段编号 → 译文。 */
  readonly lines: ReadonlySignal<Readonly<Record<string, string>>>;
  /** 换了视频或字幕版本：之前的译文全部作废，再取本机存着的、接上后台在跑的。tabId 是视频所在的标签页。 */
  bind(video: VideoKey | null, fingerprint: string | null, tabId?: number | null): void;
  /** 切到译文或双语时，没译过就从这一秒往后开始译。 */
  setMode(mode: TranscriptMode, fromSec?: number): void;
  stopRunning(): void;
  stop(): void;
}

/** 整理字幕：补标点、改同音错字。只在用户点按钮时做。 */
export interface Tidy {
  readonly state: ReadonlySignal<TranslateState>;
  /** 分段编号 → 整理后的原文。 */
  readonly lines: ReadonlySignal<Readonly<Record<string, string>>>;
  /** 有整理结果时显示整理后的；用户可以切回原始字幕。 */
  readonly show: ReadonlySignal<boolean>;
  bind(video: VideoKey | null, fingerprint: string | null, tabId?: number | null): void;
  /** 点「整理字幕」：本机存着的直接用，缺的从这一秒往后先整理。 */
  start(fromSec?: number): void;
  setShow(show: boolean): void;
  stopRunning(): void;
  stop(): void;
}

const IDLE: TranslateState = { phase: "idle", done: 0, total: 0, message: "" };

interface StreamWords {
  readonly unfinished: (batches: number) => string;
  readonly stopped: string;
}

const translateWords = (lang: UiLang): StreamWords => {
  const t = panelTextOf(lang).transcript;
  return { unfinished: t.translateUnfinished, stopped: t.translateStopped };
};
const tidyWords = (lang: UiLang): StreamWords => {
  const t = panelTextOf(lang).transcript;
  return { unfinished: t.tidyUnfinished, stopped: t.tidyStopped };
};

/** 一条结果流：连端口、收批次、记状态。翻译和整理字幕各开一条。 */
function createStream(api: Pick<PageApi, "connect">, purpose: TextPurpose | undefined, wordsOf: (lang: UiLang) => StreamWords, lang: () => UiLang) {
  const state = signal<TranslateState>(IDLE);
  const lines = signal<Readonly<Record<string, string>>>({});
  let bound: { readonly video: VideoKey; readonly fingerprint: string; readonly tabId: number | null } | null = null;
  let port: PagePort<"translate"> | null = null;
  // 只取本机存着的那一次：不显示进度，取完也不留「完成」的说明。
  let quiet = false;
  // 只取存着的那一下还没回来时用户点了开始：取完以后接着发起。null 是没点，数字或 undefined 是点了。
  let queued: { readonly fromSec: number | undefined } | null = null;

  /** 只取存着的那一下结束了：关掉端口，用户这期间点过开始就接着发起。 */
  function endQuiet(): void {
    quiet = false;
    closePort();
    const waiting = queued;
    queued = null;
    if (waiting) start(waiting.fromSec);
  }

  const closePort = (): void => {
    port?.close();
    port = null;
  };

  function onEvent(event: TranslateOut | { readonly type: "port.error"; readonly code: Parameters<typeof describe>[0] }): void {
    switch (event.type) {
      case "translate.started":
        // 取本机存着的时候碰上后台在跑：接上了，从这里起照常显示进度；这期间用户点的开始不用再发。
        quiet = false;
        queued = null;
        state.value = { phase: "running", done: 0, total: event.pending, message: "" };
        return;
      case "translate.segments":
        if (event.fingerprint !== bound?.fingerprint) return;
        lines.value = { ...lines.peek(), ...event.translated };
        if (!event.stored) {
          const now = state.peek();
          state.value = { ...now, done: Math.min(now.total, now.done + Object.keys(event.translated).length) };
        }
        return;
      case "translate.done": {
        if (quiet) return endQuiet();
        const failed = event.state === "failed";
        const words = wordsOf(lang());
        const message = event.failure
          ? describe(event.failure.code, event.failure.detail, lang())
          : event.failedBatches > 0
            ? words.unfinished(event.failedBatches)
            : event.state === "canceled"
              ? words.stopped
              : "";
        const { said: _said, ...rest } = state.peek();
        state.value = { ...rest, phase: failed ? "failed" : "done", message, ...(event.failure?.said ? { said: event.failure.said } : {}) };
        closePort();
        return;
      }
      case "translate.refused":
        if (quiet) return endQuiet();
        state.value = { ...IDLE, phase: "failed", message: describe(event.failure.code, event.failure.detail, lang()), ...(event.failure.said ? { said: event.failure.said } : {}) };
        closePort();
        return;
      case "port.error":
        state.value = { ...state.peek(), phase: "failed", message: describe(event.code, undefined, lang()) };
        return;
    }
  }


  function open(extra: { readonly fromSec?: number; readonly storedOnly?: true }): void {
    if (!bound) return;
    const video = bound.video;
    const opened = api.connect("translate", {
      onEvent,
      onClose(code) {
        if (port !== opened) return;
        port = null;
        if (state.peek().phase === "running") state.value = { ...state.peek(), phase: "failed", message: describe(code, undefined, lang()) };
      },
    });
    port = opened;
    const tabId = bound.tabId;
    opened.post({ type: "translate.start", video, ...extra, ...(purpose ? { purpose } : {}), ...(tabId !== null ? { tabId } : {}) });
  }

  function start(fromSec?: number): void {
    if (!bound) return;
    if (port?.isOpen()) {
      // 只取存着的那一下还没回来：记下，取完接着发起；已经在跑的不用再发。
      if (quiet) queued = { fromSec };
      return;
    }
    quiet = false;
    state.value = { ...IDLE, phase: "running" };
    open(fromSec !== undefined && fromSec > 0 ? { fromSec: Math.floor(fromSec) } : {});
  }

  return {
    state,
    lines,
    start,
    /** 取本机已经存着的结果，不请求模型；同一份正在后台跑就接上。 */
    peek(): void {
      if (!bound || port?.isOpen()) return;
      quiet = true;
      open({ storedOnly: true });
    },
    /** 回 true 表示换了视频或字幕版本。 */
    bind(video: VideoKey | null, fingerprint: string | null, tabId: number | null = null): boolean {
      const next = video && fingerprint ? { video, fingerprint, tabId } : null;
      if (next?.video === bound?.video && next?.fingerprint === bound?.fingerprint) {
        // 同一个视频开在两个标签页里，切过来时记下现在这个标签页，之后发起的算它的。
        if (bound && next && bound.tabId !== next.tabId) bound = next;
        return false;
      }
      closePort();
      queued = null;
      bound = next;
      lines.value = {};
      state.value = IDLE;
      return true;
    },
    stopRunning(): void {
      if (port?.isOpen()) port.post({ type: "translate.stop" });
    },
    stop: closePort,
  };
}

export function createTranslation({ api, lang = () => "zh" }: { readonly api: Pick<PageApi, "connect" | "send">; readonly lang?: () => UiLang }): Translation {
  let boundVideo: VideoKey | null = null;
  let choiceVersion = 0;
  const mode = signal<TranscriptMode>("original");
  const stream = createStream(api, undefined, translateWords, lang);
  return {
    mode,
    state: stream.state,
    lines: stream.lines,
    bind(video, fingerprint, tabId) {
      if (!stream.bind(video, fingerprint, tabId ?? null)) return;
      if (video !== boundVideo) {
        boundVideo = video;
        const version = ++choiceVersion;
        mode.value = "original";
        if (video) void api.send("transcript.displayMode", { video }).then((reply) => {
          // 换过视频或用户已经改选，迟到的回复就丢掉；恢复只改变显示。
          if (reply.ok && choiceVersion === version) mode.value = reply.value.mode;
        });
      }
      stream.peek();
    },
    setMode(next, fromSec) {
      choiceVersion++;
      mode.value = next;
      if (boundVideo) void api.send("transcript.displayMode", { video: boundVideo, mode: next });
      if (next !== "original" && canStartTranslation(stream.state.peek())) stream.start(fromSec);
    },
    stopRunning: stream.stopRunning,
    stop: stream.stop,
  };
}

export function createTidy({ api, lang = () => "zh" }: { readonly api: Pick<PageApi, "connect">; readonly lang?: () => UiLang }): Tidy {
  const show = signal(true);
  const stream = createStream(api, "tidy", tidyWords, lang);
  return {
    state: stream.state,
    lines: stream.lines,
    show,
    bind(video, fingerprint, tabId) {
      if (!stream.bind(video, fingerprint, tabId ?? null)) return;
      show.value = true;
      // 之前整理过的这一版字幕：打开就用上，不花钱。
      stream.peek();
    },
    start(fromSec) {
      show.value = true;
      stream.start(fromSec);
    },
    setShow(next) {
      show.value = next;
    },
    stopRunning: stream.stopRunning,
    stop: stream.stop,
  };
}
