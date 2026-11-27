// 错误码汇总和统一的结果形状。各领域的码和三段文案在 errors/ 下各一份，这里拼成一张表；漏写文案编译就报错。
// 文案简体、英文、繁体各一张，繁体的在 errors/ 下以 -hant.ts 结尾的模块里；取文案的函数最后一个参数是语言，不传时是简体。
import { AI_ERROR_TEXT, AI_ERROR_TEXT_EN, type AiErrorCode } from "./errors/ai.ts";
import { AI_ERROR_TEXT_HANT } from "./errors/ai-hant.ts";
import { BACKUP_ERROR_TEXT_HANT } from "./errors/backup-hant.ts";
import { BATCH_ERROR_TEXT_HANT } from "./errors/batch-hant.ts";
import { DATA_ERROR_TEXT_HANT } from "./errors/data-hant.ts";
import { FRAME_ERROR_TEXT_HANT } from "./errors/frame-hant.ts";
import { NOTE_ERROR_TEXT_HANT } from "./errors/notes-hant.ts";
import { OVERVIEW_ERROR_TEXT_HANT } from "./errors/overview-hant.ts";
import { QA_ERROR_TEXT_HANT } from "./errors/qa-hant.ts";
import { ROUTING_ERROR_TEXT_HANT } from "./errors/routing-hant.ts";
import { SESSION_ERROR_TEXT_HANT } from "./errors/session-hant.ts";
import { SETTINGS_ERROR_TEXT_HANT } from "./errors/settings-hant.ts";
import { SITE_DETAIL_TEXT_HANT, SITE_ERROR_TEXT_HANT } from "./errors/site-hant.ts";
import { TASK_ERROR_TEXT_HANT } from "./errors/tasks-hant.ts";
import { TRANSCRIPT_DETAIL_TEXT_HANT, TRANSCRIPT_ERROR_TEXT_HANT } from "./errors/transcript-hant.ts";
import { TRANSLATE_ERROR_TEXT_HANT } from "./errors/translate-hant.ts";
import type { ErrorCopy } from "./errors/copy.ts";
import { BACKUP_ERROR_TEXT, BACKUP_ERROR_TEXT_EN, type BackupErrorCode } from "./errors/backup.ts";
import { BATCH_ERROR_TEXT, BATCH_ERROR_TEXT_EN, type BatchErrorCode } from "./errors/batch.ts";
import { DATA_ERROR_TEXT, DATA_ERROR_TEXT_EN, type DataErrorCode } from "./errors/data.ts";
import { FRAME_ERROR_TEXT, FRAME_ERROR_TEXT_EN, type FrameErrorCode } from "./errors/frame.ts";
import { NOTE_ERROR_TEXT, NOTE_ERROR_TEXT_EN, type NoteErrorCode } from "./errors/notes.ts";
import { OVERVIEW_ERROR_TEXT, OVERVIEW_ERROR_TEXT_EN, type OverviewErrorCode } from "./errors/overview.ts";
import { QA_ERROR_TEXT, QA_ERROR_TEXT_EN, type QaErrorCode } from "./errors/qa.ts";
import { ROUTING_ERROR_TEXT, ROUTING_ERROR_TEXT_EN, type RoutingErrorCode } from "./errors/routing.ts";
import { SESSION_ERROR_TEXT, SESSION_ERROR_TEXT_EN, type SessionErrorCode } from "./errors/session.ts";
import { SETTINGS_ERROR_TEXT, SETTINGS_ERROR_TEXT_EN, type SettingsErrorCode } from "./errors/settings.ts";
import { SITE_DETAIL_TEXT, SITE_DETAIL_TEXT_EN, SITE_ERROR_TEXT, SITE_ERROR_TEXT_EN, type SiteErrorCode } from "./errors/site.ts";
import { TASK_ERROR_TEXT, TASK_ERROR_TEXT_EN, type TaskErrorCode } from "./errors/tasks.ts";
import { TRANSCRIPT_DETAIL_TEXT, TRANSCRIPT_DETAIL_TEXT_EN, TRANSCRIPT_ERROR_TEXT, TRANSCRIPT_ERROR_TEXT_EN, type TranscriptErrorCode } from "./errors/transcript.ts";
import { TRANSLATE_ERROR_TEXT, TRANSLATE_ERROR_TEXT_EN, type TranslateErrorCode } from "./errors/translate.ts";
import { inLang, isChineseLang, type OutputLang } from "./output-lang.ts";

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

// 英文那张，和中文那张一样拼；画面的码同样只在开关分支里。
const TEXT_EN = {
  ...SITE_ERROR_TEXT_EN,
  ...SETTINGS_ERROR_TEXT_EN,
  ...ROUTING_ERROR_TEXT_EN,
  ...AI_ERROR_TEXT_EN,
  ...TASK_ERROR_TEXT_EN,
  ...SESSION_ERROR_TEXT_EN,
  ...TRANSCRIPT_ERROR_TEXT_EN,
  ...DATA_ERROR_TEXT_EN,
  ...OVERVIEW_ERROR_TEXT_EN,
  ...QA_ERROR_TEXT_EN,
  ...NOTE_ERROR_TEXT_EN,
  ...TRANSLATE_ERROR_TEXT_EN,
  ...BACKUP_ERROR_TEXT_EN,
  ...BATCH_ERROR_TEXT_EN,
  ...(FEATURE_FRAME_EXPLAIN ? FRAME_ERROR_TEXT_EN : {}),
} as Readonly<Record<ErrorCode, ErrorCopy>>;

// 繁体那张，同样拼；画面的码同样只在开关分支里。
const TEXT_HANT = {
  ...SITE_ERROR_TEXT_HANT,
  ...SETTINGS_ERROR_TEXT_HANT,
  ...ROUTING_ERROR_TEXT_HANT,
  ...AI_ERROR_TEXT_HANT,
  ...TASK_ERROR_TEXT_HANT,
  ...SESSION_ERROR_TEXT_HANT,
  ...TRANSCRIPT_ERROR_TEXT_HANT,
  ...DATA_ERROR_TEXT_HANT,
  ...OVERVIEW_ERROR_TEXT_HANT,
  ...QA_ERROR_TEXT_HANT,
  ...NOTE_ERROR_TEXT_HANT,
  ...TRANSLATE_ERROR_TEXT_HANT,
  ...BACKUP_ERROR_TEXT_HANT,
  ...BATCH_ERROR_TEXT_HANT,
  ...(FEATURE_FRAME_EXPLAIN ? FRAME_ERROR_TEXT_HANT : {}),
} as Readonly<Record<ErrorCode, ErrorCopy>>;

type DetailText = Readonly<Partial<Record<ErrorCode, Readonly<Record<string, ErrorCopy>>>>>;

const DETAIL_TEXT: DetailText = { ...SITE_DETAIL_TEXT, ...TRANSCRIPT_DETAIL_TEXT };
const DETAIL_TEXT_EN: DetailText = { ...SITE_DETAIL_TEXT_EN, ...TRANSCRIPT_DETAIL_TEXT_EN };
const DETAIL_TEXT_HANT: DetailText = { ...SITE_DETAIL_TEXT_HANT, ...TRANSCRIPT_DETAIL_TEXT_HANT };

/** 给用户看的三段：原因、影响、下一步。有的码按 detail 换说法，认不出的 detail 用码本身的说法。不传语言时是简体。 */
export function errorCopy(code: ErrorCode, detail?: string, lang: OutputLang = "zh"): ErrorCopy {
  const text = inLang(lang, TEXT, TEXT_EN, TEXT_HANT);
  const byDetail = inLang(lang, DETAIL_TEXT, DETAIL_TEXT_EN, DETAIL_TEXT_HANT)[code];
  if (detail !== undefined && byDetail && Object.hasOwn(byDetail, detail)) return byDetail[detail] ?? text[code];
  return text[code];
}

/** 三段拼成的一段话，给只放得下一段文字的地方。英文的句子之间隔一个空格，简体、繁体直接连写。不传语言时是简体。 */
export function describe(code: ErrorCode, detail?: string, lang: OutputLang = "zh"): string {
  const { cause, impact = "", next = "" } = errorCopy(code, detail, lang);
  return isChineseLang(lang) ? cause + impact + next : [cause, impact, next].filter(Boolean).join(" ");
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

/**
 * 只留码、detail 和重试秒数，裁掉别的：取字幕失败时顺手带回的视频信息、字幕轨，站点退避的标记，模型自己说的话（said）。
 * 一个服务把下游的失败原样交出去之前用它。
 */
export function trimFailure({ code, detail, retryAfterSec }: Failure): Failure {
  return { ok: false, code, ...(detail === undefined ? {} : { detail }), ...(retryAfterSec === undefined ? {} : { retryAfterSec }) };
}
