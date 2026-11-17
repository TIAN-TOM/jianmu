// 悬停图标什么时候露出来：页面给了控制栏显隐的信号就跟着它；没给时，鼠标在播放器上动过就露几秒，移出去马上收。
// 鼠标停在图标上、图标上挂着提示时一直露着。只算状态，不碰页面。
export const REVEAL_MS = 3000;

export interface RevealTimers {
  readonly now: () => number;
  readonly set: (run: () => void, ms: number) => unknown;
  readonly clear: (timer: unknown) => void;
}

export interface RevealDeps {
  /** 露出或收起变了才调。 */
  readonly onChange: (shown: boolean) => void;
  readonly timers?: RevealTimers;
}

export interface Reveal {
  /** 页面的控制栏信号；null 是页面这会儿没给，退回看鼠标。 */
  readonly controls: (visible: boolean | null) => void;
  /** 鼠标在播放器上动了。 */
  readonly pointerMoved: () => void;
  /** 鼠标移出了播放器。 */
  readonly pointerLeft: () => void;
  /** 鼠标在不在图标上。 */
  readonly hover: (over: boolean) => void;
  /** 图标上挂没挂着提示。 */
  readonly hold: (held: boolean) => void;
  readonly shown: () => boolean;
  readonly stop: () => void;
}

const REAL_TIMERS: RevealTimers = {
  now: () => Date.now(),
  set: (run, ms) => setTimeout(run, ms),
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function createReveal({ onChange, timers = REAL_TIMERS }: RevealDeps): Reveal {
  let signal: boolean | null = null;
  let moved = false;
  let over = false;
  let held = false;
  let shown = false;
  let deadline = 0;
  let timer: unknown = null;

  function update(): void {
    const next = held || over || (signal ?? moved);
    if (next === shown) return;
    shown = next;
    onChange(next);
  }

  function disarm(): void {
    if (timer !== null) timers.clear(timer);
    timer = null;
  }

  // 鼠标每动一下只挪到点的时刻，计时器到点了再看还差多久：播放页上鼠标事件很密，不能每次都重排计时器。
  function expire(): void {
    timer = null;
    const left = deadline - timers.now();
    if (left > 0) {
      timer = timers.set(expire, left);
      return;
    }
    moved = false;
    update();
  }

  return {
    controls(visible) {
      signal = visible;
      update();
    },
    pointerMoved() {
      deadline = timers.now() + REVEAL_MS;
      if (timer === null) timer = timers.set(expire, REVEAL_MS);
      moved = true;
      update();
    },
    pointerLeft() {
      disarm();
      moved = false;
      over = false;
      update();
    },
    hover(next) {
      over = next;
      update();
    },
    hold(next) {
      held = next;
      update();
    },
    shown: () => shown,
    stop: disarm,
  };
}
