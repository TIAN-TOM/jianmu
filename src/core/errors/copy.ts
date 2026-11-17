// 一个错误码给用户看的三段话。各领域的文案表都用这个形状。

/**
 * 原因：出了什么事。影响：什么没做成，已有的东西和额度有没有受影响。下一步：用户现在能做什么。
 * 每段是以句号结尾的整句；没有影响可说或没有下一步的，那一段不写。
 */
export interface ErrorCopy {
  readonly cause: string;
  readonly impact?: string;
  readonly next?: string;
}
