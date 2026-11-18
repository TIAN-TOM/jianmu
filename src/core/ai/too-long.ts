// 认出服务因为输入超过模型上下文而拒绝的请求。问答和概览共用。
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
