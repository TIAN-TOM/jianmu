// 粗筛的两步批次。两步都由用户点按钮开始，在后台批次服务里跑，每一项怎么做由它注入：
//  第一步：逐个取官方总结。串行，真正发了请求的两次之间至少隔 1.5 秒；读不成时按停止规则看要不要整批停下。
//  第二步：只对有官方总结、还没有结论的视频写一句话结论，同时最多 3 个。
import type { SiteFailureReach } from "../errors/site.ts";
import type { VideoRef } from "../video-ref.ts";
import { hasVerdict, type VerdictMap } from "./groups.ts";
import { triageRef, type OfficialMap, type OfficialRecord, type TriageItem } from "./state.ts";

export const OFFICIAL_INTERVAL_MS = 1500;

// 有、没有、不支持：再问也是一样的答案，再点「开始」时跳过。
// 排队中、要登录、失败：过一阵再问可能就有了，再点「开始」时重问。
export const OFFICIAL_FINAL_STATUSES: readonly string[] = Object.freeze(["ok", "none", "unsupported"]);

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

/** worker 正常返回的结果，或者它抛出的错误。 */
export type Outcome<R> = R | { readonly error: unknown };

/** worker 回 { requested: false } 表示这一个没发请求。 */
export interface RequestMark {
  readonly requested?: boolean;
}

export interface BatchHooks<T, R> {
  readonly signal?: AbortSignal;
  readonly onStart?: (item: T) => void;
  readonly onResult?: (item: T, outcome: Outcome<R>, done: number) => void;
}

export interface SerialOptions<T, R> extends BatchHooks<T, R> {
  readonly intervalMs?: number;
  readonly sleep?: SleepFn;
  readonly now?: () => number;
}

export interface SerialResult {
  readonly done: number;
  readonly total: number;
  readonly stopped: boolean;
}

export interface PoolOptions<T, R> extends BatchHooks<T, R> {
  readonly concurrency?: unknown;
}

export interface PoolResult extends SerialResult {
  readonly started: number;
}

/** 交给每一项的：条目本身和它的视频身份。视频键认不出、或者不是第 1 P 时身份是 null，这一项不发请求。 */
export interface OfficialRequest {
  readonly item: TriageItem;
  readonly ref: VideoRef | null;
}

export type VerdictRequest = OfficialRequest;

/** 连着几个要登录就整批停下：偶尔一个不作数。 */
export const LOGIN_STREAK_STOP = 2;

/** 整批提前停下的原因：被平台限流、连着要登录、这条读取路线整体读不了。 */
export type BatchStop = "rate-limited" | "need-login" | "source";

/** 一项读不成：只有错误码和读取实现标的影响范围，不看别的说明。 */
export interface ReadFailure {
  readonly code: string;
  readonly reach?: SiteFailureReach | undefined;
}

export interface StopCheck {
  readonly stop: BatchStop | null;
  readonly loginStreak: number;
}

/** 逐个读取的一项交回的：有没有真的发请求，读不成时的失败。 */
export interface PacedOutcome extends RequestMark {
  readonly failure?: ReadFailure | null | undefined;
}

export interface PacedResult extends SerialResult {
  readonly stop: BatchStop | null;
}

export interface OfficialBatch<R extends PacedOutcome> extends SerialOptions<TriageItem, R> {
  readonly items: readonly TriageItem[];
  readonly step: (request: OfficialRequest) => Promise<R>;
}

export interface VerdictBatch<R> extends BatchHooks<TriageItem, R> {
  readonly items: readonly TriageItem[];
  readonly step: (request: VerdictRequest) => Promise<R>;
  readonly concurrency?: unknown;
}

// 看内容，不只看 status。
export function hasOfficialContent(record: OfficialRecord | null | undefined): record is OfficialRecord {
  if (!record || typeof record !== "object") return false;
  return Boolean(
    String(record.summary || "").trim() ||
      (Array.isArray(record.outline) && record.outline.length),
  );
}

export function isOfficialDone(record: OfficialRecord | null | undefined): boolean {
  return OFFICIAL_FINAL_STATUSES.includes(record?.status as string);
}

// 第一步要请求的：视频还能看、还没有定论的。
export function officialTodo(items: readonly TriageItem[], official: OfficialMap = {}): TriageItem[] {
  const list: readonly TriageItem[] = Array.isArray(items) ? items : [];
  return list.filter((item) => item.available !== false && !isOfficialDone(official[item.videoKey]));
}

// 第二步要写的：有官方总结、还没有结论的。没有官方总结的不在这里写，
// 界面给一个去视频页的链接，让用户自己决定要不要生成完整概览。
export function verdictTodo(
  items: readonly TriageItem[],
  official: OfficialMap = {},
  verdicts: VerdictMap = {},
): TriageItem[] {
  const list: readonly TriageItem[] = Array.isArray(items) ? items : [];
  return list.filter((item) => hasOfficialContent(official[item.videoKey]) && !hasVerdict(verdicts[item.videoKey]));
}

/**
 * 读完一项以后要不要整批停下。被限流就停；连着两个要登录也停；格式不对时看读取实现标的影响范围，
 * 只影响这一项就接着下一项，这条读取路线整体读不了就停，没标的按整体读不了算。其余的失败只记这一项。
 */
export function stopAfter(failure: ReadFailure | null | undefined, loginStreak: number): StopCheck {
  if (!failure) return { stop: null, loginStreak: 0 };
  if (failure.code === "RATE_LIMITED") return { stop: "rate-limited", loginStreak: 0 };
  if (failure.code === "NEED_LOGIN") {
    const streak = loginStreak + 1;
    return { stop: streak >= LOGIN_STREAK_STOP ? "need-login" : null, loginStreak: streak };
  }
  if (failure.code === "MALFORMED" && failure.reach !== "item") return { stop: "source", loginStreak: 0 };
  return { stop: null, loginStreak: 0 };
}

/** 列表没确认过付费状态、或者缺媒体版本的条目，读官方总结之前先读一次视频信息：付费确认不了时它按看不了报。 */
export function needsVideoInfo(item: Pick<TriageItem, "paidChecked" | "mediaVersion">): boolean {
  return item.paidChecked !== true || !item.mediaVersion;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal?.addEventListener?.("abort", finish, { once: true });
  });
}

/**
 * 第一步的循环：一次一个。真正发了请求的两次之间至少隔 intervalMs，
 * 从上一次请求回来时算起。worker 回 { requested: false } 表示这一个没发请求
 * （后台直接用了已经存着的结果），间隔仍从上一次真正的请求算。
 * worker 抛错按「可能发过请求」处理。
 * signal 中止后不再开始下一个，正在等间隔时立刻结束；正在进行的那一个跑完为止。
 */
export async function runSerial<T, R>(
  items: readonly T[],
  worker: (item: T) => R,
  {
    intervalMs = OFFICIAL_INTERVAL_MS,
    signal,
    sleep: wait = sleep,
    now = () => Date.now(),
    onStart,
    onResult,
  }: SerialOptions<T, Awaited<R>> = {},
): Promise<SerialResult> {
  const list: readonly T[] = Array.isArray(items) ? items : [];
  let lastRequestEnd: number | null = null;
  let done = 0;
  for (const item of list) {
    if (signal?.aborted) break;
    if (lastRequestEnd !== null) {
      const remaining = intervalMs - (now() - lastRequestEnd);
      if (remaining > 0) await wait(remaining, signal);
      if (signal?.aborted) break;
    }
    onStart?.(item);
    let outcome: Outcome<Awaited<R>>;
    try {
      outcome = await worker(item);
    } catch (error) {
      outcome = { error };
    }
    if ((outcome as RequestMark | null | undefined)?.requested !== false) lastRequestEnd = now();
    done += 1;
    onResult?.(item, outcome, done);
  }
  return { done, total: list.length, stopped: done < list.length };
}

/**
 * 第二步的循环：同时最多 concurrency 个。signal 中止后不再开始新的，
 * 已经发出去的等它们自己回来（每个只是一次小请求，钱已经花了，结果照样存下）。
 */
export async function runPool<T, R>(
  items: readonly T[],
  worker: (item: T) => R,
  { concurrency = 3, signal, onStart, onResult }: PoolOptions<T, Awaited<R>> = {},
): Promise<PoolResult> {
  const list: readonly T[] = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.floor(Number(concurrency) || 1));
  let next = 0;
  let done = 0;
  const lane = async (): Promise<void> => {
    while (!signal?.aborted && next < list.length) {
      // 取号是同步的，几条通道不会拿到同一个视频。
      const item = list[next] as T;
      next += 1;
      onStart?.(item);
      let outcome: Outcome<Awaited<R>>;
      try {
        outcome = await worker(item);
      } catch (error) {
        outcome = { error };
      }
      done += 1;
      onResult?.(item, outcome, done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, lane));
  return { started: next, done, total: list.length, stopped: next < list.length };
}

/**
 * 逐个读取：间隔照 runSerial，每读完一项按停止规则看要不要整批停下。
 * signal 是用户的停止，只拦还没开始的；正在读的那一个读完为止。worker 抛错不算平台的信号，不因此停下。
 */
export async function runPaced<T, R extends PacedOutcome>(
  items: readonly T[],
  worker: (item: T) => Promise<R>,
  options: SerialOptions<T, R> = {},
): Promise<PacedResult> {
  const halt = new AbortController();
  const outer = options.signal;
  const forward = (): void => halt.abort();
  if (outer?.aborted) halt.abort();
  else outer?.addEventListener?.("abort", forward, { once: true });
  let streak = 0;
  let stop: BatchStop | null = null;
  try {
    const result = await runSerial(items, worker, {
      ...options,
      signal: halt.signal,
      onResult(item, outcome, done) {
        const failure = "error" in (outcome as object) ? null : (outcome as R).failure;
        const check = stopAfter(failure, streak);
        streak = check.loginStreak;
        if (check.stop && !stop) {
          stop = check.stop;
          halt.abort();
        }
        options.onResult?.(item, outcome, done);
      },
    });
    return { ...result, stop };
  } finally {
    outer?.removeEventListener?.("abort", forward);
  }
}

/** 第一步：逐个取官方总结，每一项交给注入的步骤。 */
export function runOfficialBatch<R extends PacedOutcome>({ items, step, ...options }: OfficialBatch<R>): Promise<PacedResult> {
  return runPaced(items, (item) => step({ item, ref: triageRef(item.videoKey) }), options);
}

/**
 * 第二步：逐个用官方总结写结论，每一项交给注入的步骤。步骤给每一项另登记一个粗筛写结论的任务，
 * 停止时据此撤掉还在后台排队的请求；已经发出去的照常等它回来。
 */
export function runVerdictBatch<R>({ items, step, concurrency, signal, onStart, onResult }: VerdictBatch<R>): Promise<PoolResult> {
  return runPool(items, (item) => step({ item, ref: triageRef(item.videoKey) }), { concurrency, signal, onStart, onResult });
}
