// 用官方总结写一句话结论：还没有完整概览、或者概览没写出结论时，只发一次很小的请求，官方提纲当章节喂给结论提示词。
// 结论记下依据的是哪一版官方总结，和概览存在一起；之后依据字幕写的结论会把它换掉，反过来不行。已经有结论就原样交回，不再花一次钱。
// 同一个视频同时只写一份：等价的（同一版官方总结、同样的生成配置）接上在跑的那次，不等价的等它写完再看还要不要写。
// 停止只撤还没发出去的；已经发出去的照常等它回来、存下，钱已经花了。清除本机数据在开头、读完材料、发出之前和落库时各核对一次。
import { taskCanceledError } from "../../../core/ai/transport/index.ts";
import { hasOfficialSummaryContent, officialVerdictInputs } from "../../../core/ai/verdict.ts";
import type { ClearEpoch, ClearGuard } from "../../../core/clear-guard.ts";
import type { Limiter } from "../../../core/concurrency.ts";
import { fail, ok, type Failure, type Result } from "../../../core/errors.ts";
import { normalizeAnalysisFailures, type Basis, type OverviewPart, type OverviewRecord } from "../../../core/notes/records.ts";
import { equivalenceKey } from "../../../core/task-keys.ts";
import type { FrozenGen } from "../../../core/tasks.ts";
import { formatTimestamp } from "../../../core/transcript/segment.ts";
import { parseVideoKey, type VideoKey, type VideoRef } from "../../../core/video-ref.ts";
import type { Broadcast } from "../../../shared/messages.ts";
import type { OverviewResultView } from "../../../shared/messages/overview.ts";
import type { OfficialSummaryView, VideoInfoView } from "../../../shared/messages/transcript.ts";
import { AI_CONCURRENCY } from "../../../shared/settings-schema.ts";
import { aiFailure } from "../../ai.ts";
import { errorLabel, type Log } from "../../log.ts";
import type { OverviewStore } from "../../stores/overviews.ts";
import type { TaskRun, TaskRunner } from "../../tasks.ts";
import type { TranscriptService } from "../transcript/index.ts";
import { requestVerdict, VERDICT_PROMPT } from "./conclude.ts";
import { CLEARED, createPersist, type Saved, type SnapshotFields } from "./persist.ts";

export interface VerdictServiceDeps {
  readonly tasks: Pick<TaskRunner, "run" | "list">;
  readonly transcript: Pick<TranscriptService, "get">;
  readonly overviews: Pick<OverviewStore, "find" | "updateRecord">;
  readonly guard: ClearGuard;
  readonly prompt: (file: string) => string;
  /** 和概览服务共用的同一道并发闸门：几个视频、两种生成合起来不超过上限。 */
  readonly gate: Limiter;
  readonly concurrency?: number;
  readonly broadcast: (message: Broadcast) => void;
  readonly log: Log;
  readonly now: () => number;
}

export interface VerdictOptions {
  /** 排队之前记下的清除代数：排队期间清除了本机数据，轮到时也认得出来。不给时按认领那一刻算。 */
  readonly since?: ClearEpoch | undefined;
}

export interface VerdictService {
  /** 认领登记好的结论任务（侧边栏的「用官方总结写结论」、粗筛写结论），用官方总结写一句话结论。 */
  fromOfficial(taskId: string, video: VideoKey, options?: VerdictOptions): Promise<Result<OverviewResultView>>;
}

/** 认领得了的种类：侧边栏登记的结论、粗筛登记的写结论。 */
const VERDICT_KINDS: ReadonlySet<string> = new Set(["verdict", "triage-verdict"]);

/** 写结论的材料：视频信息、有内容的官方总结、字幕最后一句的起点（字幕读不到时是 0）。 */
interface Material {
  readonly info: VideoInfoView;
  readonly official: OfficialSummaryView & { readonly fingerprint: string };
  readonly lastStart: number;
}

/** 一次在途的写结论：几个任务一起等它，只要还有一个在等就不撤。 */
interface Shared {
  readonly key: string;
  readonly since: ClearEpoch | undefined;
  readonly waiting: Set<AbortSignal>;
  readonly queue: AbortController;
  result: Promise<Result<OverviewResultView>>;
}

/** 结论依据的那一版官方总结。 */
type OfficialBasis = Extract<Basis, { readonly source: "official-summary" }>;

// 平台明确说这个视频没有、不做官方总结：读不成字幕也照样这样说。
const NO_SUMMARY: ReadonlySet<string> = new Set(["none", "unsupported"]);

const genInfo = ({ feature, promptVersion, model, effort }: FrozenGen) => ({ feature, promptVersion, model, effort });

const hasVerdict = (record: OverviewRecord | null): record is OverviewRecord =>
  typeof record?.analysis.verdict?.summary === "string" && record.analysis.verdict.summary.trim() !== "";

/** 只带失败本身，不带读字幕失败时顺手带回的视频信息、字幕轨这些。 */
const bare = ({ code, detail, retryAfterSec }: Failure): Failure => ({
  ok: false,
  code,
  ...(detail === undefined ? {} : { detail }),
  ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
});

function storedView(video: VideoKey, record: OverviewRecord): OverviewResultView {
  const failures = normalizeAnalysisFailures(record.analysisFailures);
  return { video, analysis: record.analysis, analysisFailures: failures, fromCache: true, failedChunks: failures.length };
}

function savedView(video: VideoKey, saved: Saved): OverviewResultView {
  return {
    video,
    analysis: saved.analysis,
    analysisFailures: [...saved.analysisFailures],
    fromCache: false,
    failedChunks: saved.analysisFailures.length,
    ...(saved.saveFailed ? { saveFailed: true } : {}),
  };
}

/** 等一次在途的写完；自己先被停了就不等。交回是不是被停了。 */
function settledOrStopped(result: Promise<unknown>, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const stop = (): void => resolve(true);
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    void result.finally(() => {
      signal.removeEventListener("abort", stop);
      resolve(false);
    });
  });
}

export function createVerdictService(deps: VerdictServiceDeps): VerdictService {
  const { guard, log } = deps;
  const concurrency = deps.concurrency ?? AI_CONCURRENCY;
  const persist = createPersist({ overviews: deps.overviews, now: deps.now, log });
  const inflight = new Map<VideoKey, Shared>();
  // 每个视频写完过几次：读本机记录到决定发请求之间有别的写完了，要回去重读，免得为已经有的结论再付一次。
  const rounds = new Map<VideoKey, number>();
  const roundOf = (video: VideoKey): number => rounds.get(video) ?? 0;
  const cleared = (since: ClearEpoch | undefined): boolean => guard.clearedSince(since, "all");

  async function materialOf(ref: VideoRef): Promise<Result<Material>> {
    const reply = await deps.transcript.get(ref, { mode: "full" });
    // 读不成字幕时带回来的视频信息和官方总结照样能用：没有字幕的视频往往只有官方总结。
    const info = reply.ok ? reply.value.info : reply.info;
    const official = reply.ok ? reply.value.official : reply.official;
    const fingerprint = official?.status === "ok" && hasOfficialSummaryContent(official) ? official.fingerprint : undefined;
    if (official && fingerprint && info) {
      const segments = reply.ok ? reply.value.transcript.segments : [];
      return ok({ info, official: { ...official, fingerprint }, lastStart: Math.floor(Number(segments.at(-1)?.start) || 0) });
    }
    if (!reply.ok && !NO_SUMMARY.has(official?.status ?? "")) return bare(reply);
    return fail("NO_OFFICIAL_SUMMARY");
  }

  // 结论请求和落库。从不抛错。只认 queue：最后一个等着的也停了才撤，而且只撤还没发出去的。
  async function write(run: TaskRun, video: VideoKey, material: Material, basis: OfficialBasis, since: ClearEpoch | undefined, queue: AbortSignal): Promise<Result<OverviewResultView>> {
    const { info, official } = material;
    const variables = {
      videoTitle: info.title || "未知",
      ownerName: info.author || "未知",
      videoDescription: info.description || "（无简介）",
      durationFormatted: formatTimestamp(Math.max(Math.floor(Number(info.durationSec) || 0), material.lastStart)),
      ...officialVerdictInputs(official),
    };
    let verdict;
    try {
      // 官方总结覆盖全片，不受概览失败块影响，不标不完整。
      verdict = await requestVerdict(
        { ai: run.ai, prompt: deps.prompt(VERDICT_PROMPT), gate: deps.gate, concurrency, log },
        { variables, queueSignal: queue, stillWanted: () => !cleared(since) },
      );
    } catch (error) {
      const canceled = (error as { readonly code?: unknown } | null)?.code === "TASK_CANCELED" || queue.aborted || cleared(since);
      if (canceled) return fail("TASK_CANCELED");
      log.error("用官方总结写结论失败", errorLabel(error));
      return aiFailure(error);
    }
    if (!verdict) return fail("EMPTY_VERDICT");
    if (cleared(since)) return fail("TASK_CANCELED");
    const written = { ...verdict, source: "official" };
    const part: OverviewPart = { derived: { basis, gen: genInfo(run.gen) }, taskCreatedAt: run.createdAt };
    const fields: SnapshotFields = { video, title: info.title, author: info.author };
    // 存不下也把结论交回去：请求已经付过费。
    const intended: Saved = { analysis: { chapters: [], keyQuotes: [], verdict: written }, analysisFailures: [] };
    const saved = await persist.official(fields, { verdict: written, part }, intended, since);
    if (saved === CLEARED) return fail("TASK_CANCELED");
    if (!saved.superseded && !saved.saveFailed) deps.broadcast({ type: "overview.updated", video, verdictPending: false });
    return ok(savedView(video, saved));
  }

  function launch(run: TaskRun, video: VideoKey, key: string, material: Material, basis: OfficialBasis, since: ClearEpoch | undefined): Shared {
    const queue = new AbortController();
    const shared: Shared = { key, since, waiting: new Set(), queue, result: Promise.resolve(fail("TASK_CANCELED")) };
    shared.result = write(run, video, material, basis, since, queue.signal).finally(() => {
      rounds.set(video, roundOf(video) + 1);
      if (inflight.get(video) === shared) inflight.delete(video);
    });
    inflight.set(video, shared);
    return shared;
  }

  // 一起等一次在途的写。自己被停了：还有别人在等就先按取消走，请求照常写完给别人；自己是最后一个就撤掉还没发出去的，发出去的等它回来。
  function attend(shared: Shared, signal: AbortSignal): Promise<Result<OverviewResultView>> {
    shared.waiting.add(signal);
    return new Promise((resolve) => {
      const leave = (): void => {
        shared.waiting.delete(signal);
        if (shared.waiting.size > 0) resolve(fail("TASK_CANCELED"));
        else shared.queue.abort(taskCanceledError());
      };
      if (signal.aborted) leave();
      else signal.addEventListener("abort", leave, { once: true });
      void shared.result.then((result) => {
        signal.removeEventListener("abort", leave);
        shared.waiting.delete(signal);
        resolve(result);
      });
    });
  }

  async function work(run: TaskRun, video: VideoKey, ref: VideoRef, since: ClearEpoch | undefined): Promise<Result<OverviewResultView>> {
    const stopped = (): boolean => run.signal.aborted || cleared(since);
    for (;;) {
      const round = roundOf(video);
      if (stopped()) return fail("TASK_CANCELED");
      const existing = await deps.overviews.find(video);
      if (cleared(since)) return fail("TASK_CANCELED");
      if (hasVerdict(existing)) return ok(storedView(video, existing));
      const material = await materialOf(ref);
      if (stopped()) return fail("TASK_CANCELED");
      if (!material.ok) return material;
      const basis: OfficialBasis = { source: "official-summary", video, fingerprint: material.value.official.fingerprint };
      // 种类不进这把键：侧边栏的结论和粗筛写结论写的是同一份。
      const key = await equivalenceKey({ kind: "verdict", video, basis, gen: run.gen });
      // 算键的工夫被停了：闸门有空位时请求会立刻发出去、撤不回来，这里就收手。
      if (stopped()) return fail("TASK_CANCELED");
      const busy = inflight.get(video);
      const writing = (): void => run.progress({ done: 0, total: 1, phase: "verdict", message: "正在写一句话结论…" });
      if (busy && busy.key === key && !cleared(busy.since)) {
        writing();
        return attend(busy, run.signal);
      }
      if (busy) {
        if (await settledOrStopped(busy.result, run.signal)) return fail("TASK_CANCELED");
        continue;
      }
      if (roundOf(video) !== round) continue;
      writing();
      return attend(launch(run, video, key, material.value, basis, since), run.signal);
    }
  }

  return {
    fromOfficial(taskId, video, { since: queued } = {}) {
      const ref = parseVideoKey(video);
      if (!ref) return Promise.resolve(fail("INVALID_REQUEST"));
      // 只认登记成结论、而且是这个视频的任务：拿别的任务号开始，就绕过了登记时的核对。
      const task = deps.tasks.list().find((entry) => entry.id === taskId);
      if (!task || !VERDICT_KINDS.has(task.kind) || task.video !== video) return Promise.resolve(fail("TASK_NOT_FOUND"));
      const since = queued ?? guard.epoch();
      return deps.tasks.run(taskId, (run) => work(run, video, ref, since), { autoFinish: true });
    },
  };
}
