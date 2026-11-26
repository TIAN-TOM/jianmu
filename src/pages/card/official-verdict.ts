// 卡片上的「用官方总结写结论」（PRD 第 6.5 节）：B 站有官方总结、本机还没有一句话结论时摆，只认真实点击。
// 先登记结论任务，新起的换到一次性令牌，凭它开始；侧边栏正在写同一个的就接上它。只发一次小请求，不通读字幕。
import type { ErrorCode } from "../../core/errors.ts";
import type { TaskView } from "../../core/tasks.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { OverviewResultView } from "../../shared/messages/overview.ts";
import type { PageApi } from "../shared/api.ts";
import type { CardView } from "./model.ts";

/** 这会儿能不能摆「用官方总结写结论」：官方总结读到了、AI 服务设置好了、没有在跑的任务、还没有一句话结论。 */
export function canWriteFromOfficial(view: CardView, aiReady: boolean | null): boolean {
  const summary = view.analysis?.verdict?.summary;
  return view.phase === "loaded" && aiReady === true && !view.task && !view.verdictPending && view.official?.status === "ok" && !(typeof summary === "string" && summary.trim());
}

export type OfficialVerdictOutcome =
  | { readonly kind: "done"; readonly taskId: string; readonly value: OverviewResultView }
  | { readonly kind: "joined"; readonly task: TaskView }
  | { readonly kind: "failed"; readonly taskId: string; readonly code: ErrorCode; readonly detail?: string; readonly said?: string };

/**
 * 登记、开始、等结果。began 在登记上以后调，回 false 表示这期间点了停止：登记上的再取消一次，不开始写。
 */
export async function writeFromOfficial(api: Pick<PageApi, "send">, video: VideoKey, began: (task: TaskView) => boolean): Promise<OfficialVerdictOutcome> {
  const started = await api.send("task.start", { kind: "verdict", video });
  if (!started.ok) return { kind: "failed", taskId: "", code: started.code, ...(started.detail ? { detail: started.detail } : {}), ...(started.said ? { said: started.said } : {}) };
  const { task, joined, token } = started.value;
  if (joined || !token) return { kind: "joined", task };
  if (!began(task)) {
    await api.send("task.cancel", { taskId: task.id });
    return { kind: "failed", taskId: task.id, code: "TASK_CANCELED" };
  }
  const result = await api.send("verdict.fromOfficial", { video, token });
  if (result.ok) return { kind: "done", taskId: task.id, value: result.value };
  return { kind: "failed", taskId: task.id, code: result.code, ...(result.detail ? { detail: result.detail } : {}), ...(result.said ? { said: result.said } : {}) };
}
