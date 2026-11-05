import assert from "node:assert/strict";
import { test } from "node:test";
import { VERDICT_LABELS } from "../../../../src/core/ai/verdict.ts";
import { toMarkdown } from "../../../../src/core/triage/export.ts";
import { GROUPS, groupItems, type TriageVerdict } from "../../../../src/core/triage/groups.ts";
import type { OfficialRecord, TriageItem } from "../../../../src/core/triage/state.ts";
import { videoKey, type VideoKey } from "../../../../src/core/video-ref.ts";

const VIDEO_BASE = "https://video.example/";

const keyOf = (name: string): VideoKey =>
  videoKey({ platform: "bilibili", videoId: `BV1Sample${name.padStart(3, "0")}` });

const item = (name: string, extra: Partial<TriageItem> = {}): TriageItem => ({
  videoKey: keyOf(name),
  title: `标题 ${name}`,
  ownerName: "UP 主",
  duration: 600,
  progress: 0,
  finished: false,
  pageCount: 1,
  available: true,
  ...extra,
});

const OK = (summary = "官方总摘要"): OfficialRecord => ({
  status: "ok",
  summary,
  outline: [{ title: "第一段", timestamp: 0, points: [] }],
});

const verdictOf = (label: string, extra: TriageVerdict = {}): TriageVerdict => ({
  summary: `讲了 ${label}`,
  value: "核心价值",
  verdict: label,
  reason: "判断理由",
  source: "official",
  ...extra,
});

test("分组和结论校验的四档判断一致，外加「还没判断」", () => {
  assert.deepEqual(
    GROUPS.filter((group) => group.key !== "pending").map((group) => group.label),
    VERDICT_LABELS,
  );
  assert.equal(GROUPS.at(-1)?.label, "还没判断");
});

test("结论按判断分组：四档各归各的，没有结论的是「还没判断」，档位不在四档里的算「信息不足」", () => {
  const items = ["W", "O", "S", "U", "P", "BLK", "ODD"].map((name) => item(name));
  const verdicts = {
    [keyOf("W")]: verdictOf("值得看完整视频"),
    [keyOf("O")]: verdictOf("看概览就够"),
    [keyOf("S")]: verdictOf("可以跳过"),
    [keyOf("U")]: verdictOf("信息不足"),
    [keyOf("BLK")]: { summary: "", verdict: "可以跳过" },
    [keyOf("ODD")]: verdictOf(""),
  };
  const groups = groupItems(items, verdicts);
  const keys = Object.fromEntries(
    Object.entries(groups).map(([key, members]) => [key, members.map((video) => video.videoKey)]),
  );
  assert.deepEqual(keys, {
    watch: [keyOf("W")],
    overview: [keyOf("O")],
    skip: [keyOf("S")],
    unknown: [keyOf("U"), keyOf("ODD")],
    pending: [keyOf("P"), keyOf("BLK")],
  });
});

test("导出 Markdown：按判断分组，空组不写，链接、结论、理由和官方总结都在", () => {
  const exportedAt = new Date(2026, 10, 1, 7, 5).getTime();
  const items = [
    item("001", { title: "看完整 [精华] 版", ownerName: "菜园", duration: 218 }),
    item("002", { title: "没有结论", ownerName: "UP_主", duration: 3725 }),
    item("003", { title: "官方没有总结" }),
    item("004", { title: "失效视频", available: false }),
  ];
  const markdown = toMarkdown(
    {
      items,
      official: {
        [keyOf("002")]: OK("讲了怎么\n搭架子"),
        [keyOf("003")]: { status: "none" },
      },
      verdicts: {
        [keyOf("001")]: verdictOf("值得看完整视频", { summary: "番茄搭架子的办法", reason: "有现场演示" }),
      },
      exportedAt,
    },
    VIDEO_BASE,
  );
  assert.equal(
    markdown,
    [
      "# 稍后再看粗筛",
      "",
      "导出于 2026-11-01 07:05，共 4 个视频。",
      "",
      "## 值得看完整视频（1）",
      "",
      `- [ ] [看完整 \\[精华\\] 版](${VIDEO_BASE}BV1Sample001) · 菜园 · 3:38`,
      "  - 结论：番茄搭架子的办法（基于 B站官方总结）",
      "  - 核心价值：核心价值",
      "  - 理由：有现场演示",
      "",
      "## 还没判断（3）",
      "",
      `- [ ] [没有结论](${VIDEO_BASE}BV1Sample002) · UP\\_主 · 1:02:05`,
      "  - 官方总结：讲了怎么 搭架子",
      `- [ ] [官方没有总结](${VIDEO_BASE}BV1Sample003) · UP 主 · 10:00`,
      "  - 没有官方总结",
      `- [ ] [失效视频](${VIDEO_BASE}BV1Sample004) · UP 主 · 10:00`,
      "  - 视频已失效或暂时看不了，没有去取官方总结",
      "",
    ].join("\n"),
  );
});
