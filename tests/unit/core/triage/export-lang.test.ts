// 粗筛的导出按语言出固定文字：缺省和选中文时和原来逐字一样；英文时标题、分组名、说明是英文，
// 视频标题、UP 主名、官方总结和模型写的结论原样写；文件名按语言给。数据都是自造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import { exportFileName, formatDateTime, officialStatusText, progressText, toMarkdown } from "../../../../src/core/triage/export.ts";
import { GROUPS, groupName, verdictName, type TriageVerdict } from "../../../../src/core/triage/groups.ts";
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
  const zh = toMarkdown(INPUT, VIDEO_BASE);
  assert.equal(toMarkdown(INPUT, VIDEO_BASE, "zh"), zh);
  assert.ok(zh.startsWith("# 稍后再看粗筛\n\n导出于 "));
  assert.match(zh, /共 5 个视频。/);
  assert.match(zh, /^## 推荐看（1）$/m);
  assert.match(zh, /^ {2}- 结论：自造的结论（基于 B站官方总结）$/m);
  assert.match(zh, /^ {2}- 官方总结：自造的官方总结$/m);
  assert.match(zh, /^ {2}- 请求失败，再点开始会重试（NETWORK）$/m);
});

test("导出：英文时标题、分组名、说明是英文，标题、作者、官方总结和结论原样", () => {
  const en = toMarkdown(INPUT, VIDEO_BASE, "en");
  assert.ok(en.startsWith(`# Watch Later triage\n\nExported ${formatDateTime(0)}. 5 videos in total.\n`));
  for (const heading of ["## Worth watching (1)", "## Overview is enough (1)", "## Not judged yet (3)"]) assert.ok(en.includes(`\n${heading}\n`), heading);
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
  assert.equal(progressText(watched), "看到 2:05（21%）");
  assert.equal(progressText(watched, "en"), "Watched to 2:05 (21%)");
  assert.equal(progressText(item("1", { finished: true }), "en"), "Finished");
  assert.equal(progressText(item("1"), "en"), "Not started");
  assert.equal(officialStatusText(null), "还没取官方总结");
  assert.equal(officialStatusText(null, null, "en"), "Official summary not fetched yet");
  assert.equal(officialStatusText({ status: "unsupported" } as OfficialRecord, null, "en"), "Bilibili doesn't summarise this video");
});

test("导出的文件名：中文照旧，英文是英文名，都带导出时刻", () => {
  const stamp = formatDateTime(0).replace(/[-: ]/g, "");
  assert.equal(exportFileName(0), `简幕-稍后再看-${stamp}.md`);
  assert.equal(exportFileName(0, "en"), `jianmu-watch-later-${stamp}.md`);
});

test("分组和档位的显示名：中文就是标识本身，英文按译名表，认不出的档位原样", () => {
  assert.deepEqual(GROUPS.map((group) => groupName(group.key)), GROUPS.map((group) => group.label));
  assert.deepEqual(
    GROUPS.map((group) => groupName(group.key, "en")),
    ["Worth watching", "Watch the key parts", "Skip", "Not enough info", "Overview is enough", "Not judged yet"],
  );
  assert.equal(verdictName("可以看"), "可以看");
  assert.equal(verdictName("可以看", "en"), "Watch the key parts");
  assert.equal(verdictName("可以跳过", "en"), "Skip", "旧版改了名的按新名字认");
  assert.equal(verdictName("看概览就够", "en"), "Overview is enough");
  assert.equal(verdictName("自创的档", "en"), "自创的档");
  assert.equal(verdictName("", "en"), "");
});
