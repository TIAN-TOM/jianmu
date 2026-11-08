// 底部工具条：提问框在两种模式下都在同一个位置，右边放各模式自己的操作，窄到放不下时换行。
import type { ComponentChildren } from "preact";

export function Dock({ children }: { readonly children: ComponentChildren }) {
  return <div class="dock">{children}</div>;
}
