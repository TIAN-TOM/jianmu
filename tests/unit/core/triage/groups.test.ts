import assert from "node:assert/strict";
import { test } from "node:test";
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

const verdictOf = (label: number | string, extra: TriageVerdict = {}): TriageVerdict => ({
  summary: `讲了 ${label}`,
  value: "核心价值",
  verdict: label,
  reason: "判断理由",
  source: "official",
  ...extra,
});

test("粗筛按五星到一星排列，还没判断单列，信息不足排最后", () => {
  assert.deepEqual(GROUPS, [5, 4, 3, 2, 1, "pending", "unknown"]);
});

test("新评分和换算后的旧判断进同一组，组内保留稍后再看的顺序", () => {
  const ratings = {
    S3: 3, W: "推荐看", OW: "值得看完整视频", F: "可以看", S2: 2,
    S: "可跳过", S5: 5, OS: "可以跳过", UNK: "信息不足", OLD: "看概览就够",
    S4: 4, S1: 1, BAD: 0,
  };
  const items = [...Object.keys(ratings), "New", "BLK"].map((name) => item(name));
  const verdicts = Object.fromEntries(Object.entries(ratings).map(([name, rating]) => [keyOf(name), verdictOf(rating)]));
  const groups = groupItems(items, { ...verdicts, [keyOf("BLK")]: { summary: " ", verdict: 4 } });
  const keys = Object.fromEntries(
    Object.entries(groups).map(([key, members]) => [key, members.map((video) => video.videoKey)]),
  );
  assert.deepEqual(keys, {
    5: [keyOf("W"), keyOf("OW"), keyOf("S5")],
    4: [keyOf("S4")],
    3: [keyOf("S3"), keyOf("F")],
    2: [keyOf("S2"), keyOf("OLD")],
    1: [keyOf("S"), keyOf("OS"), keyOf("S1")],
    pending: [keyOf("New"), keyOf("BLK")],
    unknown: [keyOf("UNK"), keyOf("BAD")],
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
        [keyOf("001")]: verdictOf("推荐看", { summary: "番茄搭架子的办法", reason: "有现场演示" }),
      },
      exportedAt,
    },
    VIDEO_BASE,
    "zh",
  );
  assert.equal(
    markdown,
    [
      "# 稍后再看粗筛",
      "",
      "导出于 2026-11-01 07:05，共 4 个视频。",
      "",
      "## ★★★★★ 推荐看（1）",
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
