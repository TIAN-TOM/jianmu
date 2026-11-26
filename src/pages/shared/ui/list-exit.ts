// 列表里删掉一条：那一条先留在原来的位置淡掉、高度收成零，下面的跟着平滑上移，播完才拿掉；离场途中点不到、读屏也读不到。
// 只有事先说好要删的那一条（expect）这样走，筛选、换范围、换视频时不在了的照旧当场拿掉；删除没成就 cancel。
// 离场途中同一条又出现就接回来。等多久按节点上算出来的动画时长定（presence.ts 的 motionMs），
// 系统设了减少动态效果、时长是零时当场拿掉。样式在 ui/motion.css 的 .exit-list。
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { motionMs } from "./presence.ts";

export interface ExitRow<T> {
  readonly key: string;
  /** 在场时是传进来的那一条，离场途中是它最后一次在场时的样子。 */
  readonly item: T;
  readonly leaving: boolean;
  /** 离场从多高开始收，在场时是零。 */
  readonly height: number;
}

/**
 * 把这一次的条目和上一次画出来的行合起来：在场的照新的顺序排，要离场的留在它原来的前后之间。
 * `leave` 说一行不在了以后要不要留着播离场：给高度就留，给 null 就当场拿掉。
 */
export function mergeRows<T>(previous: readonly ExitRow<T>[], items: readonly T[], keyOf: (item: T) => string, leave: (row: ExitRow<T>) => number | null): ExitRow<T>[] {
  const present = new Set(items.map(keyOf));
  const rows: ExitRow<T>[] = [];
  const live = (item: T): ExitRow<T> => ({ key: keyOf(item), item, leaving: false, height: 0 });
  let next = 0;
  for (const row of previous) {
    if (present.has(row.key)) {
      // 新列表里排在这一行前面、还没摆的，先摆上，再摆它自己。
      while (next < items.length) {
        const item = items[next++] as T;
        rows.push(live(item));
        if (keyOf(item) === row.key) break;
      }
      continue;
    }
    const height = leave(row);
    if (height !== null) rows.push({ key: row.key, item: row.item, leaving: true, height });
  }
  while (next < items.length) rows.push(live(items[next++] as T));
  return rows;
}

export interface ExitRowProps {
  readonly ref: (node: HTMLElement | null) => void;
  readonly "data-leaving"?: "";
  readonly inert?: true;
  readonly style?: string;
}

export interface ListExit<T> {
  readonly rows: readonly ExitRow<T>[];
  /** 展开到每一行的 <li> 上：量高度、标离场、离场途中点不到。 */
  rowProps(row: ExitRow<T>): ExitRowProps;
  /** 马上要删这一条：下一次它从列表里没了，就播完离场再拿掉。 */
  expect(key: string): void;
  /** 没删成：它以后再不在了也当场拿掉。 */
  cancel(key: string): void;
}

export function useListExit<T>(items: readonly T[], keyOf: (item: T) => string): ListExit<T> {
  const nodes = useRef(new Map<string, HTMLElement>());
  const refs = useRef(new Map<string, (node: HTMLElement | null) => void>());
  const expected = useRef(new Map<string, number>());
  const finished = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const previous = useRef<readonly ExitRow<T>[]>([]);
  const [, settle] = useState(0);

  const rows = mergeRows(previous.current, items, keyOf, (row) => {
    if (row.leaving) return finished.current.has(row.key) ? null : row.height;
    return expected.current.get(row.key) ?? null;
  });
  previous.current = rows;
  // 走完的这一次都拿掉了（或者又出现、接了回来）；说好要删的，开始离场就算用掉了。
  finished.current.clear();
  for (const row of rows) if (row.leaving) expected.current.delete(row.key);

  useLayoutEffect(() => {
    const leaving = new Set(rows.filter((row) => row.leaving).map((row) => row.key));
    for (const [key, timer] of timers.current) {
      if (leaving.has(key)) continue;
      clearTimeout(timer);
      timers.current.delete(key);
    }
    let done = false;
    for (const key of leaving) {
      if (timers.current.has(key)) continue;
      // 这时 data-leaving 已经写上，量到的是离场那一段；量不到或者是零就当场拿掉，不多留一帧。
      const wait = motionMs(nodes.current.get(key) ?? null);
      if (wait <= 0) {
        finished.current.add(key);
        done = true;
        continue;
      }
      timers.current.set(
        key,
        setTimeout(() => {
          timers.current.delete(key);
          finished.current.add(key);
          settle((count) => count + 1);
        }, wait + 20),
      );
    }
    if (done) settle((count) => count + 1);
  });

  useLayoutEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
  }, []);

  const refOf = (key: string): ((node: HTMLElement | null) => void) => {
    let ref = refs.current.get(key);
    if (!ref) {
      ref = (node) => {
        if (node) nodes.current.set(key, node);
        else {
          nodes.current.delete(key);
          refs.current.delete(key);
        }
      };
      refs.current.set(key, ref);
    }
    return ref;
  };

  return {
    rows,
    rowProps: (row) => (row.leaving ? { ref: refOf(row.key), "data-leaving": "", inert: true, style: `--leave-h: ${row.height}px` } : { ref: refOf(row.key) }),
    expect(key) {
      // 趁它还在、版面还是删之前的样子，量好从多高开始收。
      const node = nodes.current.get(key);
      if (node) expected.current.set(key, node.getBoundingClientRect().height);
    },
    cancel(key) {
      expected.current.delete(key);
    },
  };
}
