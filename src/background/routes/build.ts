// 后台的构建标识：页面打开时拿来和自己的比。确认前也放行，不读存储、不碰网页。
import { ok } from "../../core/errors.ts";
import { BUILD_ID } from "../../shared/build-id.ts";
import type { Route } from "../router.ts";
import { isEmptyRequest } from "./validate.ts";

type BuildRoutes = { readonly [K in "build.id"]: Route<K> };

export function buildRoutes(build: string = BUILD_ID): BuildRoutes {
  return {
    "build.id": {
      senders: ["panel", "page", "card"],
      pages: ["options", "triage"],
      beforeEnable: true,
      idempotent: true,
      validate: isEmptyRequest,
      handler: async () => ok({ build }),
    },
  };
}
