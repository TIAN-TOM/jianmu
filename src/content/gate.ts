// 启用闸门：加载后问一次后台，确认启用了才放行；没确认时只等启用广播。启用失效（清除全部数据）时马上关上，重新等确认。
// 闸门关着时什么都不做：不读页面、不插节点、不挂别的监听。问不到后台时隔一会儿再问，几次以后只等广播。

/** 后台说的：启用了、没启用，或者问不到。 */
export type Activation = "current" | "needed" | "unknown";

export interface GateTimers {
  set(run: () => void, ms: number): unknown;
  clear(timer: unknown): void;
}

export interface GateDeps {
  readonly ask: () => Promise<Activation>;
  /** 放行：开始读页面、挂界面。 */
  readonly open: () => void;
  /** 关上：撤掉界面、停下一切。 */
  readonly close: () => void;
  readonly timers?: GateTimers;
}

export interface Gate {
  readonly start: () => void;
  /** 后台的广播：确认了启用，或者启用失效了。 */
  readonly notify: (event: "confirmed" | "lost") => void;
  readonly isOpen: () => boolean;
  readonly stop: () => void;
}

/** 问不到时隔这么久再问，问完这几次就只等广播。 */
export const ASK_RETRY_MS: readonly number[] = [2000, 5000, 15_000];

const realTimers: GateTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function createGate({ ask, open, close, timers = realTimers }: GateDeps): Gate {
  let opened = false;
  let stopped = false;
  // 每问一次、每来一条广播加一：迟到的回答对不上就作废。
  let generation = 0;
  let retries = 0;
  let retryTimer: unknown = null;

  const cancelRetry = (): void => {
    if (retryTimer !== null) timers.clear(retryTimer);
    retryTimer = null;
  };

  function shut(): void {
    if (!opened) return;
    opened = false;
    close();
  }

  async function check(): Promise<void> {
    cancelRetry();
    generation += 1;
    const asked = generation;
    const answer = await ask();
    if (stopped || asked !== generation) return;
    if (answer === "current") {
      retries = 0;
      if (!opened) {
        opened = true;
        open();
      }
      return;
    }
    shut();
    if (answer === "unknown" && retries < ASK_RETRY_MS.length) {
      const wait = ASK_RETRY_MS[retries] ?? 0;
      retries += 1;
      retryTimer = timers.set(() => {
        retryTimer = null;
        void check();
      }, wait);
    }
  }

  return {
    start: () => void check(),
    notify(event) {
      if (stopped) return;
      retries = 0;
      if (event === "lost") {
        // 先关上，再问后台：这一刻起就按没启用处理，不等回答。
        generation += 1;
        shut();
      }
      void check();
    },
    isOpen: () => opened,
    stop() {
      stopped = true;
      cancelRetry();
      shut();
    },
  };
}
