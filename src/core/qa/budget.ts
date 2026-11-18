// 问答一次送给模型多少字幕：先按大预算送，模型装不下时缩到小预算再发一次。

/** 一次提问最多送这么多字的字幕；整份装得下就整份送。 */
export const QA_BUDGET_CHARS = 60_000;

/** 被嫌太长以后缩到这么多字再发一次。上下文较小的模型也装得下。 */
export const QA_FALLBACK_BUDGET_CHARS = 12_000;

// 服务说输入超过上下文时的几种说法。
const TOO_LONG =
  /context.{0,20}(?:length|window|limit)|maximum context|prompt is too long|input is too long|too many (?:input )?tokens|token limit|exceeds?.{0,40}(?:context|tokens?\b|limit)|input length|上下文.{0,8}(?:长度|超)|超长|超出.{0,12}(?:长度|上下文|限制)/i;

interface ErrorLike {
  readonly status?: unknown;
  readonly message?: unknown;
}

/** 服务是不是因为输入太长而拒绝了这次请求。 */
export function isInputTooLong(error: unknown): boolean {
  const failure = (error ?? {}) as ErrorLike;
  if (failure.status === 413) return true;
  return (failure.status === 400 || failure.status === 422) && TOO_LONG.test(String(failure.message ?? ""));
}
