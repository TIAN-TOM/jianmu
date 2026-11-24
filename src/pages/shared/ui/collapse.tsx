// 展开收起：外层的高度在零和内容那么高之间过渡，里面那层跟着淡入淡出，过渡到一半时多出来的裁掉。
// 收起时内容留到过渡走完才拿掉，这期间点不到、读屏也读不到；没有过渡（系统设了减少动态效果）就马上拿掉。
// 展开走完以后里面那层不再裁切，聚焦光圈和贴边的东西露得出来。样式在 ui/motion.css。
import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { motionMs } from "./presence.ts";

export interface CollapseProps {
  readonly open: boolean;
  /** 外层和里面那层另加的类名，页面用它们放自己的版式。 */
  readonly outerClass?: string;
  readonly innerClass?: string;
  /** 内容；给函数时只在要画的时候才算，收着的不花工夫。 */
  readonly children: ComponentChildren | (() => ComponentChildren);
}

export function Collapse({ open, outerClass = "", innerClass = "", children }: CollapseProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [gone, setGone] = useState(!open);
  const [settled, setSettled] = useState(open);

  useLayoutEffect(() => {
    // 这时 data-open 已经写上，量到的是这一次要走的那段过渡。
    const wait = motionMs(ref.current);
    if (open) setGone(false);
    setSettled(open && wait <= 0);
    if (!open && wait <= 0) setGone(true);
    if (wait <= 0) return;
    // 过渡被别的样式打断时不一定有结束事件：到点还没收尾就按走完算。
    const timer = setTimeout(() => (open ? setSettled(true) : setGone(true)), wait + 100);
    return () => clearTimeout(timer);
  }, [open]);

  const shown = open || !gone;
  return (
    <div
      ref={ref}
      class={`collapse ${outerClass}`.trim()}
      data-open={open ? "true" : "false"}
      data-settled={open && settled ? "true" : undefined}
      onTransitionEnd={(event) => {
        if (event.target !== event.currentTarget || event.propertyName !== "grid-template-rows") return;
        if (open) setSettled(true);
        else setGone(true);
      }}
    >
      <div class={`collapse-in ${innerClass}`.trim()} inert={!open}>
        {shown ? (typeof children === "function" ? children() : children) : null}
      </div>
    </div>
  );
}
