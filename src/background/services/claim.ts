// 认领页面登记好的任务并跑完：只认登记成这一种、而且是这个视频的任务；同一个任务号再来一次，
// 接上在跑的那次，不另跑一遍。连点两下登记接上了同一个任务，页面各自来开始，也只花一次钱。
import { fail, type Result } from "../../core/errors.ts";
import type { TaskKind } from "../../core/tasks.ts";
import { parseVideoKey, type VideoKey } from "../../core/video-ref.ts";
import type { TaskRun, TaskRunner } from "../tasks.ts";

export type Claim = <T>(taskId: string, kind: TaskKind, video: VideoKey, work: (run: TaskRun) => Promise<Result<T>>) => Promise<Result<T>>;

export function createClaim(tasks: Pick<TaskRunner, "run" | "list">): Claim {
  const running = new Map<string, Promise<Result<unknown>>>();
  return <T>(taskId: string, kind: TaskKind, video: VideoKey, work: (run: TaskRun) => Promise<Result<T>>): Promise<Result<T>> => {
    if (!parseVideoKey(video)) return Promise.resolve(fail("INVALID_REQUEST"));
    const joined = running.get(taskId);
    if (joined) return joined as Promise<Result<T>>;
    // 拿别的任务号开始，就绕过了登记时的核对。
    const task = tasks.list().find((entry) => entry.id === taskId);
    if (!task || task.kind !== kind || task.video !== video) return Promise.resolve(fail("TASK_NOT_FOUND"));
    const result = tasks.run(taskId, work, { autoFinish: true }).finally(() => running.delete(taskId));
    running.set(taskId, result);
    return result;
  };
}
