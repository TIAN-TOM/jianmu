// 取不到内容时状态块的文案：原因当标题，影响当说明，下一步写在按钮上面。
import { errorCopy, type ErrorCode } from "../../../core/errors.ts";

export interface StateCopy {
  readonly title: string;
  readonly impact?: string;
  readonly next?: string;
}

export function stateCopy(code: ErrorCode, detail?: string): StateCopy {
  const { cause, impact, next } = errorCopy(code, detail);
  return { title: cause, ...(impact ? { impact } : {}), ...(next ? { next } : {}) };
}
