// 卡片里到点做事的部件：定时器本身（测试换成手动到点的），和生成按钮等内容的那一段。

export interface CardTimers {
  every(ms: number, run: () => void): () => void;
  timeout<T>(work: Promise<T>, ms: number): Promise<T | "timeout">;
  /** 过这么久调一次，返回取消函数。 */
  after(ms: number, run: () => void): () => void;
}

export const realTimers: CardTimers = {
  every(ms, run) {
    const timer = setInterval(run, ms);
    return () => clearInterval(timer);
  },
  timeout<T>(work: Promise<T>, ms: number): Promise<T | "timeout"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), ms)));
    return Promise.race([work, late]).finally(() => clearTimeout(timer));
  },
  after(ms, run) {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
  },
};

/** 生成按钮最多等内容这么久：读得慢、官方总结一直没结果时，过了这个时间照样摆出来。 */
export const ACTIONS_WAIT_MS = 5_000;

/**
 * 每个视频第一次读时等视频信息和官方总结有了结果再摆出操作，最长等 ACTIONS_WAIT_MS。
 * 摆出来以后这个视频就不再收回。
 * changed 在要不要摆变了时调。
 */
export function createActionHold(after: CardTimers["after"], changed: (held: boolean) => void) {
  let shown = false;
  let cancel: (() => void) | null = null;
  const stop = (): void => {
    cancel?.();
    cancel = null;
  };
  const show = (): void => {
    const held = cancel !== null;
    stop();
    shown = true;
    if (held) changed(false);
  };
  return {
    /** 开始读这个视频：还没摆过就先不摆。 */
    hold(): void {
      if (shown || cancel) return;
      cancel = after(ACTIONS_WAIT_MS, show);
      changed(true);
    },
    /** 内容齐了，或者等够了。 */
    show,
    holding: (): boolean => cancel !== null,
    /** 换了视频：重新等。 */
    reset(): void {
      stop();
      shown = false;
    },
    stop,
  };
}
