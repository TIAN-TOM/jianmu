// 错误码汇总和统一的结果形状。各领域的码和文案在 errors/ 下各一份，这里拼成一张表；漏写文案编译就报错。
import { AI_ERROR_TEXT, type AiErrorCode } from "./errors/ai.ts";
import { ROUTING_ERROR_TEXT, type RoutingErrorCode } from "./errors/routing.ts";
import { SESSION_ERROR_TEXT, type SessionErrorCode } from "./errors/session.ts";
import { SETTINGS_ERROR_TEXT, type SettingsErrorCode } from "./errors/settings.ts";
import { SITE_ERROR_TEXT, type SiteErrorCode } from "./errors/site.ts";
import { TASK_ERROR_TEXT, type TaskErrorCode } from "./errors/tasks.ts";

export type { AiErrorCode, RoutingErrorCode, SessionErrorCode, SettingsErrorCode, SiteErrorCode, TaskErrorCode };

export type ErrorCode = SiteErrorCode | SettingsErrorCode | RoutingErrorCode | AiErrorCode | TaskErrorCode | SessionErrorCode;

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
};

/** 给用户看的一句话。detail 先留着位置，按细节换说法时用。 */
export function describe(code: ErrorCode, _detail?: string): string {
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
