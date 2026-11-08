// 问答记录：一问一答记下以后不再改。引用原句存快照，字幕换了也能独立显示。
import type { Derived } from "../notes/records.ts";
import type { VideoKey } from "../video-ref.ts";
import type { Citation } from "./citations.ts";

export interface QaRecord {
  readonly id: string;
  readonly video: VideoKey;
  readonly question: string;
  readonly answer: string;
  readonly citations: readonly Citation[];
  // 回答里能点的时间点，按秒数记。
  readonly clickable: readonly number[];
  readonly truncated?: true;
  readonly derived?: Derived;
  readonly createdAt: number;
}
