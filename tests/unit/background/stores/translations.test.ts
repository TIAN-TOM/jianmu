import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslationStore, translationId, type TranslationRecord } from "../../../../src/background/stores/translations.ts";
import { createClearGuard } from "../../../../src/core/clear-guard.ts";
import type { Derived, TranscriptRef } from "../../../../src/core/notes/records.ts";
import { videoKey, type VideoKey } from "../../../../src/core/video-ref.ts";
import { createMemoryDriver } from "../../../helpers/memory-driver.ts";

const part = (segment: number): VideoKey => videoKey({ platform: "bilibili", videoId: "BV1Sample000", segment });
const version = (fingerprint: string, video: VideoKey = part(1)): TranscriptRef => ({ video, kind: "human", lang: "zh-CN", fingerprint });
const DERIVED: Derived = {
  basis: { source: "transcript", transcript: version("aaaa000000000000") },
  gen: { feature: "rewrite", promptVersion: "v1", model: "m", effort: "off" },
};

function record(transcript: TranscriptRef, overrides: Partial<TranslationRecord> = {}): TranslationRecord {
  return { id: translationId(transcript, "en"), video: transcript.video, transcript, target: "en", segments: { h1: "Hello" }, derived: DERIVED, updatedAt: 100, ...overrides };
}

// 库里读出来的行不一定对得上记录类型，这里按坏记录造。
const badRow = (fields: Record<string, unknown>): TranslationRecord => ({ ...record(version("bbbb000000000000")), ...fields }) as TranslationRecord;

test("译文仓储按视频读、较早写的在前；主键对不上、目标语言认不出的滤掉，多出来的字段和空译文不往外带", async () => {
  const older = version("1111000000000000");
  const newer = version("2222000000000000");
  const driver = createMemoryDriver<TranslationRecord>("translations", [
    record(newer, { updatedAt: 300, segments: { h1: "Hi", h2: "" } }),
    record(older, { updatedAt: 200 }),
    record(version("3333000000000000", part(2)), { updatedAt: 400 }),
    badRow({ id: "伪造的主键", updatedAt: 500 }),
    badRow({ target: "fr", id: `${part(1)}|bbbb000000000000|fr`, updatedAt: 600 }),
    { ...record(version("4444000000000000")), url: "https://login.example/phish" } as TranslationRecord,
  ]);
  const store = createTranslationStore({ driver, guard: createClearGuard(), now: () => 1000 });
  const rows = await store.byVideo(part(1));
  assert.deepEqual(rows.map((row) => row.transcript.fingerprint), ["4444000000000000", "1111000000000000", "2222000000000000"]);
  assert.equal("url" in (rows[0] ?? {}), false);
  assert.deepEqual(rows[2]?.segments, { h1: "Hi" }, "空译文不算译过");
  assert.equal(await store.find(version("bbbb000000000000"), "en"), null);
  assert.ok(await store.find(older, "en"));
  assert.equal(await store.find(older, "zh"), null, "同一版字幕译成别的语言是另一条");
});

test("并进同一版记录：已有的段留着、新的段加上；清除过全部数据或写的一方说不要了就不写", async () => {
  const transcript = version("5555000000000000");
  const driver = createMemoryDriver<TranslationRecord>("translations", [record(transcript)]);
  const guard = createClearGuard();
  const store = createTranslationStore({ driver, guard, now: () => 2000 });
  assert.equal(await store.merge({ transcript, target: "en", segments: { h2: "World" }, derived: DERIVED }), true);
  assert.deepEqual((await store.find(transcript, "en"))?.segments, { h1: "Hello", h2: "World" });
  assert.equal((await store.find(transcript, "en"))?.updatedAt, 2000);

  assert.equal(await store.merge({ transcript, target: "en", segments: { h3: "Again" }, derived: DERIVED }, { still: () => false }), false);
  const since = guard.epoch();
  await guard.clear("all", () => driver.clear());
  assert.equal(await store.merge({ transcript, target: "en", segments: { h3: "Again" }, derived: DERIVED }, { since }), false);
  assert.deepEqual(await driver.getAll(), []);

  // 只清除缓存不清译文：清除之前开始的写照常写。
  const before = guard.epoch();
  await guard.clear("cache", async () => {});
  assert.equal(await store.merge({ transcript, target: "en", segments: { h3: "Again" }, derived: DERIVED }, { since: before }), true);
});
