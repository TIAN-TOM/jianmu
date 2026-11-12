// 本窗口全部生成，分两段。确认前只在本机清点，跟着页面走：只看标签页的地址和标题、本机已有的概览和任务表，不向平台读，
// 清点结果记在发起清点的端口上，端口断开就忘掉。确认后不跟页面走：后台逐个读字幕（两项之间有间隔，被限流、连着要登录、
// 读取路线读不了就整批停下），读到了就登记一个概览任务交给概览服务，模型请求和单个概览排同一道并发闸门；
// 关掉侧边栏照常做完，重开时按窗口接上。只认 B 站的视频，同一个视频同一分 P 只算一次。这一批只记在内存里。
import { hasAnalysisContent } from "../../../core/ai/verdict.ts";
import type { ErrorCode, Result } from "../../../core/errors.ts";
import { OFFICIAL_INTERVAL_MS, runPaced, type BatchStop, type PacedOutcome, type SleepFn } from "../../../core/triage/batch.ts";
import { parseVideoKey, videoKey, type VideoKey } from "../../../core/video-ref.ts";
import type { KeepAlive } from "../../../platform/keepalive.ts";
import type { WindowTab } from "../../../platform/tabs.ts";
import type { WindowCountItem, WindowEntryStatus, WindowEntryView, WindowOut, WindowRunView } from "../../../shared/messages/batch.ts";
import type { OverviewResultView } from "../../../shared/messages/overview.ts";
import type { SiteRules } from "../../../sites/types.ts";
import type { AiWiring } from "../../ai.ts";
import { errorLabel, type Log } from "../../log.ts";
import type { OverviewStore } from "../../stores/overviews.ts";
import type { TaskRunner } from "../../tasks.ts";
import type { OverviewService } from "../overview/index.ts";
import type { TranscriptService } from "../transcript/index.ts";

/** 读一个视频的字幕最多撑着后台多久：平台请求各有自己的超时，这里再留足余量。 */
const READ_KEEPALIVE_MS = 2 * 60_000;

export interface WindowListener {
  readonly id: string;
  readonly post: (event: WindowOut) => void;
}

export interface WindowBatchDeps {
  readonly rules: readonly SiteRules[];
  /** 这个窗口里地址匹配得上视频页的标签页。 */
  readonly windowTabs: (windowId: number) => Promise<readonly WindowTab[]>;
  readonly overviews: Pick<OverviewStore, "find">;
  readonly transcript: Pick<TranscriptService, "ensure">;
  readonly overview: Pick<OverviewService, "generate" | "retryFailed">;
  readonly tasks: Pick<TaskRunner, "register" | "cancel" | "list">;
  readonly ai: Pick<AiWiring, "configCheck" | "freeze">;
  readonly keepAlive: KeepAlive;
  readonly sleep: SleepFn;
  readonly now: () => number;
  readonly log: Log;
}

export interface WindowBatch {
  count(windowId: number, listener: WindowListener): Promise<void>;
  start(windowId: number, listener: WindowListener): Promise<void>;
  stop(windowId: number): void;
  retry(windowId: number, video: VideoKey, listener: WindowListener): Promise<void>;
  watch(windowId: number, listener: WindowListener): void;
  dismiss(windowId: number, listener: WindowListener): void;
  /** 端口断开：忘掉它的清点、退订各窗口的推送。已经确认的这一批照常做完。 */
  leave(listenerId: string): void;
}

interface Entry {
  readonly video: VideoKey;
  readonly title: string;
  status: WindowEntryStatus;
  taskId?: string | undefined;
  failure?: ErrorCode | undefined;
  partial?: boolean | undefined;
  /** 全部停止时记下：还在读字幕、没登记任务的这一条，读完也不再生成。 */
  stopRequested?: boolean | undefined;
}

interface Run {
  readonly windowId: number;
  readonly entries: Map<VideoKey, Entry>;
  readonly listeners: Map<string, WindowListener>;
  readonly halt: AbortController;
  stopping: boolean;
  stop?: BatchStop | undefined;
  /** 逐个读的那一圈还在走。 */
  pacing: boolean;
}

const SETTLED: ReadonlySet<WindowEntryStatus> = new Set<WindowEntryStatus>(["completed", "failed", "canceled", "skipped"]);
const RETRYABLE: ReadonlySet<WindowEntryStatus> = new Set<WindowEntryStatus>(["failed", "canceled"]);

/** B 站标签页的标题带着站名后缀，清单里只留视频名。 */
export function titleOfTab(title: string, fallback: string): string {
  const trimmed = title.replace(/[_-]哔哩哔哩.*$/u, "").trim();
  return trimmed || fallback;
}

export function createWindowBatch(deps: WindowBatchDeps): WindowBatch {
  const { log } = deps;
  // 只认 B 站：YouTube 标签页的清点和跳过随 YouTube 一起做。
  const rules = deps.rules.filter((rule) => rule.platform === "bilibili");
  const runs = new Map<number, Run>();
  /** 每个端口最近一次清点的结果，按窗口记。 */
  const counted = new Map<string, Map<number, readonly WindowCountItem[]>>();

  function videoOf(url: string): VideoKey | null {
    for (const rule of rules) {
      const ref = rule.parseWatchUrl(url);
      if (!ref) continue;
      try {
        return videoKey(ref);
      } catch {
        return null;
      }
    }
    return null;
  }

  const busy = (run: Run): boolean => run.pacing || [...run.entries.values()].some((entry) => !SETTLED.has(entry.status));

  function view(run: Run): WindowRunView {
    const entries = [...run.entries.values()].map(
      ({ video, title, status, taskId, failure, partial }): WindowEntryView => ({
        video,
        title,
        status,
        ...(taskId && status === "running" ? { taskId } : {}),
        ...(failure && status === "failed" ? { failure: { code: failure } } : {}),
        ...(partial && status === "completed" ? { partial: true } : {}),
      }),
    );
    return { entries, stopping: run.stopping && busy(run), ...(run.stop ? { stop: run.stop } : {}) };
  }

  function post(listener: WindowListener, event: WindowOut): void {
    try {
      listener.post(event);
    } catch (error) {
      log.warn("本窗口全部生成的消息没送到页面", errorLabel(error));
    }
  }

  function publish(run: Run): void {
    const event: WindowOut = { type: "window.state", windowId: run.windowId, run: view(run) };
    for (const listener of run.listeners.values()) post(listener, event);
  }

  const refuse = (listener: WindowListener, windowId: number, code: ErrorCode): void => post(listener, { type: "window.refused", windowId, failure: { code } });

  function settle(run: Run, entry: Entry, result: Result<OverviewResultView>): void {
    entry.taskId = undefined;
    entry.failure = undefined;
    entry.partial = undefined;
    if (result.ok) {
      entry.status = result.value.canceled ? "canceled" : "completed";
      if (!result.value.canceled && result.value.failedChunks > 0) entry.partial = true;
    } else if (result.code === "TASK_CANCELED") {
      entry.status = "canceled";
    } else {
      entry.status = "failed";
      entry.failure = result.code;
    }
    publish(run);
  }

  /**
   * 登记一个概览任务、交给概览服务。任务不跟页面走：关掉侧边栏照常做完。同一个视频别处用同样的设置在生成就接上它，
   * 用别的设置在生成就跳过。生成在后台继续，这里不等它做完。
   */
  async function launch(run: Run, entry: Entry, mode: "generate" | "retry"): Promise<void> {
    const gen = await deps.ai.freeze("analysis");
    const stages = [await deps.ai.freeze("verdict")];
    const registered = await deps.tasks.register({ kind: "overview", origin: "batch", video: entry.video, gen, stages, followsPage: false }, {});
    if (!("task" in registered)) {
      entry.status = "skipped";
      publish(run);
      return;
    }
    const taskId = registered.task.id;
    entry.taskId = taskId;
    entry.status = "running";
    publish(run);
    const work = mode === "retry" ? deps.overview.retryFailed(taskId, entry.video) : deps.overview.generate(taskId, entry.video, { fresh: false });
    void work.then(
      (result) => settle(run, entry, result),
      (error: unknown) => {
        log.error("本窗口全部生成里一个视频没做完", errorLabel(error));
        settle(run, entry, { ok: false, code: "BACKGROUND_FAILED" });
      },
    );
  }

  const cancelEntry = (run: Run, entry: Entry): PacedOutcome => {
    entry.status = "canceled";
    publish(run);
    return { requested: false };
  };

  /** 逐个读字幕的一项：读到了才登记任务。读不成的码交给停止规则。 */
  async function step(run: Run, entry: Entry): Promise<PacedOutcome> {
    const ref = parseVideoKey(entry.video);
    if (!ref || entry.stopRequested || run.halt.signal.aborted) return cancelEntry(run, entry);
    entry.status = "running";
    publish(run);
    const snapshot = await deps.keepAlive.during(READ_KEEPALIVE_MS, () => deps.transcript.ensure(ref));
    if (!snapshot.ok) {
      entry.status = "failed";
      entry.failure = snapshot.code;
      publish(run);
      // 取字幕服务交回的失败不带影响范围：格式不对时按整体读不了算，整批停下。
      return { requested: true, failure: { code: snapshot.code } };
    }
    if (entry.stopRequested) return { ...cancelEntry(run, entry), requested: true };
    await launch(run, entry, "generate");
    return { requested: true };
  }

  async function pace(run: Run): Promise<void> {
    run.pacing = true;
    try {
      const result = await runPaced([...run.entries.values()], (entry) => step(run, entry), {
        signal: run.halt.signal,
        intervalMs: OFFICIAL_INTERVAL_MS,
        sleep: deps.sleep,
        now: deps.now,
        onResult(entry, outcome) {
          if (!("error" in outcome)) return;
          log.error("本窗口全部生成读字幕失败", errorLabel(outcome.error));
          entry.status = "failed";
          entry.failure = "BACKGROUND_FAILED";
        },
      });
      if (result.stop) run.stop = result.stop;
    } finally {
      run.pacing = false;
      // 停下了（用户停止或整批停下）：没轮到的都算停掉，列在下面可以单独重来。
      for (const entry of run.entries.values()) if (entry.status === "pending") entry.status = "canceled";
      publish(run);
    }
  }

  return {
    async count(windowId, listener) {
      const mine = counted.get(listener.id) ?? new Map<number, readonly WindowCountItem[]>();
      counted.set(listener.id, mine);
      const tabs = await deps.windowTabs(windowId);
      const seen = new Map<VideoKey, WindowTab>();
      for (const tab of tabs) {
        const video = videoOf(tab.url);
        if (video && !seen.has(video)) seen.set(video, tab);
      }
      const running = new Set(deps.tasks.list().filter((task) => task.kind === "overview" && task.state === "running").map((task) => task.video));
      const items: WindowCountItem[] = [];
      for (const [video, tab] of seen) {
        // 只用官方总结写过结论的不算有概览：章节和金句都还没有。
        const existing = hasAnalysisContent((await deps.overviews.find(video))?.analysis);
        const state = existing ? "existing" : running.has(video) ? "running" : "to-generate";
        items.push({ video, title: titleOfTab(tab.title, parseVideoKey(video)?.videoId ?? video), state });
      }
      // 清点期间页面走了：不记，也不回。
      if (counted.get(listener.id) !== mine) return;
      mine.set(windowId, items);
      post(listener, { type: "window.counted", windowId, items });
    },

    async start(windowId, listener) {
      const current = runs.get(windowId);
      if (current && busy(current)) return refuse(listener, windowId, "BATCH_RUNNING");
      const items = counted.get(listener.id)?.get(windowId)?.filter((item) => item.state === "to-generate") ?? [];
      if (items.length === 0) return refuse(listener, windowId, "BATCH_NOT_COUNTED");
      if (!(await deps.ai.configCheck()).ready) return refuse(listener, windowId, "NO_AI_CONFIG");
      // 等配置检查的工夫别的页面已经开了一批。
      const again = runs.get(windowId);
      if (again && busy(again)) return refuse(listener, windowId, "BATCH_RUNNING");
      counted.get(listener.id)?.delete(windowId);
      const run: Run = {
        windowId,
        entries: new Map(items.map((item) => [item.video, { video: item.video, title: item.title, status: "pending" as const }])),
        listeners: new Map([...(again?.listeners ?? []), [listener.id, listener]]),
        halt: new AbortController(),
        stopping: false,
        pacing: false,
      };
      runs.set(windowId, run);
      publish(run);
      await pace(run);
    },

    stop(windowId) {
      const run = runs.get(windowId);
      if (!run || !busy(run)) return;
      run.stopping = true;
      run.halt.abort();
      for (const entry of run.entries.values()) {
        if (entry.status !== "running") continue;
        entry.stopRequested = true;
        if (entry.taskId) deps.tasks.cancel(entry.taskId);
      }
      publish(run);
    },

    async retry(windowId, video, listener) {
      const run = runs.get(windowId);
      const entry = run?.entries.get(video);
      if (!run || !entry || !RETRYABLE.has(entry.status)) return;
      if (!(await deps.ai.configCheck()).ready) return refuse(listener, windowId, "NO_AI_CONFIG");
      if (!RETRYABLE.has(entry.status)) return;
      run.stopping = false;
      entry.stopRequested = undefined;
      entry.failure = undefined;
      entry.status = "running";
      publish(run);
      // 停掉时存下了一部分的，只补没做完的块；别的从头生成，读字幕交给概览服务自己做。
      const stored = await deps.overviews.find(video);
      const gaps = hasAnalysisContent(stored?.analysis) && (stored?.analysisFailures?.length ?? 0) > 0;
      await launch(run, entry, gaps ? "retry" : "generate");
    },

    watch(windowId, listener) {
      const run = runs.get(windowId);
      if (run) run.listeners.set(listener.id, listener);
      post(listener, { type: "window.state", windowId, run: run ? view(run) : null });
    },

    dismiss(windowId, listener) {
      const run = runs.get(windowId);
      if (run && !busy(run)) runs.delete(windowId);
      counted.get(listener.id)?.delete(windowId);
      const current = runs.get(windowId);
      post(listener, { type: "window.state", windowId, run: current ? view(current) : null });
    },

    leave(listenerId) {
      counted.delete(listenerId);
      for (const run of runs.values()) run.listeners.delete(listenerId);
    },
  };
}
