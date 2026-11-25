// 要到设置页「AI 服务」那一节去改的错误码：页面报这些错时，下面跟一个「打开设置」，直接滚到那一节。
// 侧边栏的概览、问答、翻译、整理字幕、画面解释和播放页卡片共用这一张表。只放码，文案在各领域自己的文件里。
// 只有画面解释会报的码（模型不能看图）跟着构建开关，写在侧边栏的画面模块里，不进这张表。
import type { ErrorCode } from "../errors.ts";

const CODES: readonly ErrorCode[] = [
  "NO_AI_CONFIG",
  "NO_DATA_CONSENT",
  "NEED_HOST_PERMISSION",
  "INVALID_AI_KEY",
  "INVALID_BASE_URL",
  "AI_REDIRECT_BLOCKED",
  "MODEL_OR_ENDPOINT_NOT_FOUND",
  "ANTHROPIC_WORKSPACE_REQUIRED",
  "AI_THINKING_EXHAUSTED",
  "AI_THINKING_EXHAUSTED_LOCKED",
  "WHOLE_CHUNK_TOO_BIG",
  "QA_INPUT_TOO_LONG",
];

export const SETTINGS_FIX_CODES: ReadonlySet<ErrorCode> = new Set(CODES);

/** 这个错要到设置页去改；没有码时不算。 */
export const fixedInSettings = (code: ErrorCode | null | undefined): boolean => code !== null && code !== undefined && SETTINGS_FIX_CODES.has(code);
