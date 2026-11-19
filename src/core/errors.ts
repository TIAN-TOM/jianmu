// 错误码汇总和统一的结果形状。各领域的码和三段文案在 errors/ 下各一份，这里拼成一张表；漏写文案编译就报错。
import { AI_ERROR_TEXT, type AiErrorCode } from "./errors/ai.ts";
import type { ErrorCopy } from "./errors/copy.ts";
import { BACKUP_ERROR_TEXT, type BackupErrorCode } from "./errors/backup.ts";
import { BATCH_ERROR_TEXT, type BatchErrorCode } from "./errors/batch.ts";
import { DATA_ERROR_TEXT, type DataErrorCode } from "./errors/data.ts";
import { FRAME_ERROR_TEXT, type FrameErrorCode } from "./errors/frame.ts";
import { NOTE_ERROR_TEXT, type NoteErrorCode } from "./errors/notes.ts";
import { OVERVIEW_ERROR_TEXT, type OverviewErrorCode } from "./errors/overview.ts";
import { QA_ERROR_TEXT, type QaErrorCode } from "./errors/qa.ts";
import { ROUTING_ERROR_TEXT, type RoutingErrorCode } from "./errors/routing.ts";
import { SESSION_ERROR_TEXT, type SessionErrorCode } from "./errors/session.ts";
import { SETTINGS_ERROR_TEXT, type SettingsErrorCode } from "./errors/settings.ts";
import { SITE_DETAIL_TEXT, SITE_ERROR_TEXT, type SiteErrorCode } from "./errors/site.ts";
import { TASK_ERROR_TEXT, type TaskErrorCode } from "./errors/tasks.ts";
import { TRANSCRIPT_DETAIL_TEXT, TRANSCRIPT_ERROR_TEXT, type TranscriptErrorCode } from "./errors/transcript.ts";
import { TRANSLATE_ERROR_TEXT, type TranslateErrorCode } from "./errors/translate.ts";

export type {
  ErrorCopy,
  AiErrorCode,
  BackupErrorCode,
  BatchErrorCode,
  DataErrorCode,
  FrameErrorCode,
  NoteErrorCode,
  OverviewErrorCode,
  QaErrorCode,
  RoutingErrorCode,
  SessionErrorCode,
  SettingsErrorCode,
  SiteErrorCode,
  TaskErrorCode,
  TranscriptErrorCode,
  TranslateErrorCode,
};

export type ErrorCode =
  | SiteErrorCode
  | SettingsErrorCode
  | RoutingErrorCode
  | AiErrorCode
  | TaskErrorCode
  | SessionErrorCode
  | TranscriptErrorCode
  | DataErrorCode
  | OverviewErrorCode
  | QaErrorCode
  | NoteErrorCode
  | TranslateErrorCode
  | BackupErrorCode
  | BatchErrorCode
  | FrameErrorCode;

export interface Failure {
  readonly ok: false;
  readonly code: ErrorCode;
  readonly detail?: string;
  readonly retryAfterSec?: number;
  /** 站点拒绝了这次读取，已经进了退避。 */
  readonly rejected?: true;
  /**
   * 模型服务报错时自己说的话，清洗、截短、遮过密钥的纯文本。只跟着这次回复给界面显示，
   * 不写进存储和备份：要存失败的地方只挑码和 detail。
   */
  readonly said?: string;
}

export type Result<T> = { readonly ok: true; readonly value: T } | Failure;

// 解释当前画面的码只在开关打开的构建里有文案；关着的构建不会产生这些码，isErrorCode 也不认。
const TEXT = {
  ...SITE_ERROR_TEXT,
  ...SETTINGS_ERROR_TEXT,
  ...ROUTING_ERROR_TEXT,
  ...AI_ERROR_TEXT,
  ...TASK_ERROR_TEXT,
  ...SESSION_ERROR_TEXT,
  ...TRANSCRIPT_ERROR_TEXT,
  ...DATA_ERROR_TEXT,
  ...OVERVIEW_ERROR_TEXT,
  ...QA_ERROR_TEXT,
  ...NOTE_ERROR_TEXT,
  ...TRANSLATE_ERROR_TEXT,
  ...BACKUP_ERROR_TEXT,
  ...BATCH_ERROR_TEXT,
  ...(FEATURE_FRAME_EXPLAIN ? FRAME_ERROR_TEXT : {}),
} as Readonly<Record<ErrorCode, ErrorCopy>>;

const DETAIL_TEXT: Readonly<Partial<Record<ErrorCode, Readonly<Record<string, ErrorCopy>>>>> = { ...SITE_DETAIL_TEXT, ...TRANSCRIPT_DETAIL_TEXT };

/** 给用户看的三段：原因、影响、下一步。有的码按 detail 换说法，认不出的 detail 用码本身的说法。 */
export function errorCopy(code: ErrorCode, detail?: string): ErrorCopy {
  const byDetail = DETAIL_TEXT[code];
  if (detail !== undefined && byDetail && Object.hasOwn(byDetail, detail)) return byDetail[detail] ?? TEXT[code];
  return TEXT[code];
}

/** 三段拼成的一段话，给只放得下一段文字的地方。 */
export function describe(code: ErrorCode, detail?: string): string {
  const { cause, impact = "", next = "" } = errorCopy(code, detail);
  return cause + impact + next;
}

/** 码在不在这张表里：从消息或存储里读出来的码要先过它。 */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(TEXT, value);
}

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail(code: ErrorCode, detail?: string): Failure {
  return detail === undefined ? { ok: false, code } : { ok: false, code, detail };
}
