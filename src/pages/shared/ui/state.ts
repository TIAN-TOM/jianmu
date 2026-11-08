// 取不到内容时状态块的文案。状态块按原因、影响、下一步三段排；
// 现在每个错误码只有一句话，放在原因那一段，影响那一段留空，补全三段时只改这里。
import { describe, type ErrorCode } from "../../../core/errors.ts";

export interface StateCopy {
  readonly title: string;
  readonly impact?: string;
}

export function stateCopy(code: ErrorCode, detail?: string): StateCopy {
  return { title: describe(code, detail) };
}
