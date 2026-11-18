// 字幕翻译和整理字幕：经长连接发起，后台每做完一批推过来。只收和眼下这版字幕指纹一致的结果；
// 换了视频或字幕版本就关掉连接、清空结果，关连接只退订自己，别的页面接着的照常跑。
// 两样走同一个端口、同一套状态，整理字幕只是多带一个 purpose。
import { signal, type ReadonlySignal } from "@preact/signals";
import { describe } from "../../core/errors.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { TextPurpose, TranslateOut } from "../../shared/messages/translate.ts";
import type { PagePort, PageApi } from "../shared/api.ts";

export type TranscriptMode = "original" | "translated" | "bilingual";

export interface TranslateState {
  readonly phase: "idle" | "running" | "done" | "failed";
  readonly done: number;
  readonly total: number;
  /** 给用户看的一句：失败原因，或者部分批次没译成。 */
  readonly message: string;
}

export interface Translation {
  readonly mode: ReadonlySignal<TranscriptMode>;
  readonly state: ReadonlySignal<TranslateState>;
  /** 分段编号 → 译文。 */
  readonly lines: ReadonlySignal<Readonly<Record<string, string>>>;
  /** 换了视频或字幕版本：之前的译文全部作废。 */
  bind(video: VideoKey | null, fingerprint: string | null): void;
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
  bind(video: VideoKey | null, fingerprint: string | null): void;
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

const TRANSLATE_WORDS: StreamWords = { unfinished: (batches) => `有 ${batches} 批没译成，可以再切一次译文补上`, stopped: "翻译已停止" };
const TIDY_WORDS: StreamWords = { unfinished: (batches) => `有 ${batches} 批没整理完，可以再点一次补上`, stopped: "整理已停止" };

/** 一条结果流：连端口、收批次、记状态。翻译和整理字幕各开一条。 */
function createStream(api: Pick<PageApi, "connect">, purpose: TextPurpose | undefined, words: StreamWords) {
  const state = signal<TranslateState>(IDLE);
  const lines = signal<Readonly<Record<string, string>>>({});
  let bound: { readonly video: VideoKey; readonly fingerprint: string } | null = null;
  let port: PagePort<"translate"> | null = null;

  const closePort = (): void => {
    port?.close();
    port = null;
  };

  function onEvent(event: TranslateOut | { readonly type: "port.error"; readonly code: Parameters<typeof describe>[0] }): void {
    switch (event.type) {
      case "translate.started":
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
        if (quiet) {
          quiet = false;
          closePort();
          return;
        }
        const failed = event.state === "failed";
        const message = event.failure
          ? describe(event.failure.code, event.failure.detail)
          : event.failedBatches > 0
            ? words.unfinished(event.failedBatches)
            : event.state === "canceled"
              ? words.stopped
              : "";
        state.value = { ...state.peek(), phase: failed ? "failed" : "done", message };
        closePort();
        return;
      }
      case "translate.refused":
        if (quiet) {
          quiet = false;
          closePort();
          return;
        }
        state.value = { ...IDLE, phase: "failed", message: describe(event.failure.code, event.failure.detail) };
        closePort();
        return;
      case "port.error":
        state.value = { ...state.peek(), phase: "failed", message: describe(event.code) };
        return;
    }
  }

  // 只取本机存着的那一次：不显示进度，取完也不留「完成」的说明。
  let quiet = false;

  function open(extra: { readonly fromSec?: number; readonly storedOnly?: true }): void {
    if (!bound) return;
    const video = bound.video;
    const opened = api.connect("translate", {
      onEvent,
      onClose(code) {
        if (port !== opened) return;
        port = null;
        if (state.peek().phase === "running") state.value = { ...state.peek(), phase: "failed", message: describe(code) };
      },
    });
    port = opened;
    opened.post({ type: "translate.start", video, ...extra, ...(purpose ? { purpose } : {}) });
  }

  return {
    state,
    lines,
    start(fromSec?: number): void {
      if (!bound || port?.isOpen()) return;
      quiet = false;
      state.value = { ...IDLE, phase: "running" };
      open(fromSec !== undefined && fromSec > 0 ? { fromSec: Math.floor(fromSec) } : {});
    },
    /** 取本机已经存着的结果，不请求模型。 */
    peek(): void {
      if (!bound || port?.isOpen()) return;
      quiet = true;
      open({ storedOnly: true });
    },
    /** 回 true 表示换了视频或字幕版本。 */
    bind(video: VideoKey | null, fingerprint: string | null): boolean {
      const next = video && fingerprint ? { video, fingerprint } : null;
      if (next?.video === bound?.video && next?.fingerprint === bound?.fingerprint) return false;
      closePort();
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

export function createTranslation({ api }: { readonly api: Pick<PageApi, "connect"> }): Translation {
  const mode = signal<TranscriptMode>("original");
  const stream = createStream(api, undefined, TRANSLATE_WORDS);
  return {
    mode,
    state: stream.state,
    lines: stream.lines,
    bind(video, fingerprint) {
      if (stream.bind(video, fingerprint)) mode.value = "original";
    },
    setMode(next, fromSec) {
      mode.value = next;
      const now = stream.state.peek();
      if (next !== "original" && (now.phase === "idle" || now.phase === "failed" || now.message !== "")) stream.start(fromSec);
    },
    stopRunning: stream.stopRunning,
    stop: stream.stop,
  };
}

export function createTidy({ api }: { readonly api: Pick<PageApi, "connect"> }): Tidy {
  const show = signal(true);
  const stream = createStream(api, "tidy", TIDY_WORDS);
  return {
    state: stream.state,
    lines: stream.lines,
    show,
    bind(video, fingerprint) {
      if (!stream.bind(video, fingerprint)) return;
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
