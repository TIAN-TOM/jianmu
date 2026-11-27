// 打开就出结论的尝试记录：存在会话存储的 jianmu_auto_ledger 里，浏览器重开就清空，清除全部数据时也删。
// 记试过的视频、最近 10 分钟发出的时刻、额度用完或密钥不对的暂停，以及读平台定下来的结果，后台被回收以后不再为同一个视频读。
import type { ClearEpoch, ClearGuard } from "../../core/clear-guard.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { StorageArea } from "../../platform/storage.ts";
import type { AutoPauseReason } from "../../shared/messages/ai.ts";
import { AUTO_LEDGER_KEY } from "../../shared/names.ts";
import { errorLabel, type Log } from "../log.ts";
import { createWriteGate } from "../stores/write-gate.ts";

export const AUTO_WINDOW_MS = 10 * 60_000;
/** 记下的读到过的时长最多这么多个，再多挤掉最早的。 */
export const AUTO_DURATION_LIMIT = 1000;

/** 只自动生成概览（连同一句话结论）。尝试记录按「功能:视频键」记，以后加功能时各记各的。 */
export type AutoFeature = "overview";
export const FEATURE: AutoFeature = "overview";

/**
 * 尝试记录：试过的整个浏览器会话都留着，计数只留最近 10 分钟的。为不在后台被回收以后把开着的标签页再读一遍，
 * 读平台定下来的也记在这里：读到过的时长、读不成的视频（在前台读不成的冷却 10 分钟，在后台读不成的这次会话不再读，到了前台再试）、整批停到什么时候。
 */
export interface AutoLedger {
  readonly tried: readonly string[];
  readonly sent: readonly number[];
  readonly paused?: { readonly reason: AutoPauseReason; readonly at: number };
  readonly durations?: Readonly<Record<string, number>>;
  readonly unavailable?: Readonly<Record<string, number>>;
  readonly missedBehind?: readonly string[];
  readonly stoppedUntil?: number;
}

export const triedKey = (feature: AutoFeature, video: VideoKey): string => `${feature}:${video}`;

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isPauseReason = (value: unknown): value is AutoPauseReason => value === "quota" || value === "key" || value === "local-origin";

/** 存储里的记录形状不可信，逐项核对。早先只记 attempts 的写法照样认概览那种，别的（翻译）忽略。 */
export function parseLedger(stored: unknown, now: number): AutoLedger {
  const record = isPlainObject(stored) ? stored : {};
  const tried = new Set<string>(Array.isArray(record.tried) ? record.tried.filter((item): item is string => typeof item === "string") : []);
  const sent = Array.isArray(record.sent) ? record.sent.filter(isTime) : [];
  for (const item of Array.isArray(record.attempts) ? record.attempts : []) {
    if (!isPlainObject(item) || item.feature !== FEATURE || typeof item.video !== "string" || !isTime(item.at)) continue;
    tried.add(triedKey(FEATURE, item.video as VideoKey));
    sent.push(item.at);
  }
  const paused = isPlainObject(record.paused) && isPauseReason(record.paused.reason) && isTime(record.paused.at) ? { reason: record.paused.reason, at: record.paused.at } : undefined;
  const durations = Object.fromEntries(
    (isPlainObject(record.durations) ? Object.entries(record.durations) : []).filter(([, seconds]) => isTime(seconds) && seconds >= 0).slice(-AUTO_DURATION_LIMIT),
  ) as Record<string, number>;
  const unavailable = Object.fromEntries((isPlainObject(record.unavailable) ? Object.entries(record.unavailable) : []).filter(([, until]) => isTime(until) && until > now)) as Record<
    string,
    number
  >;
  const missedBehind = Array.isArray(record.missedBehind) ? [...new Set(record.missedBehind.filter((item): item is string => typeof item === "string"))] : [];
  const stoppedUntil = isTime(record.stoppedUntil) && record.stoppedUntil > now ? record.stoppedUntil : undefined;
  return {
    tried: [...tried],
    sent: sent.filter((at) => at > now - AUTO_WINDOW_MS).sort((a, b) => a - b),
    ...(paused ? { paused } : {}),
    ...(Object.keys(durations).length > 0 ? { durations } : {}),
    ...(Object.keys(unavailable).length > 0 ? { unavailable } : {}),
    ...(missedBehind.length > 0 ? { missedBehind } : {}),
    ...(stoppedUntil === undefined ? {} : { stoppedUntil }),
  };
}

/** 尝试记录存在会话存储里：浏览器重开就清空，清除全部数据时也删。写排成一条队，清除之后不把之前的写回去。 */
export interface LedgerDeps {
  readonly storage: StorageArea;
  readonly guard: ClearGuard;
  readonly now: () => number;
  readonly log: Log;
}

export function createLedger({ storage, guard, now, log }: LedgerDeps) {
  const write = createWriteGate(guard, "all");
  async function read(): Promise<AutoLedger> {
    try {
      return parseLedger((await storage.get(AUTO_LEDGER_KEY))[AUTO_LEDGER_KEY], now());
    } catch (error) {
      log.warn("读自动生成的尝试记录失败", errorLabel(error));
      return parseLedger(undefined, now());
    }
  }
  async function change(since: ClearEpoch | undefined, mutate: (ledger: AutoLedger) => AutoLedger | null): Promise<boolean> {
    const written = await write(since, async () => {
      const next = mutate(await read());
      if (!next) return false;
      await storage.set({ [AUTO_LEDGER_KEY]: next });
      return true;
    });
    return written ?? false;
  }
  return { read, change };
}
