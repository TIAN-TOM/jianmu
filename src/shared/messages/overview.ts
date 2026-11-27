// 概览这几条消息的请求和回复：开始生成、补失败块、读本机已有的概览、用官方总结写结论。生成、补块和写结论都要先经任务登记拿到任务号，
// 卡片能开始生成、重新生成、补失败块和用官方总结写结论，都凭登记时拿到的一次性令牌。回复里的概览是生效中的那份，重新生成写到一半的草稿不给页面。
import type { FailureRange } from "../../core/ai/chunking.ts";
import type { LearningAnalysis, OverviewTranscriptBasis } from "../../core/notes/records.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { OverviewView } from "./transcript.ts";

export interface OverviewStartRequest {
  readonly video: VideoKey;
  /** 侧边栏登记任务时拿到的任务号。 */
  readonly taskId?: string;
  /** 卡片登记任务时拿到的一次性令牌，卡片只认它。 */
  readonly token?: string;
  /** 已有概览时重新生成。卡片也能带，界面上先确认一次。 */
  readonly fresh?: boolean;
  /**
   * 侧边栏在要经页面读字幕的站（YouTube）上、本机还没有字幕时带上视频所在的标签页：后台先经这个标签页读到字幕再生成，
   * 和卡片上的「生成概览」同一条路。卡片不带，按它自己所在的标签页算。
   */
  readonly tabId?: number;
}

/** 补失败块：侧边栏凭任务号，卡片凭登记时拿到的一次性令牌，两样恰好带一个。 */
export interface OverviewRetryRequest {
  readonly video: VideoKey;
  readonly taskId?: string;
  readonly token?: string;
}

export interface OverviewGetRequest {
  readonly video: VideoKey;
}

/** 用官方总结写一句话结论：侧边栏先登记结论任务，凭任务号开始；卡片凭登记时拿到的一次性令牌开始。两样恰好带一个。 */
export interface VerdictFromOfficialRequest {
  readonly video: VideoKey;
  readonly taskId?: string;
  readonly token?: string;
}

export interface OverviewResultView {
  readonly video: VideoKey;
  readonly analysis: LearningAnalysis;
  readonly analysisFailures: readonly FailureRange[];
  /** 生效中的章节和结论各自依据的字幕指纹，同 OverviewView。 */
  readonly transcriptBasis?: OverviewTranscriptBasis;
  /** 本机已有，没向模型发请求。 */
  readonly fromCache: boolean;
  /** 还缺的分块：部分块失败也照样出结果，如实告诉用户这份不完整。 */
  readonly failedChunks: number;
  readonly chunkCount?: number;
  /** 停在中途：已经完成的块存下了几块。 */
  readonly savedChunks?: number;
  /** 补失败块：这次真的补上了几块，全部又失败时是 0。 */
  readonly recoveredChunks?: number;
  readonly canceled?: true;
  /** 结论那一步被停掉了，章节照常存着。 */
  readonly verdictCanceled?: true;
  /** 重新生成的章节先存成草稿，结论没写成，生效的仍是原来那份。 */
  readonly draftKept?: true;
  /** 概览已经生成，但没能存进本机。 */
  readonly saveFailed?: true;
}

export interface OverviewGetView {
  readonly video: VideoKey;
  /** 本机没有概览时不带。 */
  readonly overview?: OverviewView;
}

export interface OverviewApi {
  "overview.start": { req: OverviewStartRequest; res: OverviewResultView };
  "overview.retryFailed": { req: OverviewRetryRequest; res: OverviewResultView };
  "overview.get": { req: OverviewGetRequest; res: OverviewGetView };
  /** 回复里的结论可能是已经有的那份：已有结论时不再花一次钱。 */
  "verdict.fromOfficial": { req: VerdictFromOfficialRequest; res: OverviewResultView };
}
