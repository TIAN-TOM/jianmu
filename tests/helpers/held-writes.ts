// 把存储的写入挂在门口：放行之前进来的写都停在这里，放行以后照常写。用来让清除撞上正在写的那一下。
import { deferred } from "./deferred.ts";

interface Writable {
  readonly set: (entries: Record<string, unknown>) => Promise<void>;
}

export interface HeldWrites {
  /** 进到门口的写入有几次，含已经放行的。 */
  readonly started: () => number;
  readonly release: () => void;
}

export function holdWrites(storage: Writable): HeldWrites {
  const gate = deferred();
  const write = storage.set;
  let started = 0;
  Object.assign(storage, {
    set: async (entries: Record<string, unknown>): Promise<void> => {
      started += 1;
      await gate.promise;
      return write(entries);
    },
  });
  return { started: () => started, release: gate.resolve };
}
