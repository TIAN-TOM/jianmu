// 粗筛的导出按语言出固定文字：缺省和选中文时和原来逐字一样；英文时标题、分组名、说明是英文，
// 视频标题、UP 主名、官方总结和模型写的结论原样写；文件名按语言给。数据都是自造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import { exportFileName, formatDateTime, officialStatusText, progressText, toMarkdown } from "../../../../src/core/triage/export.ts";
import { verdictName } from "../../../../src/core/ai/verdict.ts";
import { GROUPS, groupName, type TriageVerdict } from "../../../../src/core/triage/groups.ts";
import type { OfficialRecord, TriageItem } from "../../../../src/core/triage/state.ts";
import { videoKey, type VideoKey } from "../../../../src/core/video-ref.ts";

const VIDEO_BASE = "https://video.example/";
const keyOf = (name: string): VideoKey => videoKey({ platform: "bilibili", videoId: `BV1Sample${name.padStart(3, "0")}` });

const item = (name: string, extra: Partial<TriageItem> = {}): TriageItem => ({
  videoKey: keyOf(name),
  title: `样例标题 ${name}`,
  ownerName: "样例作者",
  duration: 600,
  progress: 0,
  finished: false,
  pageCount: 1,
  available: true,
  ...extra,
});

const OK: OfficialRecord = { status: "ok", summary: "自造的官方总结", outline: [] };
const verdict = (label: string, extra: TriageVerdict = {}): TriageVerdict => ({ summary: "自造的结论", value: "自造的价值", verdict: label, reason: "自造的理由", source: "official", ...extra });

const INPUT = {
  items: [item("1"), item("2"), item("3"), item("4", { available: false }), item("5")],
  official: { [keyOf("2")]: OK, [keyOf("5")]: { status: "failed", reason: "NETWORK" } as OfficialRecord },
  verdicts: { [keyOf("1")]: verdict("推荐看"), [keyOf("3")]: verdict("看概览就够", { source: undefined }) },
  exportedAt: 0,
};

test("导出：不传语言和传中文逐字一样，固定文字是中文", () => {
  const zh = toMarkdown(INPUT, VIDEO_BASE, "zh");
  assert.equal(toMarkdown(INPUT, VIDEO_BASE, "zh"), zh);
  assert.ok(zh.startsWith("# 稍后再看粗筛\n\n导出于 "));
  assert.match(zh, /共 5 个视频。/);
  assert.match(zh, /^## ★★★★★ 推荐看（1）$/m);
  assert.match(zh, /^ {2}- 结论：自造的结论（基于 B站官方总结）$/m);
  assert.match(zh, /^ {2}- 官方总结：自造的官方总结$/m);
  assert.match(zh, /^ {2}- 请求失败，再点开始会重试（NETWORK）$/m);
});

test("导出：英文时标题、分组名、说明是英文，标题、作者、官方总结和结论原样", () => {
  const en = toMarkdown(INPUT, VIDEO_BASE, "en");
  assert.ok(en.startsWith(`# Watch Later triage\n\nExported ${formatDateTime(0)}. 5 videos in total.\n`));
  for (const heading of ["## ★★★★★ Must watch (1)", "## ★★☆☆☆ Mostly skippable (1)", "## Not judged yet (3)"]) assert.ok(en.includes(`\n${heading}\n`), heading);
  assert.match(en, /^ {2}- Verdict: 自造的结论 \(based on the Bilibili official summary\)$/m);
  assert.match(en, /^ {2}- Verdict: 自造的结论 \(based on the overview\)$/m);
  assert.match(en, /^ {2}- Core value: 自造的价值$/m);
  assert.match(en, /^ {2}- Reasoning: 自造的理由$/m);
  assert.match(en, /^ {2}- Official summary: 自造的官方总结$/m);
  assert.match(en, /^ {2}- Request failed\. Click start again to retry \(NETWORK\)$/m);
  assert.match(en, /^ {2}- Video is unavailable/m);
  assert.match(en, /\[样例标题 1\]\(https:\/\/video\.example\/BV1Sample001\) · 样例作者 · 10:00/);
  assert.doesNotMatch(en.replace(/自造的[^\n)]*|样例[^\n\]]*/g, ""), /[一-鿿]/, "固定文字里不剩中文");
});

test("导出：一个视频时英文用单数", () => {
  assert.match(toMarkdown({ items: [item("1")], exportedAt: 0 }, VIDEO_BASE, "en"), /\. 1 video in total\./);
});

test("观看进度和官方总结的状态按语言写，中文照旧", () => {
  const watched = item("1", { progress: 125 });
  assert.equal(progressText(watched, "zh"), "看到 2:05（21%）");
  assert.equal(progressText(watched, "en"), "Watched to 2:05 (21%)");
  assert.equal(progressText(item("1", { finished: true }), "en"), "Finished");
  assert.equal(progressText(item("1"), "en"), "Not started");
  assert.equal(officialStatusText(null, undefined, "zh"), "还没取官方总结");
  assert.equal(officialStatusText(null, null, "en"), "Official summary not fetched yet");
  assert.equal(officialStatusText({ status: "unsupported" } as OfficialRecord, null, "en"), "Bilibili doesn't summarise this video");
});

test("导出的文件名：中文照旧，英文是英文名，都带导出时刻", () => {
  const stamp = formatDateTime(0).replace(/[-: ]/g, "");
  assert.equal(exportFileName(0, "zh"), `简幕-稍后再看-${stamp}.md`);
  assert.equal(exportFileName(0, "en"), `jianmu-watch-later-${stamp}.md`);
});

test("导出的星级分组标题按界面语言写，同时标明星数和意思", () => {
  assert.deepEqual(GROUPS.map((key) => groupName(key, "zh")), [
    "★★★★★ 推荐看", "★★★★☆ 值得看", "★★★☆☆ 挑着看", "★★☆☆☆ 可略过", "★☆☆☆☆ 可跳过", "还没判断", "信息不足",
  ]);
  assert.deepEqual(GROUPS.map((key) => groupName(key, "en")), [
    "★★★★★ Must watch", "★★★★☆ Worth watching", "★★★☆☆ Watch the key parts", "★★☆☆☆ Mostly skippable", "★☆☆☆☆ Skip", "Not judged yet", "Not enough info",
  ]);
});

test("导出：繁体时标题、分组名、说明是繁体，标题、作者、官方总结和结论原样", () => {
  const hant = toMarkdown(INPUT, VIDEO_BASE, "zh-Hant");
  assert.ok(hant.startsWith(`# 稍後再看粗篩\n\n匯出於 ${formatDateTime(0)}，共 5 部影片。\n`));
  for (const heading of ["## ★★★★★ 推薦看（1）", `## ★★☆☆☆ ${verdictName(2, "zh-Hant")}（1）`, "## 還沒判斷（3）"]) assert.ok(hant.includes(`\n${heading}\n`), heading);
  assert.match(hant, /^ {2}- 結論：自造的结论（根據 B 站官方總結）$/m);
  assert.match(hant, /^ {2}- 結論：自造的结论（根據概覽）$/m);
  assert.match(hant, /^ {2}- 核心價值：自造的价值$/m);
  assert.match(hant, /^ {2}- 理由：自造的理由$/m);
  assert.match(hant, /^ {2}- 官方總結：自造的官方总结$/m);
  assert.match(hant, /^ {2}- 請求失敗，再點選開始會重試（NETWORK）$/m);
  assert.match(hant, /^ {2}- 影片已失效/m);
});

test("繁体：观看进度、官方总结的状态、文件名、分组和档位的显示名", () => {
  assert.equal(progressText(item("1", { progress: 125 }), "zh-Hant"), "看到 2:05（21%）");
  assert.equal(progressText(item("1"), "zh-Hant"), "還沒看");
  assert.equal(officialStatusText(null, null, "zh-Hant"), "還沒取得官方總結");
  assert.equal(officialStatusText({ status: "unsupported" } as OfficialRecord, null, "zh-Hant"), "B 站不替這部影片做總結");
  const stamp = formatDateTime(0).replace(/[-: ]/g, "");
  assert.equal(exportFileName(0, "zh-Hant"), `簡幕-稍後再看-${stamp}.md`);
  assert.equal(groupName(1, "zh-Hant"), "★☆☆☆☆ 可跳過");
  assert.equal(groupName("pending", "zh-Hant"), "還沒判斷");
  assert.equal(groupName("unknown", "zh-Hant"), "資訊不足");
});
