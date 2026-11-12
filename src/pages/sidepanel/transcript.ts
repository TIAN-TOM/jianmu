// 字幕页签的数据：按当前视频取字幕、换语言、刷新，导入和移除自己的字幕文件。
// 每次读取记一个代数，换了视频或又读了一次，旧的回复作废，不串到新视频上。
import { signal, type ReadonlySignal } from "@preact/signals";
import { describe } from "../../core/errors.ts";
import { EXTENSIONS, MAX_FILE_BYTES } from "../../core/transcript/import-file.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { TranscriptFailure, TranscriptView } from "../../shared/messages/transcript.ts";
import type { PageApi } from "../shared/api.ts";

export type TranscriptState =
  | { readonly state: "idle" }
  | { readonly state: "loading"; readonly video: VideoKey }
  | { readonly state: "ready"; readonly video: VideoKey; readonly view: TranscriptView }
  | { readonly state: "failed"; readonly video: VideoKey; readonly failure: TranscriptFailure };

export interface LoadOptions {
  readonly lang?: string;
  readonly fresh?: boolean;
}

export interface TranscriptStore {
  readonly state: ReadonlySignal<TranscriptState>;
  /** 正在导入或移除字幕文件。 */
  readonly busy: ReadonlySignal<boolean>;
  load(video: VideoKey, tabId: number | null, options?: LoadOptions): Promise<void>;
  /** 回到没有视频的样子。 */
  clear(): void;
  /** 回一句给用户看的结果。 */
  importFile(file: File): Promise<string>;
  removeImport(): Promise<string>;
}

const IDLE: TranscriptState = { state: "idle" };

/** 读文件之前先拦一道：扩展名和大小。 */
export function fileProblem(name: string, size: number): string | null {
  const lower = name.toLowerCase();
  if (!EXTENSIONS.some((ext) => lower.endsWith(ext))) return describe("UNSUPPORTED_FILE");
  if (size > MAX_FILE_BYTES) return describe("UNSUPPORTED_FILE", "FILE_TOO_LARGE");
  if (size === 0) return describe("UNSUPPORTED_FILE", "EMPTY_FILE");
  return null;
}

export function createTranscriptStore({ api }: { readonly api: Pick<PageApi, "send"> }): TranscriptStore {
  const state = signal<TranscriptState>(IDLE);
  const busy = signal(false);
  let generation = 0;
  let lastTab: number | null = null;

  async function load(video: VideoKey, tabId: number | null, options: LoadOptions = {}): Promise<void> {
    generation += 1;
    const asked = generation;
    lastTab = tabId;
    state.value = { state: "loading", video };
    const reply = await api.send("transcript.get", {
      video,
      mode: "full",
      ...(options.lang ? { lang: options.lang } : {}),
      ...(options.fresh ? { fresh: true } : {}),
      ...(tabId !== null ? { tabId } : {}),
    });
    if (asked !== generation) return;
    if (reply.ok && !("mode" in reply.value)) {
      state.value = { state: "ready", video, view: reply.value };
    } else if (!reply.ok) {
      state.value = { state: "failed", video, failure: reply as TranscriptFailure };
    } else {
      state.value = { state: "failed", video, failure: { ok: false, code: "BACKGROUND_FAILED" } };
    }
  }

  const videoNow = (): VideoKey | null => {
    const now = state.peek();
    return now.state === "idle" ? null : now.video;
  };

  async function change(work: (video: VideoKey) => Promise<string | null>): Promise<string> {
    const video = videoNow();
    if (!video || busy.peek()) return "";
    busy.value = true;
    try {
      const problem = await work(video);
      if (problem !== null) return problem;
      // 导入和移除只作废了缓存里的字幕，重新读一次。还是这个视频才读。
      if (videoNow() === video) await load(video, lastTab);
      return "";
    } finally {
      busy.value = false;
    }
  }

  return {
    state,
    busy,
    load,
    clear() {
      generation += 1;
      state.value = IDLE;
    },
    async importFile(file) {
      const problem = fileProblem(file.name, file.size);
      if (problem) return problem;
      let fileName = "";
      const failure = await change(async (video) => {
        const text = await file.text();
        const reply = await api.send("imports.add", { video, fileName: file.name, text });
        if (!reply.ok) return describe(reply.code, reply.detail);
        fileName = reply.value.fileName;
        return null;
      });
      return failure || (fileName ? `已导入 ${fileName}，只存在这台电脑上` : "");
    },
    async removeImport() {
      let removed = false;
      const failure = await change(async (video) => {
        const reply = await api.send("imports.remove", { video });
        removed = reply.ok;
        return reply.ok ? null : describe(reply.code, reply.detail);
      });
      return failure || (removed ? "已换回视频网站的字幕" : "");
    },
  };
}
