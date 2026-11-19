// 每项功能最近一次模型请求服务回报的用量，设置页「推理强度」一节显示。只记数字和当时的模型、实际按的档位，
// 不记请求和回复的内容，也不记密钥。放在会话存储里：后台被回收以后还在，关掉浏览器就没了；不进备份，两种清除都清掉。
import { isEffort, type EffortNote, type TokenUsage } from "../core/ai/provider/index.ts";
import type { ClearEpoch, ClearGuard } from "../core/clear-guard.ts";
import type { StorageArea } from "../platform/storage.ts";
import type { LastUsageView } from "../shared/messages/ai.ts";
import { USAGE_STORAGE_KEY } from "../shared/names.ts";

export interface UsageLog {
  /** 记下这项功能最近一次的用量，盖掉上一次。since 是任务开始时的清除代数，这之后清除过就不记。 */
  readonly record: (feature: string, entry: LastUsageView, since: ClearEpoch | undefined) => Promise<void>;
  /** 按功能读出记着的用量，读不到或形状不对的当作没有。 */
  readonly read: () => Promise<Readonly<Record<string, LastUsageView>>>;
}

const USAGE_FIELDS = ["input", "output", "reasoning", "total"] as const;
const EFFORT_NOTES: readonly EffortNote[] = ["cannot-disable", "fallback", "unknown"];

const countOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

// 会话存储里的东西照样按不可信的形状读，只留认得的几项。
function entryOf(value: unknown): LastUsageView | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.model !== "string" || !isEffort(raw.effort)) return null;
  const counts = (raw.usage && typeof raw.usage === "object" ? raw.usage : {}) as Record<string, unknown>;
  const usage: Record<string, number> = {};
  for (const field of USAGE_FIELDS) {
    const count = countOf(counts[field]);
    if (count !== undefined) usage[field] = count;
  }
  const note = EFFORT_NOTES.find((known) => known === raw.note);
  return { model: raw.model, effort: raw.effort, ...(note ? { note } : {}), usage: usage as TokenUsage };
}

export function createUsageLog({ storage, clearGuard }: { storage: StorageArea; clearGuard: ClearGuard }): UsageLog {
  async function read(): Promise<Record<string, LastUsageView>> {
    const stored = (await storage.get(USAGE_STORAGE_KEY).catch((): Record<string, unknown> => ({})))[USAGE_STORAGE_KEY];
    if (!stored || typeof stored !== "object") return {};
    const entries: Record<string, LastUsageView> = {};
    for (const [feature, value] of Object.entries(stored)) {
      const entry = entryOf(value);
      if (entry) entries[feature] = entry;
    }
    return entries;
  }

  // 几个请求差不多同时回来时排队写，后写的不会拿着旧的整份盖掉先写的那项。
  let queue: Promise<void> = Promise.resolve();
  function record(feature: string, entry: LastUsageView, since: ClearEpoch | undefined): Promise<void> {
    queue = queue
      .then(() =>
        clearGuard.track(async () => {
          if (clearGuard.clearedSince(since, "cache")) return;
          const current = await read();
          await storage.set({ [USAGE_STORAGE_KEY]: { ...current, [feature]: entryOf(entry) } });
        }),
      )
      .catch(() => {});
    return queue;
  }

  return { record, read };
}
