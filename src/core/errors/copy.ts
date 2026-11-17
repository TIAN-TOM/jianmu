// 一个错误码给用户看的三段话。各领域的文案表都用这个形状。

/** 每段是以句号结尾的整句；没话可说的那一段不写。 */
export interface ErrorCopy {
  readonly cause: string;
  readonly impact?: string;
  readonly next?: string;
}
