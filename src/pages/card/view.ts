// 卡片的状态长什么样，和刚插进页面时的初始值。状态怎么变在 model.ts。
import type { LearningAnalysis, OverviewTranscriptBasis } from "../../core/notes/records.ts";
import type { OfficialSummaryView } from "../../shared/messages/transcript.ts";

export type Tone = "" | "warn" | "error";

export interface TaskProgress {
  readonly id: string;
  readonly external: boolean;
  /** 打开就出结论自动起的。 */
  readonly auto: boolean;
  /** 用官方总结写结论的任务：进度行写「正在写一句话结论」。 */
  readonly verdict?: true;
  readonly canceling: boolean;
  readonly done: number;
  readonly total: number;
  readonly message: string;
}

export interface CardView {
  /** 没启用、卡片关着、还没问到：整张卡片不显示。 */
  readonly visible: boolean;
  readonly collapsed: boolean;
  readonly phase: "waiting" | "not-video" | "loading" | "loaded" | "failed";
  readonly title: string;
  readonly official: OfficialSummaryView | null;
  readonly analysis: LearningAnalysis | null;
  /** 摆着的概览里章节和结论各自依据的字幕指纹；生成中的临时概览没有。 */
  readonly transcriptBasis: OverviewTranscriptBasis | null;
  /** 本机这份概览里没生成出来的分块数。 */
  readonly failedParts: number;
  /** 头部操作区收着、展开，或正在确认重新生成。 */
  readonly more: "closed" | "actions" | "confirm";
  /** 本机有字幕时，现在用的那份的指纹：和上面的对不上就标「基于旧字幕」。 */
  readonly transcriptFingerprint: string | null;
  /** 结论还没写好：true 表示正在写结论，字符串是还没有进度文字时的章节提示。 */
  readonly verdictPending: boolean | string;
  readonly noCaptions: boolean;
  /** 没登录 B 站：读得到视频信息，字幕要登录才读得到。 */
  readonly needLogin: boolean;
  /** 字幕要用户在侧边栏点读取才读的站（YouTube），本机还没有字幕：卡片不去读，先请用户在侧边栏读。 */
  readonly notRead: boolean;
  /** 这个视频能提问：有字幕可用（B 站登录着时后台自己读，YouTube 要本机已有）。 */
  readonly canAsk: boolean;
  readonly task: TaskProgress | null;
  readonly settingsError: boolean;
  readonly notice: { readonly text: string; readonly tone: Tone; /** 模型服务报错时自己说的话。 */ readonly said?: string } | null;
  /** 章节（还没有概览时是官方提纲）默认只露前几条，点了「展开全部」才全露。换了视频回到默认。 */
  readonly showAll: boolean;
  /** 有概览时，从头部的更多操作打开 B 站官方总结。换了视频回到收着。 */
  readonly officialOpen: boolean;
  /** 评论区那一行点开了，露出要点。换了视频回到收着。 */
  readonly commentsOpen: boolean;
  /** 这个视频的内容还在来：生成等操作先不摆。 */
  readonly holdActions: boolean;
  /** 本窗口的侧边栏开着：卡片上不摆打开侧边栏的入口。 */
  readonly panelOpen: boolean;
  /** 收着时播放到的那一章，在 chaptersInOrder 里的序号；不知道时是 null。 */
  readonly chapterNow: number | null;
  /** 收起的那一行上临时说的一句话，没有时是空串。 */
  readonly headNote: string;
}

/** 刚插进页面、还没问到任何东西时的样子。 */
export const INITIAL: CardView = {
  visible: false,
  collapsed: false,
  phase: "waiting",
  title: "",
  official: null,
  analysis: null,
  transcriptBasis: null,
  failedParts: 0,
  more: "closed",
  transcriptFingerprint: null,
  verdictPending: false,
  noCaptions: false,
  needLogin: false,
  notRead: false,
  canAsk: false,
  task: null,
  settingsError: false,
  notice: null,
  showAll: false,
  officialOpen: false,
  commentsOpen: false,
  holdActions: false,
  panelOpen: false,
  chapterNow: null,
  headNote: "",
};
