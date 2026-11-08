// 内容指纹：同一份字幕换个写法、换个顺序得出同一串；内容、时间有实质变化就变。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { officialFingerprint, textFingerprint, transcriptFingerprint } from "../../../../src/core/transcript/fingerprint.ts";

const CUES = [
  { start: 0, duration: 2, text: "第一句" },
  { start: 2, duration: 2.5, text: "Second  line " },
];

test("字幕指纹是 16 位十六进制，等于每条「开始|时长|规范化正文」排序后 SHA-256 的前 16 位", async () => {
  const expected = createHash("sha256").update(["0|2000|第一句", "2000|2500|Second line"].sort().join("\n")).digest("hex").slice(0, 16);
  assert.equal(await transcriptFingerprint(CUES), expected);
  assert.match(expected, /^[0-9a-f]{16}$/);
});

test("换顺序、多余空白、浮点写法不同、夹着空白条目，指纹都不变", async () => {
  const base = await transcriptFingerprint(CUES);
  assert.equal(await transcriptFingerprint([...CUES].reverse()), base);
  assert.equal(await transcriptFingerprint([{ start: 0.0000001, duration: 2, text: " 第一句 " }, { start: 2, duration: 2.5, text: "Second line" }]), base);
  assert.equal(await transcriptFingerprint([...CUES, { start: 9, duration: 1, text: "  " }, null]), base);
});

test("正文、开始或时长变了，指纹跟着变", async () => {
  const base = await transcriptFingerprint(CUES);
  assert.notEqual(await transcriptFingerprint([{ ...CUES[0], text: "第一局" }, CUES[1]]), base);
  assert.notEqual(await transcriptFingerprint([{ ...CUES[0], start: 0.5 }, CUES[1]]), base);
  assert.notEqual(await transcriptFingerprint([CUES[0], { ...CUES[1], duration: 3 }]), base);
  assert.notEqual(await transcriptFingerprint([CUES[0]]), base);
});

test("文字指纹按规范化后的正文算，空白差异不算", async () => {
  assert.equal(await textFingerprint("标题 和简介"), await textFingerprint("  标题和简介 "));
  assert.notEqual(await textFingerprint("标题和简介"), await textFingerprint("标题和简介。"));
  assert.match(await textFingerprint(""), /^[0-9a-f]{16}$/);
});

const OFFICIAL = {
  summary: "全片 摘要",
  outline: [
    { title: "第一段", timestamp: 1, points: [{ timestamp: 1.5, content: "要点一" }] },
    { title: "第二段", timestamp: null, points: [{ timestamp: null, content: "要点二" }] },
  ],
};

test("官方总结指纹等于逐行「层级|时间|规范化正文」按原顺序拼起来的 SHA-256 前 16 位", async () => {
  const lines = ["S|全片摘要", "T|1000|第一段", "P|1500|要点一", "T|-|第二段", "P|-|要点二"];
  const expected = createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
  assert.equal(await officialFingerprint(OFFICIAL), expected);
});

test("官方总结指纹：空白差异不算；摘要、标题、要点、时间、提纲顺序变了都算", async () => {
  const base = await officialFingerprint(OFFICIAL);
  assert.equal(await officialFingerprint({ ...OFFICIAL, summary: " 全片摘要 " }), base);
  const [first, second] = OFFICIAL.outline as [(typeof OFFICIAL.outline)[number], (typeof OFFICIAL.outline)[number]];
  assert.notEqual(await officialFingerprint({ ...OFFICIAL, summary: "别的摘要" }), base);
  assert.notEqual(await officialFingerprint({ ...OFFICIAL, outline: [{ ...first, title: "改过的标题" }, second] }), base);
  assert.notEqual(await officialFingerprint({ ...OFFICIAL, outline: [{ ...first, timestamp: 2 }, second] }), base);
  assert.notEqual(await officialFingerprint({ ...OFFICIAL, outline: [{ ...first, points: [{ timestamp: 1.5, content: "要点三" }] }, second] }), base);
  assert.notEqual(await officialFingerprint({ ...OFFICIAL, outline: [second, first] }), base);
  assert.notEqual(await officialFingerprint({ ...OFFICIAL, outline: [first, { ...second, timestamp: 0 }] }), base, "没有时间和 0 秒不是一回事");
});
