// 概览服务：认领页面登记好的概览任务并跑完，补失败块，读本机已有的概览。任务表在后台，进度只走任务中心；
// 整个任务期间保活，每次模型请求经任务的入口另有一份保活，发起页面关掉也照常跑完。
import type { ChunkPlanOptions } from "../../../core/ai/chunking.ts";
import type { ClearGuard } from "../../../core/clear-guard.ts";
import type { Limiter } from "../../../core/concurrency.ts";
import { ok, type Result } from "../../../core/errors.ts";
import type { VideoKey } from "../../../core/video-ref.ts";
import type { Broadcast } from "../../../shared/messages.ts";
import type { OverviewGetView, OverviewResultView } from "../../../shared/messages/overview.ts";
import { AI_CONCURRENCY } from "../../../shared/settings-schema.ts";
import { errorLabel, type Log } from "../../log.ts";
import type { OverviewStore } from "../../stores/overviews.ts";
import type { TaskRun, TaskRunner } from "../../tasks.ts";
import type { TranscriptService } from "../transcript/index.ts";
import { createClaim } from "../claim.ts";
import { createGenerator, type Job } from "./generate.ts";
import { overviewView } from "./view.ts";

export interface OverviewServiceDeps {
  readonly tasks: Pick<TaskRunner, "run" | "list">;
  readonly transcript: Pick<TranscriptService, "ensure">;
  readonly overviews: Pick<OverviewStore, "find" | "updateRecord">;
  readonly guard: ClearGuard;
  readonly prompt: (file: string) => string;
  readonly chunkOptions: () => Promise<ChunkPlanOptions>;
  readonly gate: Limiter;
  readonly concurrency?: number;
  readonly broadcast: (message: Broadcast) => void;
  readonly log: Log;
  readonly now: () => number;
}

export interface OverviewService {
  /** 认领登记好的概览任务：已有概览时直接交回，fresh 时重新生成。 */
  generate(taskId: string, video: VideoKey, options: { readonly fresh: boolean }): Promise<Result<OverviewResultView>>;
  /** 认领登记好的概览任务，只补失败区间。 */
  retryFailed(taskId: string, video: VideoKey): Promise<Result<OverviewResultView>>;
  /** 本机已有的概览，只交生效中的那份。 */
  get(video: VideoKey): Promise<Result<OverviewGetView>>;
}

export function createOverviewService(deps: OverviewServiceDeps): OverviewService {
  const generator = createGenerator({ ...deps, concurrency: deps.concurrency ?? AI_CONCURRENCY });

  const claimTask = createClaim(deps.tasks);

  // 只认登记成概览、而且是这个视频的任务：拿别的任务号开始，就绕过了登记时的核对。
  // 连点两下、两个面板登记接上了同一个任务，各自来开始：接上在跑的那次，每块只请求一遍模型。
  function claim(taskId: string, video: VideoKey, work: (job: Job) => Promise<Result<OverviewResultView>>): Promise<Result<OverviewResultView>> {
    const since = deps.guard.epoch();
    return claimTask(taskId, "overview", video, (run: TaskRun) => work({ run, taskId, video, since }));
  }

  return {
    generate: (taskId, video, { fresh }) => claim(taskId, video, (job) => generator.generate(job, fresh)),
    retryFailed: (taskId, video) => claim(taskId, video, (job) => generator.retryFailed(job)),
    async get(video) {
      try {
        const overview = overviewView(await deps.overviews.find(video));
        return ok(overview ? { video, overview } : { video });
      } catch (error) {
        deps.log.warn("读本机概览失败", errorLabel(error));
        return ok({ video });
      }
    },
  };
}
