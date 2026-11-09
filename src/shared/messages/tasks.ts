// 任务这几条消息的请求和回复：列出、登记、取消。
import type { TaskView } from "../../core/tasks.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { EmptyRequest } from "./core.ts";

/** 能经消息登记的种类：概览、用官方总结写结论、问答、划词解释。翻译和批次走端口，不经这里。 */
export type StartableTaskKind = "overview" | "verdict" | "qa" | "explain";

/** 问答和划词解释的输入随登记一起交：同一视频、同样的输入才算同一个任务。 */
export type TaskStartRequest =
  | { readonly kind: "overview" | "verdict"; readonly video: VideoKey }
  | { readonly kind: "qa"; readonly video: VideoKey; readonly question: string }
  | { readonly kind: "explain"; readonly video: VideoKey; readonly selection: string; readonly context?: string };

export interface TaskStartView {
  readonly task: TaskView;
  /** 接上了已经在跑的同一个任务，没有新起。 */
  readonly joined: boolean;
  /** 卡片新起的任务凭它开始生成，用一次就作废。 */
  readonly token?: string;
}

export interface TaskListView {
  readonly tasks: readonly TaskView[];
}

export interface TaskCancelRequest {
  readonly taskId: string;
}

export interface TaskCancelView {
  readonly task: TaskView;
}

export interface TaskApi {
  "task.list": { req: EmptyRequest; res: TaskListView };
  "task.start": { req: TaskStartRequest; res: TaskStartView };
  "task.cancel": { req: TaskCancelRequest; res: TaskCancelView };
}
