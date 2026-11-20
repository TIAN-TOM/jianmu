// 粗筛页的状态行、确认的几行和导出按界面语言写：不给语言时是中文，选英文时是英文，导出的清单和文件名也跟着。数据都是自造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import { videoKey } from "../../../../src/core/video-ref.ts";
import type { UiLang } from "../../../../src/pages/shared/ui-lang.ts";
import { createTriageState, officialRecordText } from "../../../../src/pages/triage/state.ts";
import type { TriageSnapshot } from "../../../../src/shared/messages/batch.ts";

const KEY = videoKey({ platform: "bilibili", videoId: "BV1Sample001" });
const SNAPSHOT: TriageSnapshot = {
  list: { fetchedAt: 0, count: 1, items: [{ videoKey: KEY, title: "样例标题", ownerName: "样例作者", duration: 60, progress: 0, finished: false, pageCount: 1, available: true }] },
  official: {},
  verdicts: {},
  running: null,
};

function setup(lang?: UiLang) {
  const downloads: { filename: string; text: string }[] = [];
  const api = {
    send: async () => ({ ok: true, value: SNAPSHOT }),
    connect: () => ({ post: () => true, close() {}, isOpen: () => true }),
  };
  const state = createTriageState({
    api: api as never,
    videoUrl: () => "",
    videoBase: () => "https://video.example/",
    download: (filename, text) => void downloads.push({ filename, text }),
    now: () => 0,
    ...(lang ? { lang: () => lang } : {}),
  });
  return { state, downloads };
}

test("不给语言时状态行、确认和导出都是中文", async () => {
  const { state, downloads } = setup();
  await state.load();
  assert.match(state.listStatus.value?.text ?? "", /^共 1 个视频，读取于 .+。要看最新的列表就再读取一次。$/);
  assert.equal(state.officialStatus.value?.text, "有官方总结 0 个，还没取 1 个。");
  state.askOfficial();
  assert.equal(state.pending.value?.lines[0], "要逐个请求 1 个视频的 B 站官方总结。");
  state.exportMarkdown();
  assert.match(downloads[0]?.filename ?? "", /^简幕-稍后再看-\d{12}\.md$/);
  assert.ok(downloads[0]?.text.startsWith("# 稍后再看粗筛\n"));
});

test("选英文时状态行、确认和导出都是英文", async () => {
  const { state, downloads } = setup("en");
  await state.load();
  assert.match(state.listStatus.value?.text ?? "", /^1 video, read .+\. Read it again to get the latest list\.$/);
  assert.equal(state.officialStatus.value?.text, "0 with an official summary, 1 not fetched yet.");
  state.askOfficial();
  assert.deepEqual(state.pending.value?.lines, [
    "Jianmu will request the Bilibili official summary for 1 video, one by one.",
    "Doesn't use the model or any API credit. One at a time, at least 1 second apart, so it takes about 1 minute or more.",
    "You can stop at any time. Closing this page stops it too.",
  ]);
  state.exportMarkdown();
  assert.match(downloads[0]?.filename ?? "", /^jianmu-watch-later-\d{12}\.md$/);
  assert.ok(downloads[0]?.text.startsWith("# Watch Later triage\n"));
});

test("视频行上官方总结的状态按语言写", () => {
  const item = SNAPSHOT.list?.items[0];
  assert.ok(item);
  assert.equal(officialRecordText(undefined, item), "还没取官方总结");
  assert.equal(officialRecordText(undefined, item, "en"), "Official summary not fetched yet");
  assert.equal(officialRecordText({ status: "queued" } as never, item, "en"), "Bilibili has no official summary for this video yet. You can come back to it later");
});
