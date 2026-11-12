// 粗筛的存储：稍后再看的列表快照和官方总结，放在扩展本机存储的一个键下，30 天期限，过期按没读过。
// 读—改—写排进一条队列、进清除闸门：清除缓存或全部数据以后，之前开始的读取回来不写回，也不把这个键重新建出来。
import type { ClearEpoch, ClearGuard } from "../../core/clear-guard.ts";
import { freshState, STORAGE_KEY, type TriageState } from "../../core/triage/state.ts";
import { readItem, type StorageArea } from "../../platform/storage.ts";
import { createWriteGate } from "./write-gate.ts";

export interface TriageStoreDeps {
  readonly storage: StorageArea;
  readonly guard: ClearGuard;
  readonly now: () => number;
}

export interface TriageStore {
  /** 现在算数的那份：没读过、过了期限都是空的。 */
  read(): Promise<TriageState>;
  /**
   * 读—改—写一次做完：mutate 拿到写队列里现读的那份，交回 null 表示不写。
   * since 是操作开头记下的清除代数，这之后清除过就不调 mutate。写下时交回新的那份，没写交回 null。
   */
  update(mutate: (current: TriageState) => TriageState | null, since: ClearEpoch | undefined): Promise<TriageState | null>;
}

export function createTriageStore({ storage, guard, now }: TriageStoreDeps): TriageStore {
  // 清除缓存和清除全部数据都清这个键，所以按缓存那一档的代数核对。
  const gate = createWriteGate(guard, "cache");
  const read = async (): Promise<TriageState> => freshState(await readItem(storage, STORAGE_KEY), now());
  return {
    read,
    async update(mutate, since) {
      const written = await gate(since, async () => {
        const next = mutate(await read());
        if (next === null) return null;
        await storage.set({ [STORAGE_KEY]: next });
        return next;
      });
      return written ?? null;
    },
  };
}
