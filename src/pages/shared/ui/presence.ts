// 离场：要拿掉的东西先留在页面上，挂着 data-leaving 播完离场的过渡再拿掉；离场途中又要出现就直接接回来。
// 等多久按节点上算出来的过渡和动画时长定，系统设了减少动态效果、时长是零时当场拿掉，不多留一帧。
import { useLayoutEffect, useRef, useState } from "preact/hooks";

/** 节点上最长的那段过渡或动画（含延迟）要多少毫秒。 */
export function motionMs(node: Element | null): number {
  const view = node?.ownerDocument.defaultView;
  if (!node || !view) return 0;
  const style = view.getComputedStyle(node);
  const longest = (durations: string, delays: string): number => {
    const times = (list: string): number[] => list.split(",").map((part) => (part.trim().endsWith("ms") ? parseFloat(part) : parseFloat(part) * 1000) || 0);
    const ds = times(durations);
    const ls = times(delays);
    return Math.max(0, ...ds.map((duration, index) => (duration > 0 ? duration + (ls[index % ls.length] ?? 0) : 0)));
  };
  return Math.max(longest(style.transitionDuration, style.transitionDelay), longest(style.animationDuration, style.animationDelay));
}

export interface Presence<T> {
  /** 该画出来的值：在场时是传进来的，离场途中是最后一个在场的值，走完是 null。 */
  readonly shown: T | null;
  readonly leaving: boolean;
  /** 挂在离场时播过渡的那个节点上，用来量要等多久。 */
  readonly ref: { current: HTMLElement | null };
}

export function usePresence<T>(value: T | null | undefined): Presence<T> {
  const kept = useRef<T | null>(value ?? null);
  const ref = useRef<HTMLElement | null>(null);
  const [, settle] = useState(0);
  if (value !== null && value !== undefined) kept.current = value;
  const leaving = (value === null || value === undefined) && kept.current !== null;

  useLayoutEffect(() => {
    if (!leaving) return;
    const done = (): void => {
      kept.current = null;
      settle((count) => count + 1);
    };
    // 这时 data-leaving 已经写上，量到的是离场那一段；量不到或者是零就当场拿掉，免得多留一帧。
    const wait = motionMs(ref.current);
    if (wait <= 0) return done();
    const timer = setTimeout(done, wait + 20);
    return () => clearTimeout(timer);
  }, [leaving]);

  return { shown: value ?? kept.current, leaving, ref };
}
