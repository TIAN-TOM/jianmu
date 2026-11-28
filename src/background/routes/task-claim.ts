// 认领登记好的任务的请求里取出任务号：播放页卡片只认登记时拿到的一次性令牌，别的页面只认任务号。
// 问答、用官方总结写结论、开始概览和补失败块共用；各条路由自己的规矩（卡片不点名标签页、重新生成限频、准备步骤）留在各自的路由里。
import type { Failure } from "../../core/errors.ts";
import type { CardLimits } from "../limits.ts";
import type { SenderCtx } from "../senders.ts";
import { isId } from "./validate.ts";

/** 请求形状：任务号和令牌恰好带一个，带着的那个是合格的编号。归谁用哪个由处理时按发送方定。 */
export function hasTaskIdOrToken(req: Readonly<Record<string, unknown>>): boolean {
  return Object.hasOwn(req, "taskId") ? isId(req.taskId) && !Object.hasOwn(req, "token") : isId(req.token);
}

/** 取任务号的三种结果：拿到任务号；令牌换不出任务号；这个发送方不该带这种凭据。 */
export type TaskClaim =
  | { readonly ok: true; readonly taskId: string }
  | (Failure & { readonly code: "TASK_NOT_FOUND" })
  | (Failure & { readonly code: "FORBIDDEN" });

/**
 * 卡片带任务号或没带令牌回 FORBIDDEN，不碰令牌；带了令牌就兑换一次（用一次就作废），换不出回 TASK_NOT_FOUND。
 * 别的页面没带任务号回 FORBIDDEN，带了令牌也不兑换。
 */
export function claimTaskId(
  sender: Pick<SenderCtx, "kind">,
  req: { readonly taskId?: string | undefined; readonly token?: string | undefined },
  cardLimits: Pick<CardLimits, "redeemToken">,
): TaskClaim {
  if (sender.kind !== "card") return req.taskId === undefined ? { ok: false, code: "FORBIDDEN" } : { ok: true, taskId: req.taskId };
  if (req.taskId !== undefined || req.token === undefined) return { ok: false, code: "FORBIDDEN" };
  const taskId = cardLimits.redeemToken(req.token);
  return taskId ? { ok: true, taskId } : { ok: false, code: "TASK_NOT_FOUND" };
}
