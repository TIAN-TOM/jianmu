// 设置页这头的备份传输：后台中途断开、说了原因再断开、条数对不上、回的段号不对，都判失败，不会一直等，也不把失败当成功。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ImportedBackup } from "../../../../src/core/backup/records.ts";
import type { ErrorCode } from "../../../../src/core/errors.ts";
import type { NoteRecord } from "../../../../src/core/notes/records.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";
import { receiveBackup, sendBackup } from "../../../../src/pages/options/backup-transfer.ts";
import type { PageApi, PortHandlers } from "../../../../src/pages/shared/api.ts";

const VIDEO = videoKey({ platform: "bilibili", videoId: "BV1Sample000", segment: 1 });

const note = (index: number): NoteRecord => ({
  id: `note_${index}`,
  kind: "note",
  origin: "user",
  video: VIDEO,
  snapshot: { title: "样例", author: "作者" },
  atSec: index,
  text: `笔记 ${index}`,
  createdAt: 1,
  updatedAt: 2,
});

interface Script {
  /** 页面每发一条，后台怎么回：发事件、断开，或者什么都不做。 */
  readonly onPost: (message: { readonly type: string; readonly seq?: number }, reply: Reply) => void;
}

interface Reply {
  event(event: unknown): void;
  close(code?: ErrorCode): void;
}

/** 造一个只接一条长连接的消息客户端，后台那头按脚本回；事件另起一轮送到，和浏览器一样。 */
function fakeApi(script: Script): { readonly api: Pick<PageApi, "connect">; readonly posted: unknown[]; closedByPage: () => boolean } {
  const posted: unknown[] = [];
  let pageClosed = false;
  const api: Pick<PageApi, "connect"> = {
    connect: (_name, handlers: PortHandlers<never>) => {
      let open = true;
      const reply: Reply = {
        event: (event) => setImmediate(() => open && handlers.onEvent(event as never)),
        close: (code = "BACKGROUND_DROPPED") =>
          setImmediate(() => {
            if (!open) return;
            open = false;
            handlers.onClose?.(code);
          }),
      };
      return {
        post(message) {
          if (!open) return false;
          posted.push(message);
          script.onPost(message as never, reply);
          return true;
        },
        close() {
          open = false;
          pageClosed = true;
        },
        isOpen: () => open,
      };
    },
  };
  return { api, posted, closedByPage: () => pageClosed };
}

const COUNTS = { notes: 2, overviews: 0, qa: 0, translations: 0 };

test("导出：报完条数、发完各段再报完才算成功，页面关掉连接", async () => {
  const fake = fakeApi({
    onPost(_message, reply) {
      reply.event({ type: "head", exportedAt: "2026-11-19T00:00:00.000Z", counts: COUNTS });
      reply.event({ type: "part", part: { kind: "notes", records: [note(1)] } });
      reply.event({ type: "part", part: { kind: "notes", records: [note(2)] } });
      reply.event({ type: "end" });
    },
  });
  const result = await receiveBackup(fake.api);
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(result.value.notes.map(({ id }) => id), ["note_1", "note_2"]);
  assert.deepEqual(Object.keys(result.value), ["kind", "version", "exportedAt", "notes", "overviews", "qa", "translations"]);
  assert.deepEqual(fake.posted, [{ type: "start" }]);
  assert.equal(fake.closedByPage(), true);
});

test("导出：中途断开、说了原因再断开、条数和开头报的对不上，都判失败", async () => {
  const cases: [string, Script["onPost"], ErrorCode][] = [
    [
      "发了一段就断开",
      (_message, reply) => {
        reply.event({ type: "head", exportedAt: "x", counts: COUNTS });
        reply.event({ type: "part", part: { kind: "notes", records: [note(1)] } });
        reply.close();
      },
      "BACKGROUND_DROPPED",
    ],
    ["开头之前就说了原因", (_message, reply) => (reply.event({ type: "port.error", code: "BACKGROUND_FAILED" }), reply.close("BACKGROUND_FAILED")), "BACKGROUND_FAILED"],
    [
      "少了一段就报完",
      (_message, reply) => {
        reply.event({ type: "head", exportedAt: "x", counts: COUNTS });
        reply.event({ type: "part", part: { kind: "notes", records: [note(1)] } });
        reply.event({ type: "end" });
      },
      "BACKGROUND_DROPPED",
    ],
  ];
  for (const [label, onPost, code] of cases) {
    assert.deepEqual(await receiveBackup(fakeApi({ onPost }).api), { ok: false, code }, label);
  }
});

const imported = (notes: readonly NoteRecord[]): ImportedBackup => ({
  format: "jianmu",
  contents: { notes, overviews: [], qa: [], translations: [] },
  skipped: { notes: 1, overviews: 0, qa: 0, translations: 0 },
  promptsDropped: false,
});

test("导入：一段回了才发下一段；计数按主键去重，页面读时跳过的和后台跳过的加在一起", async () => {
  const fake = fakeApi({
    onPost(message, reply) {
      // 同一条在后面一段又补过：仍算新增一条。
      reply.event({ type: "merged", seq: message.seq, added: ["note_1"], updated: message.seq ? ["note_1"] : [], skipped: 1 });
    },
  });
  const notes = Array.from({ length: 3 }, (_, index) => ({ ...note(1), text: "很长的笔记".repeat(2_000_000) + index }));
  const result = await sendBackup(fake.api, imported(notes));
  assert.ok(result.ok, JSON.stringify(result));
  assert.ok(fake.posted.length > 1, "切成了好几段");
  assert.deepEqual(fake.posted.map((message) => (message as { seq: number }).seq), [...fake.posted.keys()]);
  assert.deepEqual(result.value.counts.notes, { added: 1, updated: 0, skipped: 1 + fake.posted.length });
  assert.equal(fake.closedByPage(), true);
});

test("导入：后台说了原因、中途断开、回的段号不对，都判失败，不再发下一段", async () => {
  const notes = [note(1), note(2)];
  const cases: [string, Script["onPost"], ErrorCode][] = [
    ["存储写满", (_message, reply) => (reply.event({ type: "port.error", code: "STORAGE_FULL" }), reply.close("STORAGE_FULL")), "STORAGE_FULL"],
    ["清除过", (_message, reply) => (reply.event({ type: "port.error", code: "LOCAL_DATA_CLEARED" }), reply.close("LOCAL_DATA_CLEARED")), "LOCAL_DATA_CLEARED"],
    ["没回就断开", (_message, reply) => reply.close(), "BACKGROUND_DROPPED"],
    ["回的段号不对", (message, reply) => reply.event({ type: "merged", seq: (message.seq ?? 0) + 1, added: [], updated: [], skipped: 0 }), "BACKGROUND_DROPPED"],
  ];
  for (const [label, onPost, code] of cases) {
    const fake = fakeApi({ onPost });
    assert.deepEqual(await sendBackup(fake.api, imported(notes)), { ok: false, code }, label);
    assert.equal(fake.posted.length, 1, `${label}：不再发下一段`);
  }
});

test("导入：文件里一条都没有就不连后台，计数是读文件时跳过的", async () => {
  const fake = fakeApi({ onPost: () => assert.fail("不该连后台") });
  const result = await sendBackup(fake.api, imported([]));
  assert.deepEqual(result.ok && result.value.counts.notes, { added: 0, updated: 0, skipped: 1 });
});
