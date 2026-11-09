import assert from "node:assert/strict";
import { test } from "node:test";
import { createQaStore } from "../../../../src/background/stores/qa.ts";
import { createClearGuard, NO_CLEAR_GUARD } from "../../../../src/core/clear-guard.ts";
import type { QaRecord } from "../../../../src/core/notes/records.ts";
import { videoKey, type VideoKey } from "../../../../src/core/video-ref.ts";
import { createMemoryDriver } from "../../../helpers/memory-driver.ts";

const part = (segment: number): VideoKey => videoKey({ platform: "bilibili", videoId: "BV1Sample000", segment });

function entry(id: string, overrides: Partial<QaRecord> = {}): QaRecord {
  return {
    id,
    video: part(1),
    question: "讲了什么",
    answer: "讲了番茄 [0:05]",
    citations: [{ startSeconds: 5, quote: "番茄要晒太阳" }],
    clickable: [5],
    derived: { basis: { source: "legacy-unknown" } },
    createdAt: 1000,
    ...overrides,
  };
}

// 库里读出来的行不一定对得上记录类型，这里按坏记录造。
const badRow = (id: string, fields: Record<string, unknown>): QaRecord => ({ ...entry(id), ...fields }) as QaRecord;

test("问答仓储按视频读、最新的在前；坏记录滤掉，多出来的字段不往外带", async () => {
  const driver = createMemoryDriver<QaRecord>("qa", [
    entry("qa_old", { createdAt: 100 }),
    entry("qa_new", { createdAt: 300 }),
    entry("qa_other_part", { video: part(2), createdAt: 400 }),
    badRow("note_1", { createdAt: 500 }),
    badRow("qa_bad_video", { video: "认不出", createdAt: 600 }),
    badRow("qa_bad_citation", { citations: [{ startSeconds: "5", quote: "x" }], createdAt: 700 }),
    badRow("qa_extra", { createdAt: 200, url: "https://login.example/phish", answer: "带了多余字段" }),
  ]);
  const store = createQaStore({ driver, guard: NO_CLEAR_GUARD });
  const rows = await store.byVideo(part(1));
  assert.deepEqual(rows.map((row) => row.id), ["qa_new", "qa_extra", "qa_old"]);
  assert.equal("url" in (rows[1] ?? {}), false);
  assert.deepEqual((await store.all()).map((row) => row.id), ["qa_other_part", "qa_new", "qa_extra", "qa_old"]);
});

test("问答仓储写入经清除闸门：开头记下的代数之后清除过就不写；删一条只删这一条", async () => {
  const guard = createClearGuard();
  const driver = createMemoryDriver<QaRecord>("qa");
  const store = createQaStore({ driver, guard });
  const since = guard.epoch();
  await guard.clear("all", async () => {});
  assert.equal(await store.commit({ put: [entry("qa_late")] }, { since }), false);
  assert.deepEqual(await driver.getAll(), []);

  assert.equal(await store.commit({ put: [entry("qa_a"), entry("qa_b", { createdAt: 2000 })] }), true);
  assert.equal(await store.commit({ remove: ["qa_a"] }), true);
  assert.deepEqual((await store.byVideo(part(1))).map((row) => row.id), ["qa_b"]);
});
