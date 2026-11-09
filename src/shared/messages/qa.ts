// 问答和划词解释的请求和回复。两种都要先经任务登记（问题、选中的文字随登记一起交），再凭任务号开始；
// 同一个问题连点两下接上同一个任务，不另花一次钱。
import type { QaRecord } from "../../core/notes/records.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { EmptyRequest } from "./core.ts";

export interface QaAskRequest {
  readonly video: VideoKey;
  readonly taskId: string;
}

export interface QaAnswerView {
  readonly entry: QaRecord;
  /** 送给模型的是整份字幕、筛出来的几段，还是只有每段开头。 */
  readonly retrievalMode: "full" | "selected" | "skeleton";
  /** 回答照常交回，但没存进问答历史。 */
  readonly historySaved?: false;
}

export interface QaHistoryRequest {
  readonly video: VideoKey;
}

export interface QaHistoryView {
  readonly entries: readonly QaRecord[];
}

export interface QaDeleteRequest {
  readonly id: string;
}

export interface ExplainRequest {
  readonly video: VideoKey;
  readonly taskId: string;
}

export interface ExplainView {
  readonly explanation: string;
  /** 模型输出被截断，正文末尾已经注明可能不完整。 */
  readonly truncated?: true;
}

export interface QaApi {
  "qa.ask": { req: QaAskRequest; res: QaAnswerView };
  "qa.history": { req: QaHistoryRequest; res: QaHistoryView };
  "qa.delete": { req: QaDeleteRequest; res: EmptyRequest };
  "explain.selection": { req: ExplainRequest; res: ExplainView };
}
