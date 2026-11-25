// 吸顶的几层叠在一起：每层量自己的高度，写进侧边栏外壳上的一个 CSS 变量，下面那层按它往下排。
// 高度会变（提示条一行或两行、换了语言、字号），所以一直跟着量；这一层卸掉时变量写回 0。
import { useEffect, useRef } from "preact/hooks";

/** 挂到吸顶的那一层上；name 是写到 .panel 上的变量名，比如 --panel-top-h。这一层有时不渲染时，shown 跟着给。 */
export function useStickyHeight<T extends HTMLElement>(name: string, shown = true) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const node = ref.current;
    const host = node?.closest<HTMLElement>(".panel");
    if (!node || !host) return;
    // 按带小数的实际高度写：取整（offsetHeight）会让下一层错开半个像素，滚过去的字幕从缝里露出来。
    const write = (height: number): void => host.style.setProperty(name, `${height}px`);
    write(node.getBoundingClientRect().height);
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver((entries) => write(entries[0]?.borderBoxSize?.[0]?.blockSize ?? node.getBoundingClientRect().height));
    observer?.observe(node);
    return () => {
      observer?.disconnect();
      host.style.setProperty(name, "0px");
    };
  }, [name, shown]);
  return ref;
}
