// 评论区（PRD F23）要加进两份说明的条目：只从 consent.ts 的开关分支引用，构建开关 FEATURE_COMMENTS 关着的构建里没有。
// 在 consent.ts 里单独成一版：日用包认得出存着的第 1 版，只列这几条；发行构建没有这一版。英文措辞和中文并排写，不进指纹。
import type { ActivationKind, DataConsentKind, NoticeItem } from "./consent.ts";

/** 首次启用说明：多读评论区的第一批热评，YouTube 上可能替你滚一次页面。 */
export const COMMENT_ACTIVATION_ITEMS = [
  {
    kind: "read",
    id: "top-comments",
    text: "生成概览时，当前视频评论区的第一批热评：只读正文、点赞数和是否置顶，不读昵称和评论者的主页。YouTube 上评论区还没加载、标签页又在前台时，会替你把页面滚到评论区一次，读完滚回原处",
    en: "When an overview is generated, the first batch of top comments on the current video: only the text, like counts and whether a comment is pinned, not names or commenters' profiles. On YouTube, if the comments haven't loaded and the tab is in front, Jianmu scrolls the page to the comments once and back again",
  },
] as const satisfies readonly NoticeItem<ActivationKind>[];

/** 数据说明：多发第一批热评，用途仍是概览和一句话结论。 */
export const COMMENT_DATA_ITEMS = [
  {
    kind: "category",
    id: "top-comments",
    text: "生成概览时当前视频的第一批热评：正文和点赞数，不含昵称；正文里明显带联系方式的整条不发。开着「打开就出结论」时随概览自动发送",
    en: "When an overview is generated, the first batch of top comments on the current video: text and like counts, without names. A comment that clearly contains contact details isn't sent at all. With “Verdict on open” turned on, these are sent automatically with the overview",
  },
] as const satisfies readonly NoticeItem<DataConsentKind>[];
