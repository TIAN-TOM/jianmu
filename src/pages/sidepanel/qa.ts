// 问答页签和划词解释的数据。提问和解释都先登记任务（问题、选区随登记交），再凭任务号开始。
// 回答回来时页面已经换了视频，就不放进眼下的列表：后台照样存进发问那个视频的历史，回去时读得到。
import { signal, type ReadonlySignal } from "@preact/signals";
import { describe } from "../../core/errors.ts";
import type { QaRecord } from "../../core/notes/records.ts";
import type { TaskView } from "../../core/tasks.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { PageApi } from "../shared/api.ts";

export interface QaState {
  readonly video: VideoKey | null;
  readonly loaded: boolean;
  /** 新的在前。 */
  readonly entries: readonly QaRecord[];
  /** 还在回答的问题，含重开面板时接上的。 */
  readonly pending: readonly { readonly taskId: string; readonly question: string }[];
  readonly error: string;
  /** 刚回答的这条没存进历史。 */
  readonly unsavedId: string | null;
}

export interface ExplainState {
  readonly phase: "idle" | "running" | "done" | "failed";
  readonly selection: string;
  readonly text: string;
}

export interface QaStore {
  readonly state: ReadonlySignal<QaState>;
  readonly explain: ReadonlySignal<ExplainState>;
  bind(video: VideoKey | null): void;
  ask(question: string): Promise<void>;
  remove(id: string): Promise<void>;
  explainSelection(selection: string, context: string): Promise<void>;
  closeExplain(): void;
  stop(): void;
}

const EXPLAIN_IDLE: ExplainState = { phase: "idle", selection: "", text: "" };

export function createQaStore({ api }: { readonly api: Pick<PageApi, "send" | "on"> }): QaStore {
  const state = signal<QaState>({ video: null, loaded: false, entries: [], pending: [], error: "", unsavedId: null });
  const explain = signal<ExplainState>(EXPLAIN_IDLE);
  let generation = 0;
  let explainGeneration = 0;
  let offs: (() => void)[] = [];

  const patch = (asked: number, next: Partial<QaState>): void => {
    if (asked === generation) state.value = { ...state.peek(), ...next };
  };
  const dropPending = (asked: number, taskId: string): void => patch(asked, { pending: state.peek().pending.filter((item) => item.taskId !== taskId) });

  async function reload(asked: number, video: VideoKey): Promise<void> {
    const reply = await api.send("qa.history", { video });
    if (!reply.ok) return patch(asked, { loaded: true, error: describe(reply.code, reply.detail) });
    patch(asked, { loaded: true, entries: [...reply.value.entries].sort((a, b) => b.createdAt - a.createdAt) });
  }

  // 别处发起的、或者面板关掉前没等到的回答：收尾后重读历史。
  function onTask(asked: number, video: VideoKey, task: TaskView): void {
    if (task.kind !== "qa" || task.state === "running") return;
    if (!state.peek().pending.some((item) => item.taskId === task.id)) return;
    dropPending(asked, task.id);
    if (task.state === "failed") patch(asked, { error: task.message || "没能回答这个问题。" });
    void reload(asked, video);
  }

  async function attach(asked: number, video: VideoKey): Promise<void> {
    const reply = await api.send("task.list", {});
    if (!reply.ok) return;
    const running = reply.value.tasks.filter((task) => task.kind === "qa" && task.video === video && task.state === "running");
    const known = new Set(state.peek().pending.map((item) => item.taskId));
    const extra = running.filter((task) => !known.has(task.id)).map((task) => ({ taskId: task.id, question: task.message || "正在回答一个问题" }));
    if (extra.length) patch(asked, { pending: [...state.peek().pending, ...extra] });
  }

  return {
    state,
    explain,
    bind(video) {
      if (video === state.peek().video) return;
      generation += 1;
      const asked = generation;
      for (const off of offs) off();
      offs = [];
      state.value = { video, loaded: false, entries: [], pending: [], error: "", unsavedId: null };
      explainGeneration += 1;
      explain.value = EXPLAIN_IDLE;
      if (!video) return;
      offs = [api.on("task.changed", ({ task }) => onTask(asked, video, task), { video })];
      void reload(asked, video);
      void attach(asked, video);
    },
    async ask(raw) {
      const question = raw.trim();
      const asked = generation;
      const video = state.peek().video;
      if (!video || !question) return;
      patch(asked, { error: "" });
      const started = await api.send("task.start", { kind: "qa", video, question });
      if (!started.ok) return patch(asked, { error: describe(started.code, started.detail) });
      const taskId = started.value.task.id;
      if (!state.peek().pending.some((item) => item.taskId === taskId)) patch(asked, { pending: [...state.peek().pending, { taskId, question }] });
      const reply = await api.send("qa.ask", { video, taskId });
      if (asked !== generation) return;
      dropPending(asked, taskId);
      if (!reply.ok) {
        if (reply.code !== "TASK_CANCELED") patch(asked, { error: describe(reply.code, reply.detail) });
        return;
      }
      const { entry, historySaved } = reply.value;
      const entries = [entry, ...state.peek().entries.filter((item) => item.id !== entry.id)];
      patch(asked, { entries, unsavedId: historySaved === false ? entry.id : null });
    },
    async remove(id) {
      const asked = generation;
      const reply = await api.send("qa.delete", { id });
      if (!reply.ok) return patch(asked, { error: describe(reply.code, reply.detail) });
      patch(asked, { entries: state.peek().entries.filter((item) => item.id !== id) });
    },
    async explainSelection(raw, context) {
      const selection = raw.trim();
      const video = state.peek().video;
      if (!video || !selection) return;
      explainGeneration += 1;
      const mine = explainGeneration;
      explain.value = { phase: "running", selection, text: "" };
      const started = await api.send("task.start", { kind: "explain", video, selection, ...(context.trim() ? { context: context.trim() } : {}) });
      if (mine !== explainGeneration) return;
      if (!started.ok) {
        explain.value = { phase: "failed", selection, text: describe(started.code, started.detail) };
        return;
      }
      const reply = await api.send("explain.selection", { video, taskId: started.value.task.id });
      if (mine !== explainGeneration) return;
      explain.value = reply.ok ? { phase: "done", selection, text: reply.value.explanation } : { phase: "failed", selection, text: describe(reply.code, reply.detail) };
    },
    closeExplain() {
      explainGeneration += 1;
      explain.value = EXPLAIN_IDLE;
    },
    stop() {
      generation += 1;
      explainGeneration += 1;
      for (const off of offs) off();
      offs = [];
    },
  };
}
