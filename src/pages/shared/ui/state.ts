// 取不到内容时状态块的文案：原因当标题，影响当说明，下一步写在按钮上面。
import { errorCopy, type ErrorCode } from "../../../core/errors.ts";
import type { UiLang } from "../ui-lang.ts";

export interface StateCopy {
  readonly title: string;
  readonly impact?: string;
  readonly next?: string;
}

/** 组件渲染时传当前的界面语言。 */
export function stateCopy(code: ErrorCode, detail: string | undefined, lang: UiLang): StateCopy {
  const { cause, impact, next } = errorCopy(code, detail, lang);
  return { title: cause, ...(impact ? { impact } : {}), ...(next ? { next } : {}) };
}
