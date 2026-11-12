// 批次服务：稍后再看粗筛和本窗口全部生成都在后台跑，页面经端口连着；本窗口全部生成的部分在 window.ts。
// 粗筛同一时间只跑一步，别的页面发来同一步就接上，发来别的一步就回正在跑。
// 第一步逐个读、两次请求之间隔 1.5 秒，被限流、连着要登录、这条读取路线读不了就整批停下；第二步同时最多 3 个，排在概览那道并发闸门后面。
// 订阅的页面都断开了、或者用户点了停止：不再开始新的条目，正在读的读完，已经发给模型的照常回来、存下，钱已经花了。
import type { ClearEpoch, ClearGuard } from "../../../core/clear-guard.ts";
import type { ErrorCode } from "../../../core/errors.ts";
import { OFFICIAL_INTERVAL_MS, officialTodo, runOfficialBatch, runVerdictBatch, verdictTodo, type Outcome, type SleepFn } from "../../../core/triage/batch.ts";
import { hasVerdict, type TriageVerdict } from "../../../core/triage/groups.ts";
import type { TriageItem } from "../../../core/triage/state.ts";
import type { KeepAlive } from "../../../platform/keepalive.ts";
import { isQuotaError } from "../../../platform/storage.ts";
import type { WindowTab } from "../../../platform/tabs.ts";
import type { BatchIn, BatchOut, TriageSnapshot, TriageStep, TriageStop, WindowIn } from "../../../shared/messages/batch.ts";
import type { SiteRules } from "../../../sites/types.ts";
import { AI_CONCURRENCY } from "../../../shared/settings-schema.ts";
import type { AiWiring } from "../../ai.ts";
import { errorLabel, type Log } from "../../log.ts";
import type { OverviewStore } from "../../stores/overviews.ts";
import type { TriageStore } from "../../stores/triage.ts";
import type { TaskRunner, Timers } from "../../tasks.ts";
import type { OverviewService } from "../overview/index.ts";
import type { VerdictService } from "../overview/verdict.ts";
import type { SiteAccess } from "../transcript/read.ts";
import type { TranscriptService } from "../transcript/index.ts";
import { fetchOfficial, readList, verdictMaterial, verdictView, writeVerdict, type ItemOutcome, type VerdictRound, type WatchLaterDeps } from "./watch-later.ts";
import { createWindowBatch, type WindowBatch } from "./window.ts";

/** 一项读取最多撑着后台多久：两次平台请求各有自己的超时，这里再留足余量。 */
const ITEM_KEEPALIVE_MS = 2 * 60_000;

/** 收这一步消息的一方：经端口连着的页面。 */
export interface BatchListener {
  readonly id: string;
  readonly post: (event: BatchOut) => void;
}

export interface BatchService {
  /** 端口上来的一条消息：开始一步要等这一步结束才返回。 */
  handle(message: BatchIn, listener: BatchListener): Promise<void>;
  /** 页面断开了：退订；订阅的页面都走了，正在跑的那一步不再开始新的条目。 */
  leave(listenerId: string): void;
  /** 粗筛页要显示的：列表、官方总结、已经写好的结论和正在跑的那一步。 */
  state(): Promise<TriageSnapshot>;
}

export interface BatchServiceDeps {
  readonly triage: TriageStore;
  readonly sites: SiteAccess;
  readonly rules: readonly SiteRules[];
  /** 本窗口全部生成清点用：这个窗口里地址匹配得上视频页的标签页。 */
  readonly windowTabs: (windowId: number) => Promise<readonly WindowTab[]>;
  readonly transcript: Pick<TranscriptService, "get" | "ensure">;
  readonly overviews: Pick<OverviewStore, "find">;
  readonly overview: Pick<OverviewService, "generate" | "retryFailed">;
  readonly tasks: Pick<TaskRunner, "register" | "cancel" | "unsubscribe" | "list">;
  readonly verdict: Pick<VerdictService, "fromOfficial">;
  readonly ai: Pick<AiWiring, "configCheck" | "freeze">;
  readonly guard: ClearGuard;
  readonly keepAlive: KeepAlive;
  readonly timers: Pick<Timers, "now" | "setTimeout" | "clearTimeout">;
  /** 第二步同时写几个；默认和模型请求的并发上限一样。 */
  readonly concurrency?: number;
  readonly newId: () => string;
  readonly log: Log;
}

/** 在跑的一步。 */
interface Run {
  readonly id: string;
  readonly step: TriageStep;
  readonly listeners: Map<string, BatchListener>;
  /** 用户停止、页面都走了：不再开始新的条目。 */
  readonly halt: AbortController;
  readonly since: ClearEpoch | undefined;
  /** 第二步在跑的写结论任务。 */
  readonly taskIds: Set<string>;
  total: number;
  skipped: number;
  done: number;
  /** 列表在途中不在了。 */
  gone: boolean;
}

const isWindowIn = (message: BatchIn): message is WindowIn => message.type.startsWith("window.");

const unexpected = (error: unknown): ErrorCode => (isQuotaError(error) ? "STORAGE_FULL" : "BACKGROUND_FAILED");

export function createBatchService(deps: BatchServiceDeps): BatchService {
  const { guard, timers, log } = deps;
  const concurrency = deps.concurrency ?? AI_CONCURRENCY;
  const source: WatchLaterDeps = { triage: deps.triage, sites: deps.sites, transcript: deps.transcript, tasks: deps.tasks, verdict: deps.verdict, guard, now: timers.now };
  const material = verdictMaterial(source);
  let current: Run | null = null;

  // 两项之间的间隔按注入的计时器等，用户停止时马上结束。
  const sleep: SleepFn = (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const finish = (): void => {
        timers.clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        resolve();
      };
      const timer = timers.setTimeout(finish, ms);
      signal?.addEventListener("abort", finish, { once: true });
    });

  const windows: WindowBatch = createWindowBatch({
    rules: deps.rules,
    windowTabs: deps.windowTabs,
    overviews: deps.overviews,
    transcript: deps.transcript,
    overview: deps.overview,
    tasks: deps.tasks,
    ai: deps.ai,
    keepAlive: deps.keepAlive,
    sleep,
    now: timers.now,
    log,
  });

  function handleWindow(message: WindowIn, listener: BatchListener): Promise<void> {
    switch (message.type) {
      case "window.count":
        return windows.count(message.windowId, listener);
      case "window.start":
        return windows.start(message.windowId, listener);
      case "window.stop":
        windows.stop(message.windowId);
        return Promise.resolve();
      case "window.retry":
        return windows.retry(message.windowId, message.video, listener);
      case "window.watch":
        windows.watch(message.windowId, listener);
        return Promise.resolve();
      case "window.dismiss":
        windows.dismiss(message.windowId, listener);
        return Promise.resolve();
    }
  }

  function emit(run: Run, event: BatchOut): void {
    for (const listener of run.listeners.values()) {
      try {
        listener.post(event);
      } catch (error) {
        log.warn("粗筛的消息没送到页面", errorLabel(error));
      }
    }
  }

  async function verdictsOf(items: readonly TriageItem[]): Promise<Record<string, TriageVerdict>> {
    const verdicts: Record<string, TriageVerdict> = {};
    await Promise.all(
      items.map(async ({ videoKey }) => {
        const verdict = (await deps.overviews.find(videoKey))?.analysis.verdict;
        if (verdict && hasVerdict(verdictView(verdict))) verdicts[videoKey] = verdictView(verdict);
      }),
    );
    return verdicts;
  }

  async function state(): Promise<TriageSnapshot> {
    const triage = await deps.triage.read();
    return { list: triage.list, official: triage.official, verdicts: await verdictsOf(triage.list?.items ?? []), running: current?.step ?? null };
  }

  function stopOf(run: Run, stop: TriageStop | null): { readonly stop?: TriageStop } {
    if (stop) return { stop };
    return run.halt.signal.aborted && !run.gone ? { stop: "stopped" } : {};
  }

  async function runList(run: Run): Promise<void> {
    const read = await deps.keepAlive.during(ITEM_KEEPALIVE_MS, () => readList(source, run.since));
    if (!read.ok) return emit(run, { type: "triage.done", step: "list", done: 0, total: 1, failure: { code: read.code } });
    emit(run, { type: "triage.done", step: "list", done: 1, total: 1, state: await state(), dropped: read.value.dropped });
  }

  function itemEvent(run: Run, step: "official" | "verdict", item: TriageItem, outcome: Outcome<ItemOutcome>, done: number): void {
    run.done = done;
    if ("error" in outcome) {
      log.error("粗筛处理一个视频失败", errorLabel(outcome.error));
      return emit(run, { type: "triage.item", step, video: item.videoKey, done, failure: { code: unexpected(outcome.error) } });
    }
    if (outcome.listGone && !run.gone) {
      run.gone = true;
      run.halt.abort();
    }
    const { official, verdict, unavailable, failure } = outcome;
    emit(run, {
      type: "triage.item",
      step,
      video: item.videoKey,
      done,
      ...(official ? { official } : {}),
      ...(verdict ? { verdict } : {}),
      ...(unavailable ? { unavailable } : {}),
      ...(failure ? { failure: { code: failure.code } } : {}),
    });
  }

  function refuse(run: Run, code: ErrorCode): void {
    emit(run, { type: "triage.refused", step: run.step, failure: { code } });
  }

  async function runOfficial(run: Run): Promise<void> {
    const { list, official } = await deps.triage.read();
    if (!list) return refuse(run, "TRIAGE_LIST_CLEARED");
    const todo = officialTodo(list.items, official);
    Object.assign(run, { total: todo.length, skipped: list.items.length - todo.length });
    emit(run, { type: "triage.started", step: "official", total: run.total, skipped: run.skipped, joined: false });
    const result = await runOfficialBatch({
      items: todo,
      step: ({ item }) => deps.keepAlive.during(ITEM_KEEPALIVE_MS, () => fetchOfficial(source, item.videoKey, run.since)),
      signal: run.halt.signal,
      intervalMs: OFFICIAL_INTERVAL_MS,
      sleep,
      now: timers.now,
      onResult: (item, outcome, done) => itemEvent(run, "official", item, outcome, done),
    });
    emit(run, { type: "triage.done", step: "official", done: result.done, total: result.total, ...stopOf(run, result.stop), ...(run.gone ? { failure: { code: "TRIAGE_LIST_CLEARED" } } : {}) });
  }

  async function runVerdicts(run: Run): Promise<void> {
    const { list, official } = await deps.triage.read();
    if (!list) return refuse(run, "TRIAGE_LIST_CLEARED");
    const todo = verdictTodo(list.items, official, await verdictsOf(list.items));
    if (todo.length > 0 && !(await deps.ai.configCheck()).ready) return refuse(run, "NO_AI_CONFIG");
    const round: VerdictRound = { id: run.id, gen: await deps.ai.freeze("verdict"), since: run.since, taskIds: run.taskIds };
    Object.assign(run, { total: todo.length, skipped: list.items.length - todo.length });
    emit(run, { type: "triage.started", step: "verdict", total: run.total, skipped: run.skipped, joined: false });
    const elsewhere: TriageItem[] = [];
    const result = await runVerdictBatch({
      items: todo,
      step: (request) => writeVerdict(source, request, round, material),
      concurrency,
      signal: run.halt.signal,
      onResult(item, outcome, done) {
        if (!("error" in outcome) && outcome.elsewhere) elsewhere.push(item);
        itemEvent(run, "verdict", item, outcome, done);
      },
    });
    // 别处同时在写的：这一轮结束时读一次，写好了就摆出来；没读到的再点开始会接着写。
    const written = await verdictsOf(elsewhere);
    for (const item of elsewhere) {
      const verdict = written[item.videoKey];
      if (verdict) emit(run, { type: "triage.item", step: "verdict", video: item.videoKey, done: run.done, verdict });
    }
    emit(run, { type: "triage.done", step: "verdict", done: result.done, total: result.total, ...stopOf(run, null) });
  }

  async function start(step: TriageStep, listener: BatchListener): Promise<void> {
    const busy = current;
    if (busy) {
      // 同一步还在正常跑就接上；在收尾（停止了、页面走过）或者是另一步，都回正在跑，等它结束再点。
      if (busy.step !== step || busy.halt.signal.aborted) {
        listener.post({ type: "triage.refused", step, failure: { code: "BATCH_RUNNING" } });
        return;
      }
      busy.listeners.set(listener.id, listener);
      listener.post({ type: "triage.started", step, total: busy.total, skipped: busy.skipped, joined: true });
      return;
    }
    const run: Run = {
      id: `batch-${deps.newId()}`,
      step,
      listeners: new Map([[listener.id, listener]]),
      halt: new AbortController(),
      since: guard.epoch(),
      taskIds: new Set(),
      total: 0,
      skipped: 0,
      done: 0,
      gone: false,
    };
    current = run;
    try {
      if (step === "list") await runList(run);
      else if (step === "official") await runOfficial(run);
      else await runVerdicts(run);
    } catch (error) {
      log.error("粗筛这一步没做完", errorLabel(error));
      emit(run, { type: "triage.done", step, done: run.done, total: run.total, failure: { code: unexpected(error) } });
    } finally {
      if (current === run) current = null;
    }
  }

  // 停下这一步：不再开始新的条目；写结论还在排队的撤掉，已经发出去的照常回来。
  function halt(run: Run, pagesLeft: boolean): void {
    run.halt.abort();
    if (pagesLeft) deps.tasks.unsubscribe(run.id);
    else for (const taskId of [...run.taskIds]) deps.tasks.cancel(taskId);
  }

  return {
    handle(message, listener) {
      if (isWindowIn(message)) return handleWindow(message, listener);
      if (message.type === "triage.stop") {
        if (current?.listeners.has(listener.id)) halt(current, false);
        return Promise.resolve();
      }
      return message.type === "triage.start" ? start(message.step, listener) : Promise.resolve();
    },
    leave(listenerId) {
      windows.leave(listenerId);
      const run = current;
      if (!run?.listeners.delete(listenerId) || run.listeners.size > 0) return;
      halt(run, true);
    },
    state,
  };
}
