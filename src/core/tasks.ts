// AI 任务生命周期：去重、进度、取消与状态广播。保活在 platform/keepalive.ts。
import type { Effort, FeatureId } from "./notes/records.ts";
import type { VideoKey } from "./video-ref.ts";

export type TaskState = "running" | "completed" | "failed" | "canceled";

/** 后台登记的任务种类。页面按它显示进度、决定跟不跟。 */
export type TaskKind = "overview" | "verdict" | "translate" | "qa" | "explain" | "frame-explain" | "triage-verdict" | "batch";

/** 谁发起的：用户在侧边栏或扩展页面、播放页卡片、自动生成、批量处理。 */
export type TaskOrigin = "user" | "card" | "auto" | "batch";

/** 给页面看的任务状态。互斥键是后台内部的，不给出去。 */
export interface TaskView {
  readonly id: string;
  readonly kind: TaskKind;
  readonly origin: TaskOrigin;
  readonly video: VideoKey;
  readonly state: TaskState;
  readonly done: number;
  readonly total: number;
  readonly phase: string;
  readonly message: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly finishing?: boolean;
}

/** 任务创建时取定的生成配置，跑到一半改设置也不影响这个任务。 */
export interface FrozenGen {
  readonly feature: FeatureId;
  readonly baseUrl: string;
  readonly model: string;
  readonly effort: Effort;
  readonly promptVersion: string;
}

export interface Task {
  readonly id: string;
  readonly kind: string;
  readonly origin: TaskOrigin;
  readonly key: string;
  readonly state: TaskState;
  readonly done: number;
  readonly total: number;
  readonly phase: string;
  readonly message: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly finishing?: boolean; // 取消时操作还在跑：收尾时还会再广播一次
}

export interface TaskStart {
  readonly id: string;
  readonly kind: string;
  readonly origin: TaskOrigin;
  readonly key: string;
}

export type TaskProgress = Partial<Pick<Task, "done" | "total" | "phase" | "message">>;

export interface TaskEnd {
  readonly state?: Exclude<TaskState, "running">;
  readonly message?: string;
}

export interface TaskCancel {
  readonly reason?: unknown;
}

export type TaskStartResult =
  | { readonly success: true; readonly task: Task }
  | {
      readonly success: false;
      readonly error: "TASK_ALREADY_RUNNING";
      readonly message: string;
      readonly task: Task;
    };

export type TaskCancelResult =
  | { readonly success: true; readonly task: Task }
  | { readonly success: false; readonly error: "TASK_NOT_FOUND"; readonly message: string };

export interface TaskManagerDeps {
  readonly onChange?: (task: Task) => void;
  readonly now?: () => number;
  /** 哪些任务取消后、已经开始的操作收尾之前仍占着键。 */
  readonly holdKeyAfterCancel?: (task: Task) => boolean;
}

export interface TaskManager {
  start(task: TaskStart): TaskStartResult;
  progress(id: string, patch?: TaskProgress): Task | null;
  cancel(id: string, options?: TaskCancel): TaskCancelResult;
  finish(id: string, end?: TaskEnd): Task | null;
  claim(id: string): AbortSignal | null;
  expireIfUnclaimed(id: string, end?: TaskEnd): Task | null;
  /** 占着这个键的任务：还在跑的，或者取消后操作还没收尾、要占键的。 */
  occupant(key: string): Task | null;
  get(id: string): Task | null;
  signal(id: string): AbortSignal | null;
  list(): Task[];
}

type TaskEntry = { -readonly [Field in keyof Task]: Task[Field] } & {
  readonly controller: AbortController;
  operating?: boolean;
};

function snapshot(entry: TaskEntry): Task;
function snapshot(entry: TaskEntry | undefined): Task | null;
function snapshot(entry: TaskEntry | undefined): Task | null {
  if (!entry) return null;
  const { controller, operating, ...task } = entry;
  return { ...task };
}

/**
 * holdKeyAfterCancel 认下的任务，取消只撤还没开始的那一步，已经在跑的操作照常跑完
 * （粗筛写结论：已经发给模型的照常等它回来、存下结论）。这次操作收尾（finish）之前，
 * 它仍占着这个键：同一个目标再登记会被拦下，不为同一份结果再花一次钱。
 * 还没开始操作就取消的不占：那次操作可能永远不会来（页面已经关了），键不能一直占着。
 * 其他任务取消就是真停了，键马上让出来，比如侧边栏停掉概览后可以立刻重新生成。
 */
export function createTaskManager({
  onChange = () => {},
  now = () => Date.now(),
  holdKeyAfterCancel = () => false,
}: TaskManagerDeps = {}): TaskManager {
  const active = new Map<string, TaskEntry>();
  // 还没认领就取消或过期而删掉的任务，留下已中止的信号：迟到的生成请求认领时照样拿到
  // 「已取消」，页面显示的是停止，而不是「任务已经结束」。只留最近的一些，免得越积越多。
  const RETIRED_LIMIT = 50;
  const retired = new Map<string, AbortSignal>();
  const retire = (entry: TaskEntry): void => {
    retired.set(entry.id, entry.controller.signal);
    if (retired.size > RETIRED_LIMIT) retired.delete(retired.keys().next().value as string);
  };

  const occupiesKey = (entry: TaskEntry): boolean =>
    entry.state === "running" ||
    (entry.state === "canceled" && entry.operating === true && holdKeyAfterCancel(snapshot(entry)));

  const emit = (entry: TaskEntry): Task => {
    const task = snapshot(entry);
    try {
      onChange(task);
    } catch (error) {
      // 状态监听失败不影响实际任务。
    }
    return task;
  };

  const occupying = (key: string): TaskEntry | undefined =>
    [...active.values()].find((entry) => entry.key === key && occupiesKey(entry));

  function start({ id, kind, origin, key }: TaskStart): TaskStartResult {
    const duplicate = occupying(key);
    if (duplicate) {
      return {
        success: false,
        error: "TASK_ALREADY_RUNNING",
        message: "同一任务已经在运行。",
        task: snapshot(duplicate),
      };
    }

    const timestamp = now();
    const entry: TaskEntry = {
      id,
      kind,
      origin,
      key,
      state: "running",
      done: 0,
      total: 0,
      phase: "preparing",
      message: "正在准备…",
      createdAt: timestamp,
      updatedAt: timestamp,
      controller: new AbortController(),
    };
    active.set(id, entry);
    return { success: true, task: emit(entry) };
  }

  function progress(id: string, patch: TaskProgress = {}): Task | null {
    const entry = active.get(id);
    if (!entry || entry.state !== "running") return null;
    if (patch.done !== undefined) entry.done = patch.done;
    if (patch.total !== undefined) entry.total = patch.total;
    if (patch.phase !== undefined) entry.phase = patch.phase;
    if (patch.message !== undefined) entry.message = patch.message;
    entry.updatedAt = now();
    return emit(entry);
  }

  // reason：交给 AbortController 的原因，操作收尾时据此区分取消的来由
  // （比如「清除本机数据」时不能把已完成的部分写回去）。
  function cancel(id: string, { reason }: TaskCancel = {}): TaskCancelResult {
    const entry = active.get(id);
    if (!entry) {
      return { success: false, error: "TASK_NOT_FOUND", message: "任务已经结束。" };
    }
    if (entry.state !== "canceled") {
      entry.state = "canceled";
      entry.phase = "canceled";
      entry.message = "已取消";
      entry.updatedAt = now();
      // 操作还在跑：它收尾（比如概览存下已完成的块）时 finish 会再广播一次。
      // 跟着这个任务的页面看到 finishing 就等那一次再重读，不然读到的是还没存的缓存。
      entry.finishing = entry.operating === true;
      if (reason === undefined) entry.controller.abort();
      else entry.controller.abort(reason);
      emit(entry);
    }
    const task = snapshot(entry);
    // 还没有操作认领：不会再有谁来 finish 它，取消就是收尾。
    if (!entry.operating) {
      active.delete(id);
      retire(entry);
    }
    return { success: true, task };
  }

  function finish(id: string, { state = "completed", message = "已完成" }: TaskEnd = {}): Task | null {
    const entry = active.get(id);
    if (!entry) return null;
    if (entry.state !== "canceled") {
      entry.state = state;
      entry.phase = state;
      entry.message = message;
      entry.updatedAt = now();
    }
    delete entry.finishing;
    const task = emit(entry);
    active.delete(id);
    return task;
  }

  // 操作开始时拿信号，同时记下这个任务有操作在跑。
  // 已经取消的任务也交回信号（已中止）：调用方据此不再开始操作，直接按取消收尾。
  function claim(id: string): AbortSignal | null {
    const entry = active.get(id);
    if (!entry) return retired.get(id) || null;
    entry.operating = true;
    return entry.controller.signal;
  }

  // 登记后一直没有操作来认领（发起页面在登记和发请求之间关掉了）：按取消收尾，让出键。
  // 已经认领的不动，交回 null。
  function expireIfUnclaimed(id: string, { state = "canceled", message = "已取消" }: TaskEnd = {}): Task | null {
    const entry = active.get(id);
    if (!entry || entry.operating) return null;
    entry.controller.abort();
    const task = finish(id, { state, message });
    retire(entry);
    return task;
  }

  const occupant = (key: string): Task | null => snapshot(occupying(key));
  const get = (id: string): Task | null => snapshot(active.get(id));
  const signal = (id: string): AbortSignal | null => active.get(id)?.controller.signal || retired.get(id) || null;
  const list = (): Task[] => [...active.values()].map((entry) => snapshot(entry));

  return { start, progress, cancel, finish, claim, expireIfUnclaimed, occupant, get, signal, list };
}
