// AI 任务生命周期：去重、进度、取消与状态广播；任务在跑时的 service worker 保活。
export type TaskState = "running" | "completed" | "failed" | "canceled";

export interface Task {
  readonly id: string;
  readonly kind: string;
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
  readonly holdKeyAfterCancel?: readonly string[];
}

export interface TaskManager {
  start(task: TaskStart): TaskStartResult;
  progress(id: string, patch?: TaskProgress): Task | null;
  cancel(id: string, options?: TaskCancel): TaskCancelResult;
  finish(id: string, end?: TaskEnd): Task | null;
  claim(id: string): AbortSignal | null;
  expireIfUnclaimed(id: string, end?: TaskEnd): Task | null;
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
 * holdKeyAfterCancel 里的几种任务，取消只撤还没开始的那一步，已经在跑的操作照常跑完
 * （粗筛写结论：已经发给模型的照常等它回来、存下结论）。这次操作收尾（finish）之前，
 * 它仍占着这个键：同一个目标再登记会被拦下，不为同一份结果再花一次钱。
 * 还没开始操作就取消的不占：那次操作可能永远不会来（页面已经关了），键不能一直占着。
 * 其他种类取消就是真停了，键马上让出来，比如侧边栏停掉概览后可以立刻重新生成。
 */
export function createTaskManager({
  onChange = () => {},
  now = () => Date.now(),
  holdKeyAfterCancel = [],
}: TaskManagerDeps = {}): TaskManager {
  const active = new Map<string, TaskEntry>();
  const holdingKinds = new Set(holdKeyAfterCancel);
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
    (entry.state === "canceled" && entry.operating === true && holdingKinds.has(entry.kind));

  const emit = (entry: TaskEntry): Task => {
    const task = snapshot(entry);
    try {
      onChange(task);
    } catch (error) {
      // 状态监听失败不影响实际任务。
    }
    return task;
  };

  function start({ id, kind, key }: TaskStart): TaskStartResult {
    const duplicate = [...active.values()].find(
      (entry) => entry.key === key && occupiesKey(entry),
    );
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

  const get = (id: string): Task | null => snapshot(active.get(id));
  const signal = (id: string): AbortSignal | null => active.get(id)?.controller.signal || retired.get(id) || null;
  const list = (): Task[] => [...active.values()].map((entry) => snapshot(entry));

  return { start, progress, cancel, finish, claim, expireIfUnclaimed, get, signal, list };
}

export interface KeepAliveDeps {
  readonly ping: () => unknown;
  readonly intervalMs?: number;
  readonly now?: () => number;
  // 计时器句柄的类型各环境不同，这里只原样交回 clearTimeout；写成方法才放得进具体的句柄类型。
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?(timer: unknown): void;
}

export interface KeepAlive {
  hold(budgetMs: number): () => void;
  during<Result>(budgetMs: number, work: () => Result | Promise<Result>): Promise<Result>;
}

/**
 * MV3 的 service worker 空闲约 30 秒就会被回收，在途的 fetch 跟着中止：发起任务的页面关掉以后，
 * 没有挂着的消息撑着它；页面开着，挂着的消息也只撑 5 分钟左右。
 * 调用任何扩展 API 都会重置空闲计时，所以有任务在跑时每隔 intervalMs 调一次 ping。
 *
 * hold(budgetMs) 登记一份保活，返回 release()；任务结束时调用，最后一份撤掉就立刻停表。
 * 每份登记各有截止时间（登记时刻 + budgetMs），全都过了也停：任务因为意外一直不结束，
 * 也不能让 worker 永远不休眠。during(budgetMs, work) 是 hold 加 release 的简写。
 */
export function createKeepAlive({
  ping,
  intervalMs = 20 * 1000,
  now = () => Date.now(),
  // 计时器可由调用方传入，测试用手动推进的替身。
  setTimeout: schedule = setTimeout,
  clearTimeout: unschedule = clearTimeout,
}: KeepAliveDeps = {} as KeepAliveDeps): KeepAlive {
  if (typeof ping !== "function") throw new Error("保活需要 ping 函数");
  const deadlines = new Map<number, number>();
  let nextId = 0;
  let timer: unknown = null;

  const live = (): boolean => {
    const current = now();
    for (const deadline of deadlines.values()) {
      if (deadline > current) return true;
    }
    return false;
  };

  function stop(): void {
    if (timer === null) return;
    unschedule(timer);
    timer = null;
  }

  function arm(): void {
    if (timer !== null) return;
    timer = schedule(tick, intervalMs);
    // Node 测试里别让计时器拖住进程；浏览器的计时器返回数字，没有 unref。
    (timer as { unref?: () => void } | null | undefined)?.unref?.();
  }

  function tick(): void {
    timer = null;
    if (!live()) return;
    // 调用本身就是保活，结果不重要；调用失败也只是少续这一次。
    try {
      Promise.resolve(ping()).catch(() => {});
    } catch (_) {
      // 同上：同步抛错也不能打断任务。
    }
    arm();
  }

  function hold(budgetMs: number): () => void {
    const id = (nextId += 1);
    deadlines.set(id, now() + Math.max(0, Number(budgetMs) || 0));
    arm();
    return function release() {
      if (!deadlines.delete(id)) return;
      if (!deadlines.size) stop();
    };
  }

  async function during<Result>(budgetMs: number, work: () => Result | Promise<Result>): Promise<Result> {
    const release = hold(budgetMs);
    try {
      return await work();
    } finally {
      release();
    }
  }

  return { hold, during };
}
