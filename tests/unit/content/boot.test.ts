// 两个站入口共用的启动：先撤下旧的一份再建新的，标签页切回前台、媒体开始加载时通知应用。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ContentApp } from "../../../src/content/app.ts";
import { mediaLoading, pageVisibility, replaceInstance } from "../../../src/content/boot.ts";
import { INJECTED } from "../../../src/shared/names.ts";

function fakeApp(name: string, log: string[]): ContentApp {
  return {
    start: () => void log.push(`${name}.start`),
    stop: () => void log.push(`${name}.stop`),
    gate: () => {
      throw new Error("不该问闸门");
    },
  };
}

test("先撤下登记着的旧一份，再建新的、登记、启动", () => {
  const log: string[] = [];
  const registry: { [INJECTED.instance]?: ContentApp } = { [INJECTED.instance]: fakeApp("old", log) };
  const fresh = fakeApp("new", log);
  replaceInstance(registry, () => {
    log.push("build");
    assert.notEqual(registry[INJECTED.instance], fresh, "建好之前不登记");
    return fresh;
  });
  assert.deepEqual(log, ["old.stop", "build", "new.start"]);
  assert.equal(registry[INJECTED.instance], fresh);
});

test("没有旧的一份时直接建新的", () => {
  const log: string[] = [];
  const registry: { [INJECTED.instance]?: ContentApp } = {};
  replaceInstance(registry, () => fakeApp("new", log));
  assert.deepEqual(log, ["new.start"]);
});

test("标签页切回前台时通知应用，切到后台不通知，取消以后不再通知", () => {
  const doc = Object.assign(new EventTarget(), { hidden: true });
  const visibility = pageVisibility(doc);
  let runs = 0;
  const off = visibility.onChange(() => void (runs += 1));
  assert.equal(visibility.hidden(), true);
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(runs, 0);
  doc.hidden = false;
  assert.equal(visibility.hidden(), false);
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(runs, 1);
  off();
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(runs, 1);
});

test("媒体开始加载在捕获阶段听到，取消以后不再通知", () => {
  const calls: [string, boolean | undefined][] = [];
  const target = new EventTarget();
  const doc = {
    addEventListener: (type: string, run: () => void, capture?: boolean) => {
      calls.push([`add ${type}`, capture]);
      target.addEventListener(type, run, capture);
    },
    removeEventListener: (type: string, run: () => void, capture?: boolean) => {
      calls.push([`remove ${type}`, capture]);
      target.removeEventListener(type, run, capture);
    },
  } as unknown as Pick<Document, "addEventListener" | "removeEventListener">;
  let runs = 0;
  const off = mediaLoading(doc)(() => void (runs += 1));
  target.dispatchEvent(new Event("loadstart"));
  off();
  target.dispatchEvent(new Event("loadstart"));
  assert.equal(runs, 1);
  assert.deepEqual(calls, [
    ["add loadstart", true],
    ["remove loadstart", true],
  ]);
});
