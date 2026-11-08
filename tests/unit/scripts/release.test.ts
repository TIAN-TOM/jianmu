import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  bumpVersion,
  buildReleaseNotes,
  candidateBlockers,
  candidateRecordProblems,
  countZipEntries,
  DISCLAIMER,
  disclosureProblems,
  extractChangelogSection,
  finalTextProblems,
  findForbiddenPhrases,
  findPendingMarkers,
  FORBIDDEN_PHRASES,
  hashPackageInputs,
  isPackageInput,
  PLATFORM_LINE,
  releaseNotesProblems,
} from "../../../scripts/lib/release.mjs";

test("包输入：会改变 zip 字节的路径才算", () => {
  for (const path of [
    "src/core/consent.ts",
    "src/pages/sidepanel/main.tsx",
    "static/_locales/zh_CN/messages.json",
    "prompts/analysis.md",
    "manifest.template.json",
    "package.json",
    "package-lock.json",
    "LICENSE",
    "scripts/build.mjs",
    "scripts/package.mjs",
    "scripts/lib/zip-order.mjs",
  ]) {
    assert.ok(isPackageInput(path), `${path} 应算包输入`);
  }
  for (const path of [
    "README.md",
    "README.en.md",
    "PRIVACY.md",
    "CHANGELOG.md",
    "AGENTS.md",
    "notes/architecture.md",
    "tests/build-output.test.ts",
    "e2e/run.mjs",
    ".github/workflows/ci.yml",
    "scripts/release.mjs",
    "scripts/lib/release.mjs",
    "scripts/check-public.mjs",
    "srcx/a.ts",
    "LICENSE.txt",
    "docs/src/a.ts",
  ]) {
    assert.ok(!isPackageInput(path), `${path} 不该算包输入`);
  }
});

test("包输入的指纹和顺序无关，内容、路径变了都会变", () => {
  const a = { path: "src/a.ts", content: Buffer.from("a") };
  const b = { path: "src/b.ts", content: Buffer.from("b") };
  const base = hashPackageInputs([a, b]);
  assert.match(base, /^[0-9a-f]{64}$/);
  assert.equal(hashPackageInputs([b, a]), base);
  assert.notEqual(hashPackageInputs([a, { ...b, content: Buffer.from("b2") }]), base);
  assert.notEqual(hashPackageInputs([a, { ...b, path: "src/c.ts" }]), base);
  // 内容挪到相邻文件不能算同一份。
  assert.notEqual(
    hashPackageInputs([{ path: "src/a.ts", content: Buffer.from("ab") }, { path: "src/b.ts", content: Buffer.from("") }]),
    hashPackageInputs([{ path: "src/a.ts", content: Buffer.from("a") }, { path: "src/b.ts", content: Buffer.from("b") }]),
  );
});

/** 只有目录结束记录的 zip：条目数写在偏移 10，可以带注释。 */
function endRecord(entries: number, comment = ""): Buffer {
  const record = Buffer.alloc(22);
  record.writeUInt32LE(0x06054b50, 0);
  record.writeUInt16LE(entries, 8);
  record.writeUInt16LE(entries, 10);
  record.writeUInt16LE(comment.length, 20);
  return Buffer.concat([Buffer.from("前面是文件数据"), record, Buffer.from(comment)]);
}

test("从 zip 的目录结束记录读条目数", () => {
  assert.equal(countZipEntries(endRecord(5)), 5);
  assert.equal(countZipEntries(endRecord(7, "comment")), 7);
  assert.throws(() => countZipEntries(Buffer.from("not a zip at all, definitely")), /不是 zip/);
  assert.throws(() => countZipEntries(endRecord(0xffff)), /zip64/);
});

function goodRecord(): Record<string, unknown> {
  return {
    version: "0.1.0",
    commit: "a".repeat(40),
    tree: "b".repeat(40),
    packageInputs: "c".repeat(64),
    zip: { name: "jianmu-0.1.0.zip", sha256: "d".repeat(64), bytes: 20000, files: 5 },
    features: { frameExplain: false },
    notices: { activation: { version: 1, fingerprint: "0123456789abcdef" }, dataConsent: { version: 2, fingerprint: "fedcba9876543210" } },
    tools: { node: "v26.12.0", npm: "11.20.0", esbuild: "0.28.2", zip: "Zip 3.0", os: "Darwin 27.2.0 arm64" },
    sourceDateEpoch: 1762600000,
    builtAt: "2026-11-09T00:00:00.000Z",
  };
}

test("候选记录：完整的不报，缺字段或形状不对的逐项报出", () => {
  assert.deepEqual(candidateRecordProblems(goodRecord()), []);
  assert.deepEqual(candidateRecordProblems(null), ["候选记录不是一个对象"]);
  const cases: [(record: Record<string, unknown>) => void, RegExp][] = [
    [(record) => delete record.commit, /commit/],
    [(record) => (record.commit = "abc1234"), /commit/],
    [(record) => delete record.tree, /tree/],
    [(record) => delete record.packageInputs, /packageInputs/],
    [(record) => delete record.zip, /zip 缺失/],
    [(record) => (record.zip = { ...(record.zip as object), sha256: "D".repeat(64) }), /zip\.sha256/],
    [(record) => (record.zip = { ...(record.zip as object), name: "jianmu-0.2.0.zip" }), /zip\.name/],
    [(record) => (record.zip = { ...(record.zip as object), files: 0 }), /zip\.files/],
    [(record) => (record.features = { frameExplain: "no" }), /features/],
    [(record) => (record.notices = { activation: { version: 1, fingerprint: "x" } }), /notices\.dataConsent/],
    [(record) => (record.tools = { node: "v26" }), /tools\.npm/],
    [(record) => (record.sourceDateEpoch = "1762600000"), /sourceDateEpoch/],
    [(record) => (record.builtAt = "昨天"), /builtAt/],
    [(record) => (record.version = "0.1.0-beta"), /version/],
  ];
  for (const [breakIt, expected] of cases) {
    const record = goodRecord();
    breakIt(record);
    const problems = candidateRecordProblems(record);
    assert.ok(problems.some((problem) => expected.test(problem)), `${expected} 没报：${problems.join("；")}`);
  }
});

const CHANGELOG = `# 更新记录

## 0.2.0（2026-12-01）

- 新的一版

## 0.1.0

### 新功能

- 速览和精读

## 0.0.9

- 更早
`;

test("CHANGELOG 取本版一节，到下一个二级标题为止", () => {
  assert.equal(extractChangelogSection(CHANGELOG, "0.1.0"), "### 新功能\n\n- 速览和精读");
  assert.equal(extractChangelogSection(CHANGELOG, "0.2.0"), "- 新的一版");
  assert.equal(extractChangelogSection(CHANGELOG.replaceAll("\n", "\r\n"), "0.0.9"), "- 更早");
  assert.throws(() => extractChangelogSection(CHANGELOG, "0.3.0"), /没有 0\.3\.0 一节/);
  assert.throws(() => extractChangelogSection(CHANGELOG, "0.1"), /没有 0\.1 一节/, "0.1 不能匹配到 0.1.0");
  assert.throws(() => extractChangelogSection("## 0.1.0\n\n## 0.0.9\n- x\n", "0.1.0"), /一节是空的/);
  assert.throws(() => extractChangelogSection("## 首发（未发布）\n\n发布时按实际做出来的功能写\n", "0.1.0"), /没有 0\.1\.0 一节/);
});

test("找出待定标记和它的原因", () => {
  const text = "第一行\n生效日期：首发日 <!-- 待定：发布日 -->\n正常\n联系邮箱（发布前按实测定稿）<!--待定:开发者本人给 -->\n<!-- 普通注释 -->\n";
  assert.deepEqual(findPendingMarkers(text), [
    { line: 2, reason: "发布日" },
    { line: 4, reason: "开发者本人给" },
  ]);
  assert.deepEqual(findPendingMarkers("没有标记，正文里提到待定两个字不算\n"), []);
});

const notesInput = { version: "0.1.0", section: "### 新功能\n\n- 速览和精读", zipName: "jianmu-0.1.0.zip", sha256: "e".repeat(64) };

test("发布说明带本版内容、校验值、适用平台、安装链接和无关联声明", () => {
  const notes = buildReleaseNotes(notesInput);
  assert.ok(notes.includes(`${"e".repeat(64)}  jianmu-0.1.0.zip`), "校验值行和 .sha256 文件一样");
  assert.ok(notes.includes(PLATFORM_LINE));
  assert.ok(notes.includes("适用于哔哩哔哩和 YouTube™"));
  assert.ok(notes.includes(DISCLAIMER));
  assert.ok(notes.includes("与 Google、YouTube 和哔哩哔哩没有关联"));
  assert.ok(notes.includes("- 速览和精读"));
  assert.match(notes, /\(https:\/\/github\.com\/TIAN-TOM\/jianmu\/blob\/v0\.1\.0\/README\.md#安装和更新\)/);
  assert.ok(notes.endsWith("\n") && !notes.includes("\r"));
  assert.deepEqual(findForbiddenPhrases(notes), []);
  assert.deepEqual(releaseNotesProblems(notes), []);
});

test("发布说明里出现禁用的说法或待定标记就不放行", () => {
  for (const phrase of ["官方合作", "不编造", "资料只存在本机", "已加密", "自带模型密钥", "不会重复计费"]) {
    assert.ok(FORBIDDEN_PHRASES.includes(phrase), phrase);
    const notes = buildReleaseNotes({ ...notesInput, section: `- 回答${phrase}` });
    assert.ok(releaseNotesProblems(notes).some((problem) => problem.includes(phrase)), phrase);
  }
  const pending = buildReleaseNotes({ ...notesInput, section: "- 速览 <!-- 待定：开关结论 -->" });
  assert.ok(releaseNotesProblems(pending).some((problem) => problem.includes("待定标记")));
});

test("打候选的前提逐条报出", () => {
  const head = "1".repeat(40);
  const clean = { version: "0.1.0", dirty: [], head, remoteMain: head, localTag: false, remoteTag: false };
  assert.deepEqual(candidateBlockers(clean), []);
  assert.match(candidateBlockers({ ...clean, dirty: ["src/a.ts", "README.md"] }).join(), /未提交的改动：src\/a\.ts、README\.md/);
  assert.match(candidateBlockers({ ...clean, remoteMain: "2".repeat(40) }).join(), /不是远端 main 的最新提交/);
  assert.match(candidateBlockers({ ...clean, remoteMain: null }).join(), /远端没有 main/);
  assert.match(candidateBlockers({ ...clean, localTag: true }).join(), /v0\.1\.0 在本地已经有了/);
  assert.match(candidateBlockers({ ...clean, remoteTag: true }).join(), /v0\.1\.0 在远端已经有了/);
});

test("隐私政策要用行内代码列出每个存储名和 API 权限", () => {
  const input = { names: ["jianmu", "notes", "jianmu_settings"], permissions: ["sidePanel", "storage"] };
  const privacy = "库 `jianmu` 里的 `notes`；设置 `jianmu_settings`。权限 `sidePanel`、`storage`。";
  assert.deepEqual(disclosureProblems({ ...input, privacy }), []);
  assert.deepEqual(disclosureProblems({ ...input, privacy: null }), ["PRIVACY.md 不存在"]);
  const missing = disclosureProblems({ ...input, privacy: privacy.replace("`storage`", "存储").replace("`notes`", "notes") });
  assert.deepEqual(missing, ["PRIVACY.md 没列出存储的 `notes`", "PRIVACY.md 没列出权限 `storage`"]);
});

test("发布前的文字核对", () => {
  const files = {
    "PRIVACY.md": "隐私政策\n",
    "README.md": "## 安装和更新\n\n开发者本人在 Chrome 142 上实机验证过。\n",
    "README.en.md": "Tested by hand on Chrome 142.\n",
    "CHANGELOG.md": CHANGELOG,
    "SECURITY.md": "安全\n",
  };
  assert.deepEqual(finalTextProblems({ version: "0.1.0", files }), []);
  const broken = finalTextProblems({
    version: "0.1.1",
    files: {
      ...files,
      "PRIVACY.md": "联系邮箱 <!-- 待定：开发者本人给 -->\n",
      "README.md": "## 安装\n\n自动化测试跑过 Chrome 116。\n",
      "README.en.md": "Automated tests ran on Chrome 116.\n",
      "SECURITY.md": null,
    },
  });
  for (const expected of [
    /PRIVACY\.md 第 1 行还有待定标记：开发者本人给/,
    /CHANGELOG\.md 里没有 0\.1\.1 一节/,
    /README\.md 没写实机验证过的 Chrome 版本/,
    /README\.en\.md 没写实机验证过的 Chrome 版本/,
    /README\.md 没有「安装和更新」一节/,
    /SECURITY\.md 不存在/,
  ]) {
    assert.ok(broken.some((problem) => expected.test(problem)), `${expected} 没报：${broken.join("；")}`);
  }
});

test("测试包的版本号只改一段", () => {
  assert.equal(bumpVersion("0.1.0", "patch"), "0.1.1");
  assert.equal(bumpVersion("0.1.9", "minor"), "0.2.0");
  assert.equal(bumpVersion("1.2.3", "major"), "2.0.0");
  assert.throws(() => bumpVersion("0.1", "patch"), /三段数字/);
  assert.throws(() => bumpVersion("0.1.0", "build"), /patch、minor、major/);
});

test("发布脚本在当前 Node 上能加载，不认识的子命令只打印用法", () => {
  const script = join(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."), "scripts/release.mjs");
  const result = spawnSync(process.execPath, [script, "publish"], { encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /用法：node scripts\/release\.mjs <candidate\|verify\|notes\|final-check\|upgrade-test>/);
});
