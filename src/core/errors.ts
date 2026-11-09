// 错误码汇总和统一的结果形状。各领域的码和文案在 errors/ 下各一份，这里拼成一张表；漏写文案编译就报错。
import { AI_ERROR_TEXT, type AiErrorCode } from "./errors/ai.ts";
import { DATA_ERROR_TEXT, type DataErrorCode } from "./errors/data.ts";
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
  AiErrorCode,
  DataErrorCode,
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
  | TranslateErrorCode;

export interface Failure {
  readonly ok: false;
  readonly code: ErrorCode;
  readonly detail?: string;
  readonly retryAfterSec?: number;
}

export type Result<T> = { readonly ok: true; readonly value: T } | Failure;

const TEXT: Readonly<Record<ErrorCode, string>> = {
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
};

const DETAIL_TEXT: Readonly<Partial<Record<ErrorCode, Readonly<Record<string, string>>>>> = { ...SITE_DETAIL_TEXT, ...TRANSCRIPT_DETAIL_TEXT };

/** 给用户看的一句话。有的码按 detail 换说法，认不出的 detail 用码本身的说法。 */
export function describe(code: ErrorCode, detail?: string): string {
  const byDetail = DETAIL_TEXT[code];
  if (detail !== undefined && byDetail && Object.hasOwn(byDetail, detail)) return byDetail[detail] ?? TEXT[code];
  return TEXT[code];
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
