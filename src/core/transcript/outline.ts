// 官方总结的提纲：一串分段，每段有标题、起点和要点。站点读取的契约、给页面的消息、字幕缓存和指纹都用这一份形状。
// 字段和用户备份里已有的形状一致。
import { isRecord } from "../../shared/guards.ts";

/** 提纲里的一个要点：起点（秒，可以没有）和正文。 */
export interface OutlinePoint {
  readonly timestamp: number | null;
  readonly content: string;
}

/** 提纲里的一段：标题、起点（秒，可以没有）和这一段的要点。 */
export interface OutlineSection {
  readonly title: string;
  readonly timestamp: number | null;
  readonly points: readonly OutlinePoint[];
}

const isStamp = (value: unknown): value is number | null => value === null || (typeof value === "number" && Number.isFinite(value));

const isOutlinePoint = (value: unknown): value is OutlinePoint =>
  isRecord(value) && isStamp(value.timestamp) && typeof value.content === "string";

/** 存储里读回来的一段是不是合法的分段：标题是字符串，起点是有限数字或 null，要点是数组且每项合法。 */
export function isOutlineSection(value: unknown): value is OutlineSection {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    isStamp(value.timestamp) &&
    Array.isArray(value.points) &&
    (value.points as readonly unknown[]).every(isOutlinePoint)
  );
}
