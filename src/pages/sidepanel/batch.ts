// 本窗口全部生成：概览页签顶上那一条。经长连接 batch 交给后台：先清点（只看本窗口标签页的地址和标题、本机概览），
// 用户确认后后台逐个生成，关掉侧边栏照常做完；重开时按窗口接上这一批，能全部停止、失败的单条重来、做完收起。
import { signal, type ReadonlySignal } from "@preact/signals";
import { describe, type ErrorCode } from "../../core/errors.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { PortEvent } from "../../shared/messages.ts";
import type { WindowCountItem, WindowEntryView, WindowRunView } from "../../shared/messages/batch.ts";
import type { PagePort, PageApi } from "../shared/api.ts";

export type BatchPhase =
  | { readonly phase: "idle" }
  | { readonly phase: "counting" }
  | { readonly phase: "confirm"; readonly items: readonly WindowCountItem[] }
  | { readonly phase: "active"; readonly run: WindowRunView };

export interface WindowBatchStore {
  readonly state: ReadonlySignal<BatchPhase>;
  /** 最近一次没做成的说明：AI 服务没设置好、已经有一批在跑、连接断了。 */
  readonly error: ReadonlySignal<string>;
  /** 启用以后连上后台，接上这个窗口已有的一批；没启用时断开、清空。 */
  setEnabled(enabled: boolean): void;
  count(): void;
  confirm(): void;
  /** 清点、确认时取消，做完以后收起。 */
  dismiss(): void;
  stopAll(): void;
  retry(video: VideoKey): void;
  stop(): void;
}

export interface WindowBatchDeps {
  readonly api: Pick<PageApi, "connect">;
  /** 侧边栏所在的窗口。 */
  readonly windowId?: () => Promise<number | null>;
}

const IDLE: BatchPhase = { phase: "idle" };

/** 去向是这几种的列在下面，可以单独重来。 */
export const RETRYABLE: ReadonlySet<WindowEntryView["status"]> = new Set(["failed", "canceled"]);

/** 确认前的说明：本窗口有几个视频、跳过几个、要新生成几个。 */
export function confirmText(items: readonly WindowCountItem[]): string {
  if (!items.length) return "本窗口没有打开的 B 站视频。";
  const existing = items.filter((item) => item.state === "existing").length;
  const running = items.filter((item) => item.state === "running").length;
  const todo = items.length - existing - running;
  const head = `本窗口有 ${items.length} 个视频`;
  const skipped = [existing ? `${existing} 个已有概览` : "", running ? `${running} 个正在生成` : ""].filter(Boolean);
  if (!todo) return `${head}，${skipped.join("、")}，没有要新生成的。`;
  const fresh = `要新生成 ${todo} 个。`;
  if (!skipped.length) return `${head}，${fresh}`;
  if (skipped.length === 1) return `${head}，跳过 ${skipped[0]}的，${fresh}`;
  return `${head}，跳过 ${existing + running} 个（${skipped.join("、")}），${fresh}`;
}

export interface Counts {
  readonly total: number;
  readonly pending: number;
  readonly running: number;
  readonly completed: number;
  readonly failed: number;
  readonly canceled: number;
  readonly skipped: number;
  /** 生成出来了，但有分块没成。 */
  readonly partial: number;
}

export function countsOf(run: WindowRunView): Counts {
  const of = (status: WindowEntryView["status"]): number => run.entries.filter((entry) => entry.status === status).length;
  return {
    total: run.entries.length,
    pending: of("pending"),
    running: of("running"),
    completed: of("completed"),
    failed: of("failed"),
    canceled: of("canceled"),
    skipped: of("skipped"),
    partial: run.entries.filter((entry) => entry.status === "completed" && entry.partial).length,
  };
}

/** 这一批还有没开始或者正在生成的。 */
export const busyOf = (run: WindowRunView): boolean => run.entries.some((entry) => entry.status === "pending" || entry.status === "running");

const STOP_TEXT: Readonly<Record<NonNullable<WindowRunView["stop"]>, string>> = {
  "rate-limited": "被 B 站限流，后面的没再读，过几分钟再单独重试。",
  "need-login": "B 站说要先登录，后面的没再读，登录后再单独重试。",
  source: "B 站回的内容读不懂，后面的没再读，过一阵再单独重试。",
};

/** 进度那一行。 */
export function progressText(run: WindowRunView): string {
  const counts = countsOf(run);
  const total = counts.total - counts.skipped;
  const parts = [`本窗口：已完成 ${counts.completed} / ${total}`];
  if (counts.partial) parts.push(`其中 ${counts.partial} 个不完整`);
  if (counts.failed) parts.push(`失败 ${counts.failed}`);
  if (counts.canceled) parts.push(`已停止 ${counts.canceled}`);
  if (counts.skipped) parts.push(`跳过 ${counts.skipped}`);
  const text = parts.join("，");
  return run.stop ? `${text}。${STOP_TEXT[run.stop]}` : text;
}

const realWindowId = (): Promise<number | null> => chrome.windows.getCurrent().then((win) => win.id ?? null, () => null);

export function createWindowBatch({ api, windowId: readWindowId = realWindowId }: WindowBatchDeps): WindowBatchStore {
  const state = signal<BatchPhase>(IDLE);
  const error = signal("");
  let port: PagePort<"batch"> | null = null;
  let windowId: number | null = null;
  let enabled = false;
  let generation = 0;

  function onEvent(event: PortEvent<"batch">): void {
    switch (event.type) {
      case "window.counted":
        if (event.windowId !== windowId || state.peek().phase !== "counting") return;
        state.value = { phase: "confirm", items: event.items };
        return;
      case "window.state":
        if (event.windowId !== windowId) return;
        if (event.run && event.run.entries.length > 0) state.value = { phase: "active", run: event.run };
        else if (state.peek().phase === "active") state.value = IDLE;
        return;
      case "window.refused":
        if (event.windowId !== windowId) return;
        error.value = describe(event.failure.code);
        if (state.peek().phase !== "active") state.value = IDLE;
        return;
      case "port.error":
        error.value = describe(event.code);
        return;
      default:
        // 粗筛的消息不归侧边栏。
        return;
    }
  }

  function onClose(code: ErrorCode): void {
    port = null;
    if (!enabled) return;
    // 后台被回收或重新加载：这一批在后台已经没了，界面回到能重新开始的样子。
    if (state.peek().phase !== "idle") error.value = `和后台的连接断了：${describe(code)}`;
    state.value = IDLE;
  }

  function send(message: Parameters<PagePort<"batch">["post"]>[0]): boolean {
    if (!port?.isOpen()) port = api.connect("batch", { onEvent, onClose });
    return port.post(message);
  }

  async function attach(): Promise<void> {
    generation += 1;
    const asked = generation;
    const id = await readWindowId();
    if (asked !== generation || !enabled || id === null) return;
    windowId = id;
    send({ type: "window.watch", windowId: id });
  }

  return {
    state,
    error,
    setEnabled(next) {
      if (next === enabled) return;
      enabled = next;
      if (next) {
        void attach();
        return;
      }
      generation += 1;
      port?.close();
      port = null;
      state.value = IDLE;
      error.value = "";
    },
    count() {
      const now = state.peek();
      if (windowId === null || now.phase === "counting" || now.phase === "confirm" || (now.phase === "active" && busyOf(now.run))) return;
      error.value = "";
      state.value = { phase: "counting" };
      if (!send({ type: "window.count", windowId })) state.value = IDLE;
    },
    confirm() {
      if (windowId === null || state.peek().phase !== "confirm") return;
      error.value = "";
      send({ type: "window.start", windowId });
    },
    dismiss() {
      const now = state.peek();
      if (windowId === null || (now.phase === "active" && busyOf(now.run))) return;
      state.value = IDLE;
      error.value = "";
      send({ type: "window.dismiss", windowId });
    },
    stopAll() {
      const now = state.peek();
      if (windowId === null || now.phase !== "active" || now.run.stopping) return;
      send({ type: "window.stop", windowId });
    },
    retry(video) {
      if (windowId === null) return;
      error.value = "";
      send({ type: "window.retry", windowId, video });
    },
    stop() {
      generation += 1;
      enabled = false;
      port?.close();
      port = null;
    },
  };
}
