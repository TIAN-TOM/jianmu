// 任务这几条消息的请求和回复：列出、登记、取消。
import type { TaskView } from "../../core/tasks.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { EmptyRequest } from "./core.ts";

/** 能经消息登记的种类。其余种类随各自的服务接上时再加；翻译和批次走端口，不经这里。 */
export type StartableTaskKind = "overview";

export interface TaskStartRequest {
  readonly kind: StartableTaskKind;
  readonly video: VideoKey;
}

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
