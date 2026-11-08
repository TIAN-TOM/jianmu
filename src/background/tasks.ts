// 任务运行：登记、认领、登记后没人认领就收尾、互斥键和等价键、跟着页面走的任务在页面都断开时停下，
// 整个任务和每次模型请求两层保活。任务表只在内存里：service worker 被终止后不恢复、不重发。
import { fail, type Result } from "../core/errors.ts";
import type { Basis } from "../core/notes/records.ts";
import { equivalenceKey, mutexKey } from "../core/task-keys.ts";
import {
  createTaskManager,
  type FrozenGen,
  type Task,
  type TaskEnd,
  type TaskKind,
  type TaskOrigin,
  type TaskProgress,
  type TaskView,
} from "../core/tasks.ts";
import type { VideoKey } from "../core/video-ref.ts";
import { keepAliveBudget, type KeepAlive } from "../platform/keepalive.ts";
import type { Broadcast } from "../shared/messages.ts";
import { EFFORT_TIMEOUT_SECONDS } from "../shared/settings-schema.ts";
import { aiFailure, type AiWiring, type TaskAi } from "./ai.ts";

/**
 * 登记和开始生成是页面的两次来回。页面夹在中间关掉、重载，任务登记了却永远等不到开始，
 * 一直「运行中」占着这个视频的键。各页面都是登记一回来马上开始，所以这么久还没认领就按取消收尾。
 */
export const CLAIM_MS = 15_000;

const HOLDING_KINDS: ReadonlySet<string> = new Set<TaskKind>(["triage-verdict", "batch"]);

/** 取消后、已经发出的那次收尾之前仍占着键：粗筛写结论、批次，以及自动生成发起的任务。 */
export const holdsKeyAfterCancel = (task: Pick<Task, "kind" | "origin">): boolean =>
  HOLDING_KINDS.has(task.kind) || task.origin === "auto";

/** 跟着页面走的任务，订阅它的页面都断开了：只停还没开始的部分，已经发出的请求由服务决定等不等。 */
export const PAGES_LEFT = Object.freeze({ code: "PAGES_LEFT" });

export interface TaskSpec {
  readonly kind: TaskKind;
  readonly origin: TaskOrigin;
  readonly video: VideoKey;
  /** 功能输入：问题、选区、补块的区间这类，规范化后进等价键。 */
  readonly input?: unknown;
  /** 翻译的目标语言，进互斥键。 */
  readonly lang?: string;
  readonly basis?: Basis;
  readonly gen: FrozenGen;
  /** 跟着页面走：订阅它的页面都断开了就停下还没开始的部分，也不用认领时限。 */
  readonly followsPage: boolean;
}

/** 谁跟着这个任务。经端口连着的页面记端口号，断开时退订；不记端口的（自动生成、批次、发完消息的页面）一直算在。 */
export interface Subscriber {
  readonly port?: string;
}

export type Registration =
  | { readonly task: TaskView; readonly joined: boolean }
  /** 互斥键被占着。自动生成和批次不排队，skipped 写着跳过的原因。 */
  | { readonly conflict: TaskView; readonly skipped?: string }
  /** 要新起一个任务时 admit 不放行。 */
  | { readonly refused: true };

export interface TaskRun {
  readonly signal: AbortSignal;
  readonly gen: FrozenGen;
  /** 这个任务发模型请求的唯一入口：按冻结的配置发，每次请求另有一份保活。 */
  readonly ai: TaskAi;
  readonly progress: (patch: TaskProgress) => void;
}

export interface TaskRunner {
  /** admit 只在真要新起一个任务时问，接上在跑的、撞上互斥键的都不问。 */
  register(spec: TaskSpec, subscriber: Subscriber, options?: { readonly admit?: () => boolean }): Promise<Registration>;
  /** 依据定下以后按完整的等价键再核对：和别的在跑的任务等价时交回那个任务。 */
  rekey(taskId: string, basis: Basis): Promise<{ readonly ok: true } | { readonly ok: false; readonly conflict?: TaskView }>;
  run<T>(taskId: string, work: (run: TaskRun) => Promise<Result<T>>, options?: { readonly autoFinish?: boolean }): Promise<Result<T>>;
  progress(taskId: string, patch: TaskProgress): void;
  finish(taskId: string, end?: TaskEnd): TaskView | null;
  cancel(taskId: string, reason?: unknown): TaskView | null;
  cancelAll(reason: unknown): void;
  /** 这个端口断开了：从它订阅的任务里退订。 */
  unsubscribe(port: string): void;
  list(): TaskView[];
}

export interface Timers {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  clearTimeout(timer: unknown): void;
}

export interface TaskRunnerDeps {
  readonly ai: Pick<AiWiring, "forTask">;
  readonly keepAlive: KeepAlive;
  readonly timers: Timers;
  readonly broadcast: (message: Broadcast) => void;
  readonly newId: () => string;
  /** 一份保活的上限，默认按冻结的推理档位的硬超时算。 */
  readonly budgetMs?: (gen: FrozenGen) => number;
}

interface Meta {
  spec: TaskSpec;
  equivalence: string;
  readonly ports: Set<string>;
  /** 有不记端口的订阅方：页面都断开也照常跑完。 */
  pinned: boolean;
  claimTimer: unknown;
}

const defaultBudget = (gen: FrozenGen): number => keepAliveBudget(EFFORT_TIMEOUT_SECONDS[gen.effort] * 1000);

const SKIPPED = "同一个视频已经有任务在跑，这次跳过";

export function createTaskRunner(deps: TaskRunnerDeps): TaskRunner {
  const { keepAlive, timers, newId } = deps;
  const budgetFor = deps.budgetMs ?? defaultBudget;
  const metas = new Map<string, Meta>();

  // 互斥键是后台内部的，不给页面。
  function viewWith(task: Task, { spec }: Meta): TaskView {
    const { key: _key, finishing, ...rest } = task;
    return { ...rest, kind: spec.kind, origin: spec.origin, video: spec.video, ...(finishing === undefined ? {} : { finishing }) };
  }

  function view(task: Task): TaskView | null {
    const meta = metas.get(task.id);
    return meta ? viewWith(task, meta) : null;
  }

  const manager = createTaskManager({
    now: timers.now,
    holdKeyAfterCancel: holdsKeyAfterCancel,
    onChange(task) {
      const current = view(task);
      if (current) deps.broadcast({ type: "task.changed", task: current });
    },
  });

  // 任务离开任务表以后，把这边记的也清掉。
  function settle(id: string): void {
    if (manager.get(id)) return;
    const meta = metas.get(id);
    if (!meta) return;
    if (meta.claimTimer !== null) timers.clearTimeout(meta.claimTimer);
    metas.delete(id);
  }

  const shown = (task: Task): TaskView => view(task) as TaskView;

  function subscribe(meta: Meta, subscriber: Subscriber): void {
    if (subscriber.port === undefined) meta.pinned = true;
    else meta.ports.add(subscriber.port);
  }

  function watchClaim(id: string, meta: Meta): void {
    const timer = timers.setTimeout(() => {
      meta.claimTimer = null;
      if (manager.expireIfUnclaimed(id, { message: "没有收到生成请求，已停止" })) settle(id);
    }, CLAIM_MS);
    // Node 测试里别让计时器拖住进程。
    (timer as { unref?: () => void } | null)?.unref?.();
    meta.claimTimer = timer;
  }

  function cancel(taskId: string, reason?: unknown): TaskView | null {
    const meta = metas.get(taskId);
    const result = manager.cancel(taskId, reason === undefined ? {} : { reason });
    if (!result.success || !meta) return null;
    settle(taskId);
    return viewWith(result.task, meta);
  }

  return {
    async register(spec, subscriber, { admit } = {}) {
      const equivalence = await equivalenceKey(spec);
      const mutex = mutexKey(spec);
      // 从这里起没有等待：判断和登记之间不会插进别的登记。
      for (const task of manager.list()) {
        const meta = metas.get(task.id);
        if (task.state !== "running" || meta?.equivalence !== equivalence) continue;
        subscribe(meta, subscriber);
        return { task: shown(task), joined: true };
      }
      const holder = mutex === null ? null : manager.occupant(mutex);
      if (holder) {
        const conflict = shown(holder);
        return spec.origin === "auto" || spec.origin === "batch" ? { conflict, skipped: SKIPPED } : { conflict };
      }
      if (admit && !admit()) return { refused: true };
      const id = newId();
      const meta: Meta = { spec, equivalence, ports: new Set(), pinned: false, claimTimer: null };
      subscribe(meta, subscriber);
      metas.set(id, meta);
      const started = manager.start({ id, kind: spec.kind, origin: spec.origin, key: mutex ?? `${spec.kind}#${id}` });
      if (!started.success) {
        metas.delete(id);
        return { conflict: shown(started.task) };
      }
      if (!spec.followsPage) watchClaim(id, meta);
      return { task: shown(started.task), joined: false };
    },

    async rekey(taskId, basis) {
      const meta = metas.get(taskId);
      if (!meta) return { ok: false };
      const spec = { ...meta.spec, basis };
      const equivalence = await equivalenceKey(spec);
      if (metas.get(taskId) !== meta) return { ok: false };
      for (const task of manager.list()) {
        if (task.id === taskId || task.state !== "running" || metas.get(task.id)?.equivalence !== equivalence) continue;
        return { ok: false, conflict: shown(task) };
      }
      meta.spec = spec;
      meta.equivalence = equivalence;
      return { ok: true };
    },

    async run<T>(
      taskId: string,
      work: (run: TaskRun) => Promise<Result<T>>,
      { autoFinish = false }: { readonly autoFinish?: boolean } = {},
    ): Promise<Result<T>> {
      const signal = manager.claim(taskId);
      if (!signal) return fail("TASK_NOT_FOUND");
      const meta = metas.get(taskId);
      // 开始之前任务已经被取消（别处点了停止、清除本机数据）：不再取字幕、不发请求，直接按取消收尾。
      if (!meta || signal.aborted) {
        if (meta && autoFinish) {
          manager.finish(taskId, { state: "canceled", message: "已取消" });
          settle(taskId);
        }
        return fail("TASK_CANCELED");
      }
      if (meta.claimTimer !== null) {
        timers.clearTimeout(meta.claimTimer);
        meta.claimTimer = null;
      }
      const { gen } = meta.spec;
      const budget = budgetFor(gen);
      const bound = deps.ai.forTask(gen);
      const ai: TaskAi = {
        requestAiCompletion: (request) => keepAlive.during(budget, () => bound.requestAiCompletion(request)),
      };
      // 整个任务期间保活：取字幕、排队、两次请求之间的落库都算在内，发起页面关掉也照常跑完。
      const release = keepAlive.hold(budget);
      let result: Result<T>;
      try {
        result = await work({ signal, gen, ai, progress: (patch) => void manager.progress(taskId, patch) });
      } catch (error) {
        result = signal.aborted ? fail("TASK_CANCELED") : aiFailure(error);
      } finally {
        release();
      }
      if (autoFinish) {
        const canceled = signal.aborted;
        manager.finish(taskId, {
          state: canceled ? "canceled" : result.ok ? "completed" : "failed",
          message: canceled ? "已取消" : result.ok ? "已完成" : "生成失败",
        });
        settle(taskId);
      }
      return result;
    },

    progress(taskId, patch) {
      manager.progress(taskId, patch);
    },

    finish(taskId, end) {
      const task = manager.finish(taskId, end);
      const result = task ? view(task) : null;
      settle(taskId);
      return result;
    },

    cancel,

    cancelAll(reason) {
      for (const task of manager.list()) cancel(task.id, reason);
    },

    unsubscribe(port) {
      for (const [id, meta] of [...metas]) {
        if (!meta.ports.delete(port)) continue;
        if (meta.spec.followsPage && !meta.pinned && meta.ports.size === 0) cancel(id, PAGES_LEFT);
      }
    },

    list: () => manager.list().map(shown),
  };
}
