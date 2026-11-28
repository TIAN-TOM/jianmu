// 问答页签和划词解释的数据。提问和解释都先登记任务（问题、选区随登记交），再凭任务号开始。
// 回答回来时页面已经换了视频，就不放进眼下的列表：后台照样存进发问那个视频的历史，回去时读得到。
import { signal, type ReadonlySignal } from "@preact/signals";
import { describe, type ErrorCode } from "../../core/errors.ts";
import type { QaRecord } from "../../core/notes/records.ts";
import type { TaskView } from "../../core/tasks.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { PageApi } from "../shared/api.ts";
import type { UiLang } from "../shared/ui-lang.ts";
import { panelTextOf } from "./text.ts";

export interface QaState {
  readonly video: VideoKey | null;
  readonly loaded: boolean;
  /** 新的在前。 */
  readonly entries: readonly QaRecord[];
  /** 还在回答的问题，含重开面板时接上的。 */
  readonly pending: readonly { readonly taskId: string; readonly question: string }[];
  readonly error: string;
  /** 最近一次失败的错误码：要到设置页去改的，说明下面给「打开设置」。没有失败时是 null。 */
  readonly errorCode: ErrorCode | null;
  /** 回答失败时模型服务自己说的话，显示在说明下面，默认收着；没有时是空串。 */
  readonly errorSaid: string;
  /** 刚回答的这条没存进历史。 */
  readonly unsavedId: string | null;
}

export interface ExplainState {
  readonly phase: "idle" | "running" | "done" | "failed";
  readonly selection: string;
  readonly text: string;
  /** 解释失败时模型服务自己说的话。 */
  readonly said?: string;
}

export interface QaStore {
  readonly state: ReadonlySignal<QaState>;
  readonly explain: ReadonlySignal<ExplainState>;
  bind(video: VideoKey | null): void;
  /** 同一个视频换了标签页：重读问答历史，接上别处在答的问题，没存上的回答和在等的问题留着。 */
  refresh(): void;
  ask(question: string): Promise<void>;
  /** 删掉一条问答；删成了回 true，没删成时说明写在 error 里。 */
  remove(id: string): Promise<boolean>;
  explainSelection(selection: string, context: string): Promise<void>;
  closeExplain(): void;
  stop(): void;
}

const EXPLAIN_IDLE: ExplainState = { phase: "idle", selection: "", text: "" };

export function createQaStore({ api, lang }: { readonly api: Pick<PageApi, "send" | "on">; readonly lang: () => UiLang }): QaStore {
  const state = signal<QaState>({ video: null, loaded: false, entries: [], pending: [], error: "", errorCode: null, errorSaid: "", unsavedId: null });
  const explain = signal<ExplainState>(EXPLAIN_IDLE);
  let generation = 0;
  let explainGeneration = 0;
  let offs: (() => void)[] = [];
  /** 这个页面自己在等回复的问答任务：收尾广播不替它重读历史，免得没存上的回答被历史盖掉。 */
  const awaiting = new Set<string>();

  const patch = (asked: number, next: Partial<QaState>): void => {
    if (asked === generation) state.value = { ...state.peek(), ...next };
  };
  const dropPending = (asked: number, taskId: string): void => patch(asked, { pending: state.peek().pending.filter((item) => item.taskId !== taskId) });

  async function reload(asked: number, video: VideoKey): Promise<void> {
    const reply = await api.send("qa.history", { video });
    if (!reply.ok) return patch(asked, { loaded: true, error: describe(reply.code, reply.detail, lang()), errorCode: reply.code, errorSaid: "" });
    // 没存进历史的回答只在这一页上，重读历史时留着它。
    const { unsavedId, entries: shown } = state.peek();
    const unsaved = shown.filter((entry) => entry.id === unsavedId && !reply.value.entries.some((item) => item.id === entry.id));
    patch(asked, { loaded: true, entries: [...unsaved, ...reply.value.entries].sort((a, b) => b.createdAt - a.createdAt) });
  }

  // 别处发起的、或者面板关掉前没等到的回答：收尾后重读历史。
  function onTask(asked: number, video: VideoKey, task: TaskView): void {
    if (task.kind !== "qa" || task.state === "running" || awaiting.has(task.id)) return;
    if (!state.peek().pending.some((item) => item.taskId === task.id)) return;
    dropPending(asked, task.id);
    if (task.state === "failed") patch(asked, { error: task.message || panelTextOf(lang()).qa.failed, errorCode: null });
    void reload(asked, video);
  }

  async function attach(asked: number, video: VideoKey): Promise<void> {
    const reply = await api.send("task.list", {});
    if (!reply.ok) return;
    const running = reply.value.tasks.filter((task) => task.kind === "qa" && task.video === video && task.state === "running");
    const known = new Set(state.peek().pending.map((item) => item.taskId));
    const extra = running.filter((task) => !known.has(task.id)).map((task) => ({ taskId: task.id, question: task.message || panelTextOf(lang()).qa.pending }));
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
      state.value = { video, loaded: false, entries: [], pending: [], error: "", errorCode: null, errorSaid: "", unsavedId: null };
      explainGeneration += 1;
      explain.value = EXPLAIN_IDLE;
      if (!video) return;
      offs = [api.on("task.changed", ({ task }) => onTask(asked, video, task), { video })];
      void reload(asked, video);
      void attach(asked, video);
    },
    refresh() {
      const { video } = state.peek();
      if (!video) return;
      void reload(generation, video);
      void attach(generation, video);
    },
    async ask(raw) {
      const question = raw.trim();
      const asked = generation;
      const video = state.peek().video;
      if (!video || !question) return;
      patch(asked, { error: "", errorCode: null, errorSaid: "" });
      const started = await api.send("task.start", { kind: "qa", video, question });
      if (!started.ok) return patch(asked, { error: describe(started.code, started.detail, lang()), errorCode: started.code, errorSaid: started.said ?? "" });
      const taskId = started.value.task.id;
      if (!state.peek().pending.some((item) => item.taskId === taskId)) patch(asked, { pending: [...state.peek().pending, { taskId, question }] });
      awaiting.add(taskId);
      const reply = await api.send("qa.ask", { video, taskId }).finally(() => awaiting.delete(taskId));
      if (asked !== generation) return;
      dropPending(asked, taskId);
      if (!reply.ok) {
        if (reply.code !== "TASK_CANCELED") patch(asked, { error: describe(reply.code, reply.detail, lang()), errorCode: reply.code, errorSaid: reply.said ?? "" });
        return;
      }
      const { entry, historySaved } = reply.value;
      const entries = [entry, ...state.peek().entries.filter((item) => item.id !== entry.id)];
      patch(asked, { entries, unsavedId: historySaved === false ? entry.id : null });
    },
    async remove(id) {
      const asked = generation;
      const reply = await api.send("qa.delete", { id });
      if (!reply.ok) {
        patch(asked, { error: describe(reply.code, reply.detail, lang()), errorCode: reply.code, errorSaid: "" });
        return false;
      }
      patch(asked, { entries: state.peek().entries.filter((item) => item.id !== id) });
      return true;
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
        explain.value = { phase: "failed", selection, text: describe(started.code, started.detail, lang()), ...(started.said ? { said: started.said } : {}) };
        return;
      }
      const reply = await api.send("explain.selection", { video, taskId: started.value.task.id });
      if (mine !== explainGeneration) return;
      explain.value = reply.ok
        ? { phase: "done", selection, text: reply.value.explanation }
        : { phase: "failed", selection, text: describe(reply.code, reply.detail, lang()), ...(reply.said ? { said: reply.said } : {}) };
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
