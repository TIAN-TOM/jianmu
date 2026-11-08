// 回收用不上的主机授权：设置页在保存成功之后发，确认启用之前也能用。
import type { EmptyRequest } from "./core.ts";

export interface GrantsReleaseReply {
  /** 收回了的授权规则。 */
  readonly released: readonly string[];
  /** 浏览器没收回的，下次保存还会再试。 */
  readonly failed: readonly string[];
}

export interface GrantsApi {
  "grants.release": { req: EmptyRequest; res: GrantsReleaseReply };
}
