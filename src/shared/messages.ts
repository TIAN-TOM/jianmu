// 扩展内部的消息类型汇总：发送方、页面发给后台的消息、后台的广播、端口名。
// 各领域的请求和回复在 messages/ 下各一份，这里每个领域一行。
import type { ErrorCode, Result } from "../core/errors.ts";
import type { SessionView } from "../core/mode/types.ts";
import type { LearningAnalysis } from "../core/notes/markdown.ts";
import type { TaskView } from "../core/tasks.ts";
import type { VideoKey } from "../core/video-ref.ts";
import type { AiApi } from "./messages/ai.ts";
import type { BatchApi, BatchIn, BatchOut } from "./messages/batch.ts";
import type { CoreApi } from "./messages/core.ts";
import type { DataApi } from "./messages/data.ts";
import type { GrantsApi } from "./messages/grants.ts";
import type { ImportsApi } from "./messages/imports.ts";
import type { NotesApi } from "./messages/notes.ts";
import type { OverviewApi } from "./messages/overview.ts";
import type { QaApi } from "./messages/qa.ts";
import type { SessionApi } from "./messages/session.ts";
import type { TaskApi } from "./messages/tasks.ts";
import type { TranscriptApi } from "./messages/transcript.ts";
import type { TranslateIn, TranslateOut } from "./messages/translate.ts";
import type { AccentTheme } from "./settings-schema.ts";

/** 路由表按这几类放行。page 再按页面细分，内容脚本按站点细分。 */
export type SenderKind = "panel" | "page" | "card" | "content:bilibili" | "content:youtube";

/** 扩展页面里，路由能点名放行的几个。认不出的扩展页面一律不放行。 */
export type PageName = "options" | "triage";

export interface Api extends
  CoreApi,
  AiApi,
  TaskApi,
  SessionApi,
  GrantsApi,
  TranscriptApi,
  ImportsApi,
  OverviewApi,
  QaApi,
  NotesApi,
  DataApi,
  BatchApi {}

export type RouteName = keyof Api;

export type Envelope = { [K in RouteName]: { readonly type: K; readonly req: Api[K]["req"] } }[RouteName];

export type Reply<K extends RouteName> = Result<Api[K]["res"]>;

export type Broadcast =
  | { readonly type: "task.changed"; readonly task: TaskView }
  | { readonly type: "overview.preview"; readonly video: VideoKey; readonly taskId: string; readonly analysis: LearningAnalysis; readonly done: number; readonly total: number }
  | { readonly type: "overview.updated"; readonly video: VideoKey; readonly verdictPending: boolean }
  | { readonly type: "notes.changed"; readonly video?: VideoKey }
  | { readonly type: "session.changed"; readonly tabId: number; readonly session: SessionView }
  | { readonly type: "data.cleared"; readonly scope: "cache" | "all" }
  | { readonly type: "panel.follow"; readonly tabId: number }
  | { readonly type: "appearance.changed"; readonly accentTheme: AccentTheme; readonly inPageCard: boolean }
  | { readonly type: "activation.changed"; readonly confirmed: boolean };

export type BroadcastType = Broadcast["type"];

/** 页面和后台之间的长连接：翻译和批量处理。 */
export type PortName = "translate" | "batch";

/** 各端口两个方向的消息，由各领域在 messages/ 下定义后填进来。 */
export interface PortApi {
  translate: { readonly in: TranslateIn; readonly out: TranslateOut };
  batch: { readonly in: BatchIn; readonly out: BatchOut };
}

/** 后台在端口上回页面的通知：这条消息没收，或者启用失效、马上断开。 */
export interface PortNotice {
  readonly type: "port.error";
  readonly code: ErrorCode;
}

export type PortMessage<P extends PortName> = PortApi[P]["in"];
export type PortEvent<P extends PortName> = PortApi[P]["out"] | PortNotice;
