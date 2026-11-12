// 字幕翻译：经长连接发起，后台每译完一批推过来。只收和眼下这版字幕指纹一致的译文；
// 换了视频或字幕版本就关掉连接、清空译文，关连接只退订自己，别的页面接着的翻译照常跑。
import { signal, type ReadonlySignal } from "@preact/signals";
import { describe } from "../../core/errors.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { TranslateOut } from "../../shared/messages/translate.ts";
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

const IDLE: TranslateState = { phase: "idle", done: 0, total: 0, message: "" };

export function createTranslation({ api }: { readonly api: Pick<PageApi, "connect"> }): Translation {
  const mode = signal<TranscriptMode>("original");
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
        const failed = event.state === "failed";
        const message = event.failure
          ? describe(event.failure.code, event.failure.detail)
          : event.failedBatches > 0
            ? `有 ${event.failedBatches} 批没译成，可以再切一次译文补上`
            : event.state === "canceled"
              ? "翻译已停止"
              : "";
        state.value = { ...state.peek(), phase: failed ? "failed" : "done", message };
        closePort();
        return;
      }
      case "translate.refused":
        state.value = { ...IDLE, phase: "failed", message: describe(event.failure.code, event.failure.detail) };
        closePort();
        return;
      case "port.error":
        state.value = { ...state.peek(), phase: "failed", message: describe(event.code) };
        return;
    }
  }

  function start(fromSec?: number): void {
    if (!bound || port?.isOpen()) return;
    const video = bound.video;
    state.value = { ...IDLE, phase: "running" };
    const opened = api.connect("translate", {
      onEvent,
      onClose(code) {
        if (port !== opened) return;
        port = null;
        if (state.peek().phase === "running") state.value = { ...state.peek(), phase: "failed", message: describe(code) };
      },
    });
    port = opened;
    opened.post({ type: "translate.start", video, ...(fromSec !== undefined && fromSec > 0 ? { fromSec: Math.floor(fromSec) } : {}) });
  }

  return {
    mode,
    state,
    lines,
    bind(video, fingerprint) {
      const next = video && fingerprint ? { video, fingerprint } : null;
      if (next?.video === bound?.video && next?.fingerprint === bound?.fingerprint) return;
      closePort();
      bound = next;
      lines.value = {};
      state.value = IDLE;
      mode.value = "original";
    },
    setMode(next, fromSec) {
      mode.value = next;
      const phase = state.peek().phase;
      if (next !== "original" && (phase === "idle" || phase === "failed" || state.peek().message !== "")) start(fromSec);
    },
    stopRunning() {
      if (port?.isOpen()) port.post({ type: "translate.stop" });
    },
    stop: closePort,
  };
}
