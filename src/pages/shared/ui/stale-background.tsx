/// <reference types="chrome" />
// 后台还是旧版本时整页只显示这一块：说清原因，一个按钮直接重新加载扩展，不用去扩展管理页。
import { render } from "preact";
import { StateBlock } from "./state-block.tsx";

export const STALE_COPY = {
  title: "简幕需要重新加载",
  impact: "简幕的文件更新了，后台还在跑旧版本，这个页面先用不了。重新加载后笔记和概览都在；没选「在这台电脑上记住密钥」的话，要再填一次密钥。",
  reload: "重新加载简幕",
  note: "开着的简幕页面会关掉，再打开就好",
} as const;

export function StaleBackground({ onReload }: { readonly onReload: () => void }) {
  return <StateBlock title={STALE_COPY.title} impact={STALE_COPY.impact} primary={{ label: STALE_COPY.reload, onClick: onReload, note: STALE_COPY.note }} />;
}

export function renderStaleBackground(root: HTMLElement, reload: () => void = () => chrome.runtime.reload()): void {
  render(<StaleBackground onReload={reload} />, root);
}
