// 页面打开时先核对后台是不是同一次构建。从文件夹加载的扩展，页面每次打开都读磁盘上的新文件，
// 后台却一直是上次加载时的版本，要重新加载扩展才换：两边对不上时，页面的请求后台可能不认识或理解错。
import type { ErrorCode } from "../../core/errors.ts";
import { BUILD_ID } from "../../shared/build-id.ts";
import type { PageApi } from "./api.ts";

/** same：同一次构建；stale：后台旧了；unknown：没问到，交给页面自己的报错。 */
export type BackgroundBuild = "same" | "stale" | "unknown";

/**
 * 这些拒绝说明后台不认识页面的请求。还没有构建标识这条路由的后台，对不认识的请求一律回 FORBIDDEN；
 * 本页面的几个扩展页面都在这条路由的放行名单里，新后台不会因为发送方回它。
 */
const OLD_BACKGROUND: ReadonlySet<ErrorCode> = new Set<ErrorCode>(["FORBIDDEN", "UNKNOWN_ROUTE"]);

export async function checkBackground(api: Pick<PageApi, "send">, build: string = BUILD_ID): Promise<BackgroundBuild> {
  const reply = await api.send("build.id", {});
  if (!reply.ok) return OLD_BACKGROUND.has(reply.code) ? "stale" : "unknown";
  const theirs: unknown = (reply.value as { readonly build?: unknown } | null)?.build;
  return theirs === build ? "same" : "stale";
}

/** 后台是同一次构建或问不到时照常启动页面；后台旧了就只显示提示，不再给它发别的请求。 */
export async function startWhenCurrent(api: Pick<PageApi, "send">, start: () => void, stale: () => void): Promise<void> {
  if ((await checkBackground(api)) === "stale") stale();
  else start();
}
