// 回收用不上的主机授权：只收设置页，在保存成功之后发。确认启用之前也放行，只碰授权接口，
// 不发平台和模型请求，不查标签页。回收读的是执行那一刻的设置，两次保存都落地后才轮到的回收不会收掉后一次的来源。
import { ok } from "../../core/errors.ts";
import type { Grants } from "../grants.ts";
import type { Route } from "../router.ts";
import { isEmptyRequest } from "./validate.ts";

export interface GrantRouteDeps {
  readonly grants: Grants;
}

export function grantRoutes({ grants }: GrantRouteDeps): { readonly "grants.release": Route<"grants.release"> } {
  return {
    "grants.release": {
      senders: ["page"],
      pages: ["options"],
      beforeEnable: true,
      validate: isEmptyRequest,
      handler: async () => ok(await grants.releaseUnused()),
    },
  };
}
