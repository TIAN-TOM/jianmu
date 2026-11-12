// 概览页签的数据：本机已有的概览、正在跑的概览和结论任务、长视频边生成边显示的临时概览。
// 生成先登记任务再开始；重开面板时从任务表接上还在跑的，跟着任务广播收尾。换了视频，旧视频的回复和广播都不再进来。
import { signal, type ReadonlySignal } from "@preact/signals";
import { describe, type Failure } from "../../core/errors.ts";
import type { LearningAnalysis } from "../../core/notes/markdown.ts";
import type { TaskView } from "../../core/tasks.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { OverviewResultView } from "../../shared/messages/overview.ts";
import type { OverviewView } from "../../shared/messages/transcript.ts";
import type { PageApi } from "../shared/api.ts";

export interface Preview {
  readonly analysis: LearningAnalysis;
  readonly done: number;
  readonly total: number;
}

export interface OverviewState {
  readonly video: VideoKey | null;
  readonly loaded: boolean;
  readonly saved: OverviewView | null;
  /** 正在跑的概览任务（生成或补块）。 */
  readonly task: TaskView | null;
  readonly verdictTask: TaskView | null;
  readonly preview: Preview | null;
  /** 最近一次生成的附带说明：缺了几块、停在中途、没存上。 */
  readonly result: OverviewResultView | null;
  /** 最近一次失败的说明。 */
  readonly error: string;
}

export interface OverviewStore {
  readonly state: ReadonlySignal<OverviewState>;
  bind(video: VideoKey | null): void;
  generate(fresh: boolean): Promise<void>;
  retryFailed(): Promise<void>;
  verdictFromOfficial(): Promise<void>;
  /** 停掉概览任务或结论任务。 */
  cancel(taskId: string): Promise<void>;
  stop(): void;
}

const EMPTY: OverviewState = { video: null, loaded: false, saved: null, task: null, verdictTask: null, preview: null, result: null, error: "" };

const isRunning = (task: TaskView | null | undefined): task is TaskView => task?.state === "running";

/** 失败说明：用户点了停止不算失败。 */
function failureText(failure: Failure): string {
  return failure.code === "TASK_CANCELED" ? "" : describe(failure.code, failure.detail);
}

export function createOverviewStore({ api }: { readonly api: Pick<PageApi, "send" | "on"> }): OverviewStore {
  const state = signal<OverviewState>(EMPTY);
  let generation = 0;
  let offs: (() => void)[] = [];

  const patch = (asked: number, next: Partial<OverviewState>): void => {
    if (asked === generation) state.value = { ...state.peek(), ...next };
  };

  async function reload(asked: number, video: VideoKey): Promise<void> {
    const reply = await api.send("overview.get", { video });
    if (reply.ok) patch(asked, { saved: reply.value.overview ?? null, loaded: true });
    else patch(asked, { loaded: true, error: failureText(reply) });
  }

  // 任务收尾时（不管是不是这个页面发起的）重读本机的概览。
  function onTask(asked: number, video: VideoKey, task: TaskView): void {
    const now = state.peek();
    if (task.kind === "overview") {
      if (now.task?.id !== task.id && !isRunning(task)) return;
      patch(asked, { task: isRunning(task) ? task : null, ...(isRunning(task) ? {} : { preview: null }) });
    } else if (task.kind === "verdict") {
      if (now.verdictTask?.id !== task.id && !isRunning(task)) return;
      patch(asked, { verdictTask: isRunning(task) ? task : null });
    } else {
      return;
    }
    if (!isRunning(task)) void reload(asked, video);
  }

  async function attach(asked: number, video: VideoKey): Promise<void> {
    const reply = await api.send("task.list", {});
    if (!reply.ok || asked !== generation) return;
    const mine = reply.value.tasks.filter((task) => task.video === video && isRunning(task));
    const task = mine.find((item) => item.kind === "overview") ?? null;
    const verdictTask = mine.find((item) => item.kind === "verdict") ?? null;
    patch(asked, { ...(task ? { task } : {}), ...(verdictTask ? { verdictTask } : {}) });
  }

  // 登记任务，再交给 begin 开始；接上了别处在跑的同一个任务就只跟着广播，不再认领一次。
  async function run(kind: "overview" | "verdict", begin: (taskId: string, video: VideoKey) => Promise<{ ok: true; value: OverviewResultView } | Failure>): Promise<void> {
    const asked = generation;
    const video = state.peek().video;
    if (!video) return;
    const slot = kind === "overview" ? "task" : "verdictTask";
    if (isRunning(state.peek()[slot])) return;
    patch(asked, { error: "" });
    const started = await api.send("task.start", { kind, video });
    if (!started.ok) {
      patch(asked, { error: failureText(started) });
      return;
    }
    const { task, joined } = started.value;
    patch(asked, { [slot]: task });
    if (joined) return;
    const reply = await begin(task.id, video);
    if (asked !== generation) return;
    if (reply.ok) {
      patch(asked, { [slot]: null, preview: kind === "overview" ? null : state.peek().preview, result: reply.value, saved: { analysis: reply.value.analysis, analysisFailures: reply.value.analysisFailures } });
    } else {
      patch(asked, { [slot]: null, ...(kind === "overview" ? { preview: null } : {}), error: failureText(reply) });
      void reload(asked, video);
    }
  }

  return {
    state,
    bind(video) {
      if (video === state.peek().video) return;
      generation += 1;
      const asked = generation;
      for (const off of offs) off();
      offs = [];
      state.value = { ...EMPTY, video };
      if (!video) return;
      offs = [
        api.on("task.changed", ({ task }) => onTask(asked, video, task), { video }),
        api.on(
          "overview.preview",
          ({ analysis, done, total, taskId }) => {
            if (state.peek().task?.id === taskId) patch(asked, { preview: { analysis, done, total } });
          },
          { video },
        ),
        api.on("overview.updated", () => void reload(asked, video), { video }),
      ];
      void reload(asked, video);
      void attach(asked, video);
    },
    generate: (fresh) => run("overview", (taskId, video) => api.send("overview.start", { video, taskId, ...(fresh ? { fresh: true } : {}) })),
    retryFailed: () => run("overview", (taskId, video) => api.send("overview.retryFailed", { video, taskId })),
    verdictFromOfficial: () => run("verdict", (taskId, video) => api.send("verdict.fromOfficial", { video, taskId })),
    async cancel(taskId) {
      const reply = await api.send("task.cancel", { taskId });
      if (!reply.ok && reply.code !== "TASK_NOT_FOUND") state.value = { ...state.peek(), error: describe(reply.code, reply.detail) };
    },
    stop() {
      generation += 1;
      for (const off of offs) off();
      offs = [];
    },
  };
}
