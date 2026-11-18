// 记笔记的快捷键：只认不带修饰键的那一个键。YouTube 上 Shift 加这个键是站点自己的快捷键，不能顺带存笔记。
import assert from "node:assert/strict";
import { test } from "node:test";
import { listenShortcut } from "../../../src/content/shortcut.ts";

// 浏览器的按键事件改不了 isTrusted，替身直接把造好的事件交给监听。
class FakeDocument {
  activeElement = null;
  readonly listeners = new Set<(event: unknown) => void>();
  addEventListener(_type: string, listener: (event: unknown) => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: string, listener: (event: unknown) => void): void {
    this.listeners.delete(listener);
  }
}

function press(document: FakeDocument, init: { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; repeat?: boolean }) {
  const event = {
    isTrusted: true,
    target: null,
    preventDefault: () => undefined,
    key: init.key,
    shiftKey: init.shiftKey ?? false,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    altKey: init.altKey ?? false,
    repeat: init.repeat ?? false,
    isComposing: false,
    composedPath: () => [],
  };
  for (const listener of document.listeners) listener(event);
}

test("只认不带修饰键、不是按住连发的那一下", () => {
  const document = new FakeDocument();
  let presses = 0;
  const stop = listenShortcut({ document: document as unknown as Document, key: "n", onPress: () => (presses += 1) });
  press(document, { key: "n" });
  press(document, { key: "N", shiftKey: true });
  press(document, { key: "n", ctrlKey: true });
  press(document, { key: "n", metaKey: true });
  press(document, { key: "n", altKey: true });
  press(document, { key: "n", repeat: true });
  press(document, { key: "m" });
  assert.equal(presses, 1);
  stop();
  press(document, { key: "n" });
  assert.equal(presses, 1);
});
