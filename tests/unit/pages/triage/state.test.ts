// 粗筛页的状态：别的页面正在跑一步时，打开这一页要接上那一步，而不只是开着端口。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createTriageState } from "../../../../src/pages/triage/state.ts";
import type { PortHandlers } from "../../../../src/pages/shared/api.ts";
import type { BatchIn, TriageSnapshot } from "../../../../src/shared/messages/batch.ts";

function fakeApi(snapshot: TriageSnapshot) {
  const posted: BatchIn[] = [];
  let handlers: PortHandlers<"batch"> | null = null;
  const api = {
    send: async () => ({ ok: true, value: snapshot }),
    connect(_name: "batch", next: PortHandlers<"batch">) {
      handlers = next;
      return { post: (message: BatchIn) => (posted.push(message), true), close() {}, isOpen: () => true };
    },
  };
  return { api, posted, emit: (event: Parameters<PortHandlers<"batch">["onEvent"]>[0]) => handlers?.onEvent(event) };
}

const deps = { videoUrl: () => "", videoBase: () => "", download() {} };

test("打开时别的页面正在取官方总结：发同一步的开始接上它，进度和收尾这一页都收得到", async () => {
  const fake = fakeApi({ list: { fetchedAt: 1, count: 0, items: [] }, official: {}, verdicts: {}, running: "official" });
  const state = createTriageState({ api: fake.api as never, ...deps });
  await state.load();
  assert.deepEqual(fake.posted, [{ type: "triage.start", step: "official" }]);
  fake.emit({ type: "triage.started", step: "official", total: 3, skipped: 0, joined: true });
  assert.equal(state.running.value, "official");
  assert.match(state.officialStatus.value?.text ?? "", /接上了另一页/);
  fake.emit({ type: "triage.done", step: "official", done: 3, total: 3 });
  assert.equal(state.running.value, null);
});

test("打开时没有在跑的一步：不连端口、不发消息", async () => {
  const fake = fakeApi({ list: null, official: {}, verdicts: {}, running: null });
  const state = createTriageState({ api: fake.api as never, ...deps });
  await state.load();
  assert.deepEqual(fake.posted, []);
});
