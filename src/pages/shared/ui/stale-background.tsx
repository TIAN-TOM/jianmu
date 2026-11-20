/// <reference types="chrome" />
// 后台还是旧版本时整页只显示这一块：说清原因，一个按钮直接重新加载扩展，不用去扩展管理页。
import { render } from "preact";
import { sharedText } from "../text.ts";
import { StateBlock } from "./state-block.tsx";

export function StaleBackground({ onReload }: { readonly onReload: () => void }) {
  const t = sharedText().stale;
  return <StateBlock title={t.title} impact={t.impact} primary={{ label: t.reload, onClick: onReload, note: t.note }} />;
}

export function renderStaleBackground(root: HTMLElement, reload: () => void = () => chrome.runtime.reload()): void {
  render(<StaleBackground onReload={reload} />, root);
}
