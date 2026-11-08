// 后台日志的写法：只记哪一步失败和异常的类别，不记异常的说明、原因和请求内容，那里面可能夹着密钥或设置。

export type Log = Pick<Console, "warn" | "error">;

/** 异常的类别，例如 TypeError、QuotaExceededError；不是异常对象时记它的类型。 */
export function errorLabel(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
