import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration, officialStatusText, progressText, toMarkdown } from "../../../../src/core/triage/export.ts";
import type { TriageVerdict } from "../../../../src/core/triage/groups.ts";
import type { TriageItem } from "../../../../src/core/triage/state.ts";
import { videoKey, type VideoKey } from "../../../../src/core/video-ref.ts";

const VIDEO_BASE = "https://video.example/";
const KEY = videoKey({ platform: "bilibili", videoId: "BV1Sample000" });

const item = (extra: Partial<TriageItem> = {}): TriageItem => ({
  videoKey: KEY,
  title: "标题",
  ownerName: "UP 主",
  duration: 600,
  progress: 0,
  finished: false,
  pageCount: 1,
  available: true,
  ...extra,
});

const verdictOf = (label: string, extra: TriageVerdict = {}): TriageVerdict => ({
  summary: `讲了 ${label}`,
  value: "核心价值",
  verdict: label,
  reason: "判断理由",
  source: "official",
  ...extra,
});

test("导出：概览写的结论注明来源，没有理由时不写空行", () => {
  const markdown = toMarkdown(
    {
      items: [item()],
      verdicts: { [KEY]: verdictOf("可跳过", { source: undefined, reason: "", value: "" }) },
      exportedAt: 0,
    },
    VIDEO_BASE,
  );
  assert.match(markdown, /## 可跳过（1）/);
  assert.match(markdown, /结论：讲了 可跳过（基于概览）\n$/);
  assert.doesNotMatch(markdown, /理由|核心价值/);
});

test("没有标题时用视频编号，键认不出时原样用键", () => {
  const titled = toMarkdown({ items: [item({ title: "" })], exportedAt: 0 }, VIDEO_BASE);
  assert.ok(titled.includes(`[BV1Sample000](${VIDEO_BASE}BV1Sample000)`));
  const odd = toMarkdown({ items: [item({ videoKey: "认不出" as VideoKey, title: "" })], exportedAt: 0 }, VIDEO_BASE);
  assert.ok(odd.includes(`[认不出](${VIDEO_BASE}认不出)`));
});

test("时长、观看进度和官方总结状态的文字", () => {
  assert.equal(formatDuration(59), "0:59");
  assert.equal(formatDuration(3725), "1:02:05");
  assert.equal(progressText(item({ progress: 150, duration: 600 })), "看到 2:30（25%）");
  assert.equal(progressText(item({ progress: 150, pageCount: 3 })), "看到 2:30");
  assert.equal(progressText(item({ finished: true })), "已看完");
  assert.equal(progressText(item()), "还没看");

  assert.equal(officialStatusText(undefined), "还没取官方总结");
  assert.equal(officialStatusText({ status: "queued" }), "B站现在没有这个视频的官方总结");
  assert.equal(officialStatusText({ status: "failed", reason: "TIMEOUT" }), "请求失败，再点开始会重试（TIMEOUT）");
  assert.equal(officialStatusText({ status: "ok", summary: "" }), "没有官方总结");
  assert.equal(officialStatusText({ status: "weird" }), "请求失败，再点开始会重试");
});

test("导出：旧版留下的「看概览就够」单列一组，排在四档之后；旧名字的两档并进新名字的组", () => {
  const items = ["001", "002", "003"].map((id) => item({ videoKey: videoKey({ platform: "bilibili", videoId: `BV1Sample${id}` }), title: `标题 ${id}` }));
  const markdown = toMarkdown(
    {
      items,
      verdicts: {
        [items[0]!.videoKey]: verdictOf("看概览就够"),
        [items[1]!.videoKey]: verdictOf("值得看完整视频"),
        [items[2]!.videoKey]: verdictOf("推荐看"),
      },
      exportedAt: 0,
    },
    VIDEO_BASE,
  );
  const headings = [...markdown.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
  assert.deepEqual(headings, ["推荐看（2）", "看概览就够（1）"]);
});
