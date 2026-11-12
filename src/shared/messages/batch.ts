// 批次端口的消息：稍后再看粗筛和本窗口全部生成。
// 粗筛：页面连着端口发起读列表、取官方总结、写结论，后台逐个做，做完一个推一个给页面；
// 订阅的页面都断开了就不再开始新的条目，已经发出的请求照常收尾。观看进度只在本机显示、保存和导出，不发给模型。
// 本窗口全部生成：清点只在本机做、跟着页面走；确认以后后台逐个读字幕、生成概览，关掉侧边栏照常做完，重开时接上。
import type { ErrorCode } from "../../core/errors.ts";
import type { BatchStop } from "../../core/triage/batch.ts";
import type { TriageVerdict } from "../../core/triage/groups.ts";
import type { OfficialRecord, TriageList } from "../../core/triage/state.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { EmptyRequest } from "./core.ts";

/** 粗筛的三步：读稍后再看列表、逐个取官方总结（不花额度）、给有官方总结的写一句话结论（花额度）。 */
export type TriageStep = "list" | "official" | "verdict";

/** 一步提前结束的原因：被平台限流、连着要登录、这条读取路线整体读不了，或者用户停止、页面都关了。 */
export type TriageStop = BatchStop | "stopped";

export interface BatchFailure {
  readonly code: ErrorCode;
}

export type TriageIn =
  /** 开始一步。同一步正在跑时接上它。 */
  | { readonly type: "triage.start"; readonly step: TriageStep }
  /** 停下正在跑的那一步：不再开始新的条目，已经发出的请求照常收尾。 */
  | { readonly type: "triage.stop" };

/** 本窗口全部生成的消息只收侧边栏，都带侧边栏所在的窗口。 */
export type WindowIn =
  /** 清点本窗口：只看标签页的地址和标题、本机已有的概览和任务表，不向平台读。 */
  | { readonly type: "window.count"; readonly windowId: number }
  /** 确认：按这个端口上一次清点出的「要新生成」开始。 */
  | { readonly type: "window.start"; readonly windowId: number }
  /** 全部停止：不再开始新的，正在生成的一起停下。 */
  | { readonly type: "window.stop"; readonly windowId: number }
  /** 失败或停掉的一条单独重来。 */
  | { readonly type: "window.retry"; readonly windowId: number; readonly video: VideoKey }
  /** 跟上这个窗口的这一批：马上回一份现状，之后有变化就推。 */
  | { readonly type: "window.watch"; readonly windowId: number }
  /** 收起：没有在跑的条目时，忘掉这一批。 */
  | { readonly type: "window.dismiss"; readonly windowId: number };

export type BatchIn = TriageIn | WindowIn;

/** 粗筛页要显示的：读到的列表、官方总结、已经写好的结论（跟着概览存），以及正在跑的那一步。 */
export interface TriageSnapshot {
  readonly list: TriageList | null;
  readonly official: Readonly<Record<string, OfficialRecord>>;
  readonly verdicts: Readonly<Record<string, TriageVerdict>>;
  readonly running: TriageStep | null;
}

export type TriageOut =
  /** 这一步开始了。total 是要处理的条目，skipped 是按跳过规则不处理的；joined：接上了别的页面在跑的同一步。 */
  | { readonly type: "triage.started"; readonly step: TriageStep; readonly total: number; readonly skipped: number; readonly joined: boolean }
  /**
   * 一个条目做完了：取到的官方总结、写好的结论，或者没做成的原因。unavailable：视频看不了（付费、确认不了付费、找不到），
   * 两步之后都跳过它。
   */
  | {
      readonly type: "triage.item";
      readonly step: Exclude<TriageStep, "list">;
      readonly video: VideoKey;
      readonly done: number;
      readonly official?: OfficialRecord;
      readonly verdict?: TriageVerdict;
      readonly unavailable?: true;
      readonly failure?: BatchFailure;
    }
  /** 这一步结束。读列表这一步带回新的状态和丢掉的条目数。 */
  | {
      readonly type: "triage.done";
      readonly step: TriageStep;
      readonly done: number;
      readonly total: number;
      readonly stop?: TriageStop;
      readonly failure?: BatchFailure;
      readonly state?: TriageSnapshot;
      readonly dropped?: number;
    }
  /** 没能开始：另一步正在跑、列表不在了、AI 服务没设置好这些。 */
  | { readonly type: "triage.refused"; readonly step: TriageStep; readonly failure: BatchFailure };

export type BatchOut = TriageOut | WindowOut;

/** 清点出的一个视频：已有概览、正在生成、要新生成。同一视频同一分 P 只算一次。 */
export interface WindowCountItem {
  readonly video: VideoKey;
  readonly title: string;
  readonly state: "existing" | "running" | "to-generate";
}

/** 这一批里一条的去向。skipped：同一个视频别处正在用别的设置生成，这一批不管它。 */
export type WindowEntryStatus = "pending" | "running" | "completed" | "failed" | "canceled" | "skipped";

export interface WindowEntryView {
  readonly video: VideoKey;
  readonly title: string;
  readonly status: WindowEntryStatus;
  /** 正在生成时的概览任务号：侧边栏切到这个视频时跟着它的进度。 */
  readonly taskId?: string;
  readonly failure?: BatchFailure;
  /** 生成出来了，但有分块没成：概览不完整。 */
  readonly partial?: true;
}

export interface WindowRunView {
  readonly entries: readonly WindowEntryView[];
  /** 点过全部停止，正在等在途的收尾。 */
  readonly stopping: boolean;
  /** 读平台被限流、连着要登录这类原因整批提前停下。 */
  readonly stop?: BatchStop;
}

export type WindowOut =
  | { readonly type: "window.counted"; readonly windowId: number; readonly items: readonly WindowCountItem[] }
  /** 这个窗口的这一批的现状；没有这一批时 run 是 null。 */
  | { readonly type: "window.state"; readonly windowId: number; readonly run: WindowRunView | null }
  /** 没能照做：AI 服务没设置好、已经有一批在跑、没有清点过这些。 */
  | { readonly type: "window.refused"; readonly windowId: number; readonly failure: BatchFailure };

export interface BatchApi {
  "triage.state": { req: EmptyRequest; res: TriageSnapshot };
}
