// 概览服务：认领页面登记好的概览任务并跑完，补失败块，读本机已有的概览。任务表在后台，进度只走任务中心；
// 整个任务期间保活，每次模型请求经任务的入口另有一份保活，发起页面关掉也照常跑完。
import type { ChunkPlanOptions } from "../../../core/ai/chunking.ts";
import type { ClearGuard } from "../../../core/clear-guard.ts";
import type { Limiter } from "../../../core/concurrency.ts";
import { ok, type Failure, type Result } from "../../../core/errors.ts";
import type { VideoKey } from "../../../core/video-ref.ts";
import type { Broadcast } from "../../../shared/messages.ts";
import type { OverviewGetView, OverviewResultView } from "../../../shared/messages/overview.ts";
import { AI_CONCURRENCY } from "../../../shared/settings-schema.ts";
import { errorLabel, type Log } from "../../log.ts";
import type { OverviewStore } from "../../stores/overviews.ts";
import type { TaskRun, TaskRunner } from "../../tasks.ts";
import type { TranscriptService } from "../transcript/index.ts";
import { createClaim } from "../claim.ts";
import { createCommentRead } from "../comments.ts";
import type { SiteAccess } from "../transcript/index.ts";
import { createGenerator, type Job } from "./generate.ts";
import { overviewView } from "./view.ts";

export interface OverviewServiceDeps {
  readonly tasks: Pick<TaskRunner, "run" | "list">;
  readonly transcript: Pick<TranscriptService, "ensure">;
  readonly overviews: Pick<OverviewStore, "find" | "updateRecord">;
  readonly guard: ClearGuard;
  readonly prompt: (file: string) => string;
  /** 分块大小；whole 是选了「尽量整份」，块太大失败时报错里提示换档。 */
  readonly chunkOptions: () => Promise<ChunkPlanOptions & { readonly whole?: boolean }>;
  readonly gate: Limiter;
  readonly concurrency?: number;
  readonly broadcast: (message: Broadcast) => void;
  readonly log: Log;
  readonly now: () => number;
  /** 站点读取，读评论区（PRD F23）用；构建开关关着时不用。 */
  readonly sites?: SiteAccess | undefined;
}

/** 这次生成要读评论区（PRD F23）：卡片、侧边栏点的和打开就出结论给，本窗口全部生成不给。YouTube 经这个标签页读。 */
export interface CommentOption {
  readonly tabId?: number | undefined;
}

export interface OverviewService {
  /** 认领登记好的概览任务：已有概览时直接交回，fresh 时重新生成。prepare 在认领以后、生成之前做，回失败就按它收尾。 */
  generate(taskId: string, video: VideoKey, options: { readonly fresh: boolean; readonly prepare?: () => Promise<Failure | null>; readonly comments?: CommentOption }): Promise<Result<OverviewResultView>>;
  /** 认领登记好的概览任务，只补失败区间。prepare 和生成的一样，在认领以后、补之前做。 */
  retryFailed(taskId: string, video: VideoKey, options?: { readonly prepare?: () => Promise<Failure | null> }): Promise<Result<OverviewResultView>>;
  /** 本机已有的概览，只交生效中的那份。 */
  get(video: VideoKey): Promise<Result<OverviewGetView>>;
}

export function createOverviewService(deps: OverviewServiceDeps): OverviewService {
  // 读评论区（PRD F23）：关掉开关的构建里连同读评论的代码一起裁掉。
  const comments = FEATURE_COMMENTS && deps.sites ? createCommentRead(deps.sites) : undefined;
  const generator = createGenerator({ ...deps, concurrency: deps.concurrency ?? AI_CONCURRENCY, comments });

  const claimTask = createClaim(deps.tasks);

  // 只认登记成概览、而且是这个视频的任务：拿别的任务号开始，就绕过了登记时的核对。
  // 连点两下、两个面板登记接上了同一个任务，各自来开始：接上在跑的那次，每块只请求一遍模型。
  function claim(taskId: string, video: VideoKey, work: (job: Job) => Promise<Result<OverviewResultView>>, comments?: CommentOption): Promise<Result<OverviewResultView>> {
    const since = deps.guard.epoch();
    return claimTask(taskId, "overview", video, (run: TaskRun) => work({ run, taskId, video, since, ...(comments ? { comments } : {}) }));
  }

  return {
    generate: (taskId, video, { fresh, prepare, comments }) =>
      claim(
        taskId,
        video,
        async (job) => {
          const notReady = prepare ? await prepare() : null;
          return notReady ?? generator.generate(job, fresh);
        },
        comments,
      ),
    retryFailed: (taskId, video, { prepare } = {}) =>
      claim(taskId, video, async (job) => {
        const notReady = prepare ? await prepare() : null;
        return notReady ?? generator.retryFailed(job);
      }),
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
