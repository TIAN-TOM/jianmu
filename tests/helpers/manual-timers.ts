// 手动推进的计时器和时钟，交给被测模块：只管它自己排的那几个，测试里不真等。
// fire(ms) 让延时为 ms 的那些马上到点；advance(ms) 把时钟往前推，到点的按先后触发，触发时新排的也算。

export interface ManualTimers {
  readonly now: () => number;
  readonly setTimeout: (callback: () => void, delayMs: number) => number;
  readonly clearTimeout: (timer: unknown) => void;
  /** 延时为 ms、还没触发的有几个。 */
  readonly due: (delayMs: number) => number;
  /** 延时为 ms 的那些马上触发，时钟不动；回触发了几个。 */
  readonly fire: (delayMs: number) => number;
  readonly advance: (ms: number) => void;
  /** 还没触发的一共几个。 */
  readonly pending: () => number;
}

interface Entry {
  readonly callback: () => void;
  readonly delayMs: number;
  readonly at: number;
}

export function manualTimers(start = 0): ManualTimers {
  const entries = new Map<number, Entry>();
  let clock = start;
  let nextId = 1;
  return {
    now: () => clock,
    setTimeout(callback, delayMs) {
      const id = nextId;
      nextId += 1;
      entries.set(id, { callback, delayMs, at: clock + delayMs });
      return id;
    },
    clearTimeout(timer) {
      entries.delete(Number(timer));
    },
    due: (delayMs) => [...entries.values()].filter((entry) => entry.delayMs === delayMs).length,
    fire(delayMs) {
      const ready = [...entries].filter(([, entry]) => entry.delayMs === delayMs);
      for (const [id, entry] of ready) {
        entries.delete(id);
        entry.callback();
      }
      return ready.length;
    },
    advance(ms) {
      const target = clock + ms;
      for (;;) {
        let next: [number, Entry] | undefined;
        for (const item of entries) if (item[1].at <= target && (!next || item[1].at < next[1].at)) next = item;
        if (!next) break;
        entries.delete(next[0]);
        clock = next[1].at;
        next[1].callback();
      }
      clock = target;
    },
    pending: () => entries.size,
  };
}
