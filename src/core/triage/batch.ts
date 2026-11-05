// 粗筛的两步批次。两步都由用户点按钮开始，每一步发消息给后台、等回复：
//  第一步：逐个取官方总结。串行，真正发了请求的两次之间至少隔 1.5 秒。
//  第二步：只对有官方总结、还没有结论的视频写一句话结论，同时最多 3 个。
import { parseVideoKey, type ChannelRef, type VideoRef } from "../video-ref.ts";
import { hasVerdict, type VerdictMap } from "./groups.ts";
import type { OfficialMap, OfficialRecord, TriageItem } from "./state.ts";

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

export interface OfficialRequest {
  readonly action: "getOfficialSummary";
  readonly ref: VideoRef | null; // 存储里的键认不出时是 null
  readonly mediaVersion: string | undefined;
  readonly channel: ChannelRef | undefined;
}

export interface OfficialOutcome<R> extends RequestMark {
  readonly response: R;
  readonly requested: boolean;
}

export interface OfficialBatch<R> extends SerialOptions<TriageItem, OfficialOutcome<R>> {
  readonly items: readonly TriageItem[];
  readonly send: (message: OfficialRequest) => Promise<R>;
}

export interface VerdictRequest {
  readonly action: "analyzeTranscript";
  readonly ref: VideoRef | null; // 存储里的键认不出时是 null
  readonly verdictSource: "official";
  readonly triage: true;
}

export interface VerdictOutcome<R> {
  readonly response: R;
}

export interface VerdictBatch<R> extends BatchHooks<TriageItem, VerdictOutcome<R>> {
  readonly items: readonly TriageItem[];
  readonly send: (message: VerdictRequest) => Promise<R>;
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

/** 第一步：逐个让后台取官方总结。 */
export function runOfficialBatch<R extends RequestMark | null | undefined>({
  items,
  send,
  signal,
  intervalMs,
  sleep: wait,
  now,
  onStart,
  onResult,
}: OfficialBatch<R>): Promise<SerialResult> {
  return runSerial(
    items,
    async (item): Promise<OfficialOutcome<R>> => {
      const response: R = await send({
        action: "getOfficialSummary",
        ref: parseVideoKey(item.videoKey),
        mediaVersion: item.mediaVersion,
        channel: item.channel,
      });
      return { response, requested: response?.requested !== false };
    },
    { intervalMs, signal, sleep: wait, now, onStart, onResult },
  );
}

/**
 * 第二步：逐个让后台用官方总结写结论。verdictSource: "official" 复用概览的结论写法；
 * triage: true 让后台从粗筛存的官方总结里取材料，不为写结论再去取字幕。
 * 不占这个视频的概览任务。调用方传进来的 send 给每条请求另登记一个 triage-verdict 任务，
 * 停止时据此撤掉还在后台排队的请求。
 */
export function runVerdictBatch<R>({
  items,
  send,
  concurrency,
  signal,
  onStart,
  onResult,
}: VerdictBatch<R>): Promise<PoolResult> {
  return runPool(
    items,
    async (item): Promise<VerdictOutcome<R>> => ({
      response: await send({
        action: "analyzeTranscript",
        ref: parseVideoKey(item.videoKey),
        verdictSource: "official",
        triage: true,
      }),
    }),
    { concurrency, signal, onStart, onResult },
  );
}
