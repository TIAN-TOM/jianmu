// 按站点的限速和退避：令牌桶只在内存，退避状态放会话存储，service worker 重启后还在。
import { abortableSleep } from "../core/ai/transport/policy.ts";
import type { Platform } from "../core/video-ref.ts";
import { SITE_BACKOFF_KEY } from "../shared/names.ts";
import { readItem, type StorageArea } from "./storage.ts";

// 这些数字都是初值，日用时看被限流的次数和读取的等待时间再调。
const BUCKET_CAPACITY = 8;
const REFILL_INTERVAL_MS = 1500;
const FIRST_BACKOFF_MS = 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

interface BackoffRecord {
  readonly until: number; // 到期时间，毫秒
  readonly strikes: number; // 连续命中次数，读取成功才清
}

export type Admission = { ok: true } | { ok: false; retryAfterSec: number };

export interface SiteBackoffDeps {
  readonly site: Platform;
  readonly session: StorageArea;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface SiteBackoffHandle {
  readonly admit: (signal: AbortSignal) => Promise<Admission>;
  readonly trip: (retryAfterSec?: number) => Promise<void>;
  readonly clear: () => Promise<void>;
}

// 几个站共用一个存储键，读改写按存储区排队，一个站的写入不会盖掉另一个站的。
const writeQueues = new WeakMap<StorageArea, Promise<unknown>>();

function inOrder<T>(area: StorageArea, work: () => Promise<T>): Promise<T> {
  const run = (writeQueues.get(area) ?? Promise.resolve()).then(work, work);
  writeQueues.set(area, run);
  return run;
}

function recordFrom(value: unknown): BackoffRecord | undefined {
  const record = value as Partial<BackoffRecord> | null | undefined;
  const { until, strikes } = record ?? {};
  return typeof until === "number" && typeof strikes === "number" ? { until, strikes } : undefined;
}

function storedRecords(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export function createSiteBackoff(deps: SiteBackoffDeps): SiteBackoffHandle {
  const { site, session, now = Date.now, sleep = abortableSleep } = deps;
  let tokens = BUCKET_CAPACITY;
  let refilledAt = now();
  let record: BackoffRecord | undefined;
  let loaded = false;

  async function load(): Promise<void> {
    if (loaded) return;
    record = recordFrom(storedRecords(await readItem(session, SITE_BACKOFF_KEY))[site]);
    loaded = true;
  }

  // 先改内存：写不进存储时这次退避照样生效。
  async function save(next: BackoffRecord | undefined): Promise<void> {
    record = next;
    const stored = { ...storedRecords(await readItem(session, SITE_BACKOFF_KEY)) };
    if (next) stored[site] = next;
    else delete stored[site];
    await session.set({ [SITE_BACKOFF_KEY]: stored });
  }

  const secondsLeft = (): Promise<number> =>
    inOrder(session, async () => {
      await load();
      return record ? Math.max(0, Math.ceil((record.until - now()) / 1000)) : 0;
    });

  // 取一个令牌，返回要等多久；桶空了就排到后面。
  function reserveToken(): number {
    const at = now();
    tokens = Math.min(BUCKET_CAPACITY, tokens + Math.max(0, at - refilledAt) / REFILL_INTERVAL_MS);
    refilledAt = at;
    tokens -= 1;
    return tokens >= 0 ? 0 : Math.ceil(-tokens * REFILL_INTERVAL_MS);
  }

  async function admit(signal: AbortSignal): Promise<Admission> {
    const blocked = await secondsLeft();
    if (blocked > 0) return { ok: false, retryAfterSec: blocked };
    signal.throwIfAborted();
    const waitMs = reserveToken();
    if (waitMs === 0) return { ok: true };
    try {
      await sleep(waitMs, signal);
    } catch (error) {
      tokens += 1;
      throw error;
    }
    // 排队的时候可能已经被限流了。
    const late = await secondsLeft();
    return late > 0 ? { ok: false, retryAfterSec: late } : { ok: true };
  }

  const trip = (retryAfterSec?: number): Promise<void> =>
    inOrder(session, async () => {
      await load();
      const at = now();
      const suggestedMs = Math.max(0, (retryAfterSec ?? 0) * 1000);
      if (record && record.until > at) {
        // 退避期内再次命中不累加，平台要等得更久时才延后。
        if (at + suggestedMs > record.until) await save({ ...record, until: at + suggestedMs });
        return;
      }
      const strikes = (record?.strikes ?? 0) + 1;
      const backoffMs = Math.min(FIRST_BACKOFF_MS * 2 ** (strikes - 1), MAX_BACKOFF_MS);
      await save({ strikes, until: at + Math.max(backoffMs, suggestedMs) });
    });

  // 退避期内不清：限流之前发出的请求这时才回来，不能解除退避。
  const clear = (): Promise<void> =>
    inOrder(session, async () => {
      await load();
      if (record && record.until <= now()) await save(undefined);
    });

  return { admit, trip, clear };
}
