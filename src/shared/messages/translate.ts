// 翻译端口两个方向的消息。侧边栏连着端口发起翻译，后台分批请求模型，每批回来就推给页面；
// 页面关掉端口只退订自己，订阅的页面都走了才停下还没开始的批次。
import type { ErrorCode } from "../../core/errors.ts";
import type { TranscriptRef } from "../../core/notes/records.ts";
import type { TaskView } from "../../core/tasks.ts";
import type { VideoKey } from "../../core/video-ref.ts";

/** 译成哪种语言：中文字幕译成英文，其他语言的字幕译成简体中文。 */
export type TranslateTarget = "zh" | "en";

export type TranslateIn =
  /** 翻译这个视频现在的字幕。fromSec：从这一秒往后的先译，前面的随后补齐。 */
  | { readonly type: "translate.start"; readonly video: VideoKey; readonly fromSec?: number }
  /** 停掉这个页面发起或接上的翻译。 */
  | { readonly type: "translate.stop" };

export interface TranslateFailure {
  readonly code: ErrorCode;
  readonly detail?: string;
}

export type TranslateOut =
  /** 登记好了：接上了别的页面在跑的同一份翻译时 joined 为真。pending 是这次还要请求模型的段数。 */
  | {
      readonly type: "translate.started";
      readonly task: TaskView;
      readonly joined: boolean;
      readonly transcript: TranscriptRef;
      readonly target: TranslateTarget;
      readonly pending: number;
    }
  /**
   * 一批译文，键是分段编号。fingerprint 是译的那一版字幕，页面显示的不是这一版就不用它。
   * stored：本机已经存着的，不是这次请求模型得来的。saveFailed：付过费，但没能存下。
   */
  | {
      readonly type: "translate.segments";
      readonly taskId?: string;
      readonly fingerprint: string;
      readonly translated: Readonly<Record<string, string>>;
      readonly stored?: true;
      readonly saveFailed?: true;
    }
  /** 这一轮翻译结束。没有要请求模型的段时不登记任务，也没有任务号。 */
  | {
      readonly type: "translate.done";
      readonly taskId?: string;
      readonly state: "completed" | "failed" | "canceled";
      readonly totalBatches: number;
      readonly failedBatches: number;
      /** 全部失败时的原因。 */
      readonly failure?: TranslateFailure;
      readonly saveFailed?: true;
    }
  /** 没能开始：取不到字幕、同一个视频已有不一样的翻译在跑（带着那个任务）、配置不对这些。 */
  | { readonly type: "translate.refused"; readonly failure: TranslateFailure; readonly task?: TaskView };
