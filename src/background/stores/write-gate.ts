// 仓储写入的关口：排进这个仓储的串行队列，进清除闸门，查代数和写在同一段里。
// 闸门不能嵌套，清除进行中里外两层会互相等，所以调用仓储的服务不要在外面再包 track。
import type { ClearEpoch, ClearGuard, ClearScope } from "../../core/clear-guard.ts";
import { createSerialQueue } from "../../core/concurrency.ts";

export interface WriteOptions {
  /** 操作开头记下的清除代数，这之后清除过就不写。不给时从调用这一刻算。 */
  readonly since?: ClearEpoch | undefined;
}

/** 执行一段写入，返回它的结果；清除过就不执行，返回 null。 */
export type WriteGate = <R>(since: ClearEpoch | undefined, write: () => Promise<R>) => Promise<R | null>;

export function createWriteGate(guard: ClearGuard, scope: ClearScope): WriteGate {
  const queue = createSerialQueue();
  return <R>(since: ClearEpoch | undefined, write: () => Promise<R>): Promise<R | null> => {
    const from = since ?? guard.epoch();
    return queue(() => guard.track(() => (guard.clearedSince(from, scope) ? null : write())));
  };
}
