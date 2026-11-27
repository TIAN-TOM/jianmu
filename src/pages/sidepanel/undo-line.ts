// 「已切到精读」那一行：长视频在速读里播满 1 分钟、后台自动切到精读以后显示，点一下回到速读。
// 只在看得见、点得到时计时：侧边栏在前台、没被抽屉或层盖住、没被更要紧的提示挡住。看够 30 秒就收起，
// 之后要回速读只能手动切。计时按标签页和视频记，换视频再回来接着算；撤销以后会话不在自动切的结果上，这一行自然消失。
import { computed, signal, type ReadonlySignal } from "@preact/signals";
import { repeat } from "../../core/concurrency.ts";
import type { ModeView } from "./mode.ts";

/** 这一行看得见、点得到时最多留这么久。 */
export const UNDO_VISIBLE_MS = 30_000;

/** 计时的步长。 */
export const UNDO_TICK_MS = 1_000;

export interface UndoLine {
  /** 现在该显示这一行。 */
  readonly shown: ReadonlySignal<boolean>;
  /** 跟着的标签页和视频，没有视频时传 null。 */
  bind(key: string | null): void;
  /** 这一行此刻看得见、点得到。 */
  setCounting(counting: boolean): void;
  stop(): void;
}

export interface UndoLineDeps {
  readonly mode: ReadonlySignal<ModeView>;
  readonly every?: (ms: number, run: () => void) => () => void;
  readonly now?: () => number;
}

export function createUndoLine({ mode, every = repeat, now = Date.now }: UndoLineDeps): UndoLine {
  const spent = new Map<string, number>();
  const key = signal<string | null>(null);
  const version = signal(0);
  let stopTimer: (() => void) | null = null;
  let lastAt = 0;

  const shown = computed(() => {
    version.value;
    const current = key.value;
    return current !== null && mode.value.source === "auto" && (spent.get(current) ?? 0) < UNDO_VISIBLE_MS;
  });

  /** 把上次记账以来的时间记到当前这一个上。 */
  function settle(): void {
    const current = key.peek();
    const at = now();
    if (current !== null) spent.set(current, (spent.get(current) ?? 0) + Math.max(0, at - lastAt));
    lastAt = at;
    version.value += 1;
  }

  function halt(): void {
    if (!stopTimer) return;
    settle();
    stopTimer();
    stopTimer = null;
  }

  return {
    shown,
    bind(next) {
      if (next === key.peek()) return;
      halt();
      key.value = next;
    },
    setCounting(counting) {
      if (!counting) return halt();
      if (stopTimer || !shown.peek()) return;
      lastAt = now();
      stopTimer = every(UNDO_TICK_MS, () => {
        settle();
        if (!shown.peek()) halt();
      });
    },
    stop() {
      halt();
    },
  };
}
