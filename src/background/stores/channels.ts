// 频道偏好仓储：频道 → 用户手动选过的模式。只在主动切换模式时写，设置页可以全部清掉。
// 读出来的行不信：模式认不出、键对不上的当作没记过。
import type { ClearGuard } from "../../core/clear-guard.ts";
import { isMode } from "../../core/mode/decide.ts";
import type { Mode } from "../../core/mode/types.ts";
import type { ObjectStoreDriver } from "../../platform/idb.ts";
import { createWriteGate, type WriteOptions } from "./write-gate.ts";

export interface ChannelRecord {
  readonly channelKey: string;
  readonly mode: Mode;
  readonly updatedAt: number;
}

export interface ChannelStoreDeps {
  readonly driver: ObjectStoreDriver<ChannelRecord>;
  readonly guard: ClearGuard;
  readonly now: () => number;
}

export interface ChannelStore {
  /** 用户给这个频道选过的模式，没选过是 undefined。 */
  readonly get: (channelKey: string) => Promise<Mode | undefined>;
  /** 记下这个频道的模式。清除过就不写，返回 false。 */
  readonly put: (channelKey: string, mode: Mode, options?: WriteOptions) => Promise<boolean>;
  /** 清掉全部频道偏好。 */
  readonly clear: (options?: WriteOptions) => Promise<boolean>;
}

export function createChannelStore({ driver, guard, now }: ChannelStoreDeps): ChannelStore {
  // 清除缓存不动频道偏好，只有清除全部数据才清。
  const gate = createWriteGate(guard, "all");
  const done = async (written: Promise<true | null>): Promise<boolean> => (await written) === true;

  return {
    async get(channelKey) {
      const row = (await driver.get(channelKey)) as Partial<ChannelRecord> | undefined;
      return row?.channelKey === channelKey && isMode(row.mode) ? row.mode : undefined;
    },
    put: (channelKey, mode, { since } = {}) =>
      done(
        gate(since, async () => {
          await driver.write({ put: [{ channelKey, mode, updatedAt: now() }] });
          return true as const;
        }),
      ),
    clear: ({ since } = {}) =>
      done(
        gate(since, async () => {
          await driver.clear();
          return true as const;
        }),
      ),
  };
}
