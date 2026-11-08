// 发布脚本的纯逻辑：哪些路径会改变 zip、候选记录的形状、CHANGELOG 取节、发布说明、发布前的文字核对。
// 不读文件、不跑命令，入口 scripts/release.mjs 负责这些。
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { checksumLine } from "./zip-order.mjs";

/** 能改变 zip 字节的路径，以「/」结尾的是目录。候选之后改到这些就要换候选。 */
export const PACKAGE_INPUTS = Object.freeze([
  "src/",
  "static/",
  "prompts/",
  "manifest.template.json",
  "package.json",
  "package-lock.json",
  "LICENSE",
  "scripts/build.mjs",
  "scripts/package.mjs",
  "scripts/lib/zip-order.mjs",
]);

export const RELEASE_REPO = "TIAN-TOM/jianmu";
export const PLATFORM_LINE = "适用于哔哩哔哩和 YouTube™";
export const DISCLAIMER =
  "YouTube 是 Google LLC 的商标。哔哩哔哩和 bilibili 是其权利人的商标。简幕是个人开发的独立工具，与 Google、YouTube 和哔哩哔哩没有关联，也没有获得它们的授权或认可。";
/** README 里安装和更新那一节的标题，发布说明链到这里。 */
export const INSTALL_HEADING = "安装和更新";
/** 对外文字里不写的说法：会被读成承诺、关联或数据不出本机。 */
export const FORBIDDEN_PHRASES = Object.freeze([
  "已加密",
  "彻底擦除",
  "不会重复计费",
  "开发版",
  "资料只存在本机",
  "不编造",
  "自带模型密钥",
  "官方合作",
  "官方授权",
  "合作伙伴",
]);

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const VERSION = /^\d+(?:\.\d+){0,3}$/;

/** @param {string} path 仓库里的相对路径，分隔符是「/」 */
export function isPackageInput(path) {
  return PACKAGE_INPUTS.some((input) => (input.endsWith("/") ? path.startsWith(input) : path === input));
}

/**
 * 包输入的内容指纹：按路径的字节序，逐个拼上路径、长度和内容再算 SHA-256。改名、挪位置也算变化。
 * @param {readonly { path: string, content: Buffer }[]} entries
 */
export function hashPackageInputs(entries) {
  const sorted = [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const hash = createHash("sha256");
  for (const { path, content } of sorted) {
    hash.update(`${path}\0${content.length}\0`);
    hash.update(content);
  }
  return hash.digest("hex");
}

/** 从 zip 末尾的目录结束记录读条目数。 @param {Buffer} zip */
export function countZipEntries(zip) {
  for (let offset = zip.length - 22; offset >= Math.max(0, zip.length - 22 - 0xffff); offset -= 1) {
    if (zip.readUInt32LE(offset) !== 0x06054b50) continue;
    const entries = zip.readUInt16LE(offset + 10);
    if (entries === 0xffff) throw new Error("zip64 格式的包不支持");
    return entries;
  }
  throw new Error("不是 zip 文件：找不到目录结束记录");
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value */
const isCount = (value) => Number.isInteger(value) && Number(value) > 0;
/** @param {unknown} value */
const isText = (value) => typeof value === "string" && value.trim() !== "";

/**
 * 候选记录缺什么、哪里形状不对。读进来的记录先过这里再用。
 * @param {unknown} record
 * @returns {string[]}
 */
export function candidateRecordProblems(record) {
  if (!isObject(record)) return ["候选记录不是一个对象"];
  /** @type {string[]} */
  const problems = [];
  /** @param {string} field @param {boolean} ok @param {string} expected */
  const check = (field, ok, expected) => {
    if (!ok) problems.push(`候选记录的 ${field} ${expected}`);
  };
  const { version, commit, tree, packageInputs, zip, features, notices, tools, sourceDateEpoch, builtAt } = record;
  check("version", typeof version === "string" && VERSION.test(version), "应是版本号");
  check("commit", typeof commit === "string" && COMMIT.test(commit), "应是完整的提交号");
  check("tree", typeof tree === "string" && COMMIT.test(tree), "应是完整的树哈希");
  check("packageInputs", typeof packageInputs === "string" && SHA256.test(packageInputs), "应是 SHA-256");
  if (isObject(zip)) {
    check("zip.name", zip.name === `jianmu-${String(version)}.zip`, `应是 jianmu-${String(version)}.zip`);
    check("zip.sha256", typeof zip.sha256 === "string" && SHA256.test(zip.sha256), "应是 SHA-256");
    check("zip.bytes", isCount(zip.bytes), "应是正整数");
    check("zip.files", isCount(zip.files), "应是正整数");
  } else {
    check("zip", false, "缺失");
  }
  check("features", isObject(features) && Object.values(features).every((value) => typeof value === "boolean"), "应是开关名到布尔值的对象");
  for (const name of ["activation", "dataConsent"]) {
    const stamp = isObject(notices) ? notices[name] : undefined;
    check(`notices.${name}`, isObject(stamp) && isCount(stamp.version) && isText(stamp.fingerprint), "应有版本号和指纹");
  }
  for (const name of ["node", "npm", "esbuild", "zip", "os"]) {
    check(`tools.${name}`, isObject(tools) && isText(tools[name]), "缺失");
  }
  check("sourceDateEpoch", isCount(sourceDateEpoch), "应是正整数秒");
  check("builtAt", typeof builtAt === "string" && !Number.isNaN(Date.parse(builtAt)), "应是 ISO 时间");
  return problems;
}

/** @param {string} text */
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * CHANGELOG 里这个版本那一节的正文，到下一个二级标题为止。标题写成「## 0.1.0」，后面可以跟日期。
 * @param {string} changelog @param {string} version
 */
export function extractChangelogSection(changelog, version) {
  const lines = changelog.replaceAll("\r\n", "\n").split("\n");
  const heading = new RegExp(`^##\\s+\\[?v?${escapeRegExp(version)}\\]?(?=$|[\\s（(—])`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) throw new Error(`CHANGELOG.md 里没有 ${version} 一节`);
  const next = lines.findIndex((line, index) => index > start && /^##\s/.test(line));
  const body = lines.slice(start + 1, next < 0 ? undefined : next).join("\n").trim();
  if (body === "") throw new Error(`CHANGELOG.md 的 ${version} 一节是空的`);
  return body;
}

/** 还没定稿的地方：同一行的 HTML 注释 `<!-- 待定：原因 -->`。 @param {string} text */
export function findPendingMarkers(text) {
  return text.split("\n").flatMap((line, index) => {
    const match = /<!--\s*待定[:：]?\s*(.*?)\s*(?:-->|$)/.exec(line);
    return match ? [{ line: index + 1, reason: match[1] ?? "" }] : [];
  });
}

/** @param {string} text */
export function findForbiddenPhrases(text) {
  return FORBIDDEN_PHRASES.filter((phrase) => text.includes(phrase));
}

/**
 * 发布说明：本版的更新内容、安装步骤的链接、校验值和无关联声明。
 * @param {{ version: string, section: string, zipName: string, sha256: string }} input
 */
export function buildReleaseNotes({ version, section, zipName, sha256 }) {
  const installUrl = `https://github.com/${RELEASE_REPO}/blob/v${version}/README.md#${INSTALL_HEADING}`;
  return [
    `简幕 ${version}，${PLATFORM_LINE}。`,
    "",
    section.trim(),
    "",
    `## ${INSTALL_HEADING}`,
    "",
    `下载 \`${zipName}\` 和 \`${zipName}.sha256\`，先核对校验值，再按 [README 里的步骤](${installUrl})装上。没有自动更新，有新版时按同一节的步骤更新。`,
    "",
    "## 校验值",
    "",
    "```text",
    checksumLine(sha256, zipName).trimEnd(),
    "```",
    "",
    "---",
    "",
    DISCLAIMER,
    "",
  ].join("\n");
}

/** 发布说明里不该有的东西。 @param {string} notes */
export function releaseNotesProblems(notes) {
  return [
    ...findForbiddenPhrases(notes).map((phrase) => `发布说明里有不写的说法「${phrase}」`),
    ...findPendingMarkers(notes).map(({ line, reason }) => `发布说明第 ${line} 行还有待定标记：${reason}`),
  ];
}

/**
 * 打候选之前的前提：工作树干净、就在远端 main 的最新提交上、版本标签两边都还没有。
 * @param {{ version: string, dirty: readonly string[], head: string, remoteMain: string | null, localTag: boolean, remoteTag: boolean }} state
 */
export function candidateBlockers({ version, dirty, head, remoteMain, localTag, remoteTag }) {
  const blockers = [];
  if (dirty.length > 0) blockers.push(`工作树有未提交的改动：${dirty.join("、")}`);
  if (remoteMain === null) blockers.push("远端没有 main 分支");
  else if (head !== remoteMain) blockers.push(`HEAD（${head.slice(0, 7)}）不是远端 main 的最新提交（${remoteMain.slice(0, 7)}）`);
  if (localTag) blockers.push(`标签 v${version} 在本地已经有了`);
  if (remoteTag) blockers.push(`标签 v${version} 在远端已经有了`);
  return blockers;
}

/**
 * 隐私政策有没有列全存储的键名、库名和清单的 API 权限，每个都写成行内代码。
 * 主机权限按能力描述，不写主机名，所以不在这里查。
 * @param {{ privacy: string | null, names: readonly string[], permissions: readonly string[] }} input
 */
export function disclosureProblems({ privacy, names, permissions }) {
  if (privacy === null) return ["PRIVACY.md 不存在"];
  return [
    ...names.filter((name) => !privacy.includes(`\`${name}\``)).map((name) => `PRIVACY.md 没列出存储的 \`${name}\``),
    ...permissions.filter((name) => !privacy.includes(`\`${name}\``)).map((name) => `PRIVACY.md 没列出权限 \`${name}\``),
  ];
}

/** 中文 README 里写实机验证过的版本的那一行：同一行有「实机」和 Chrome 的版本号。 */
const VERIFIED_ZH = (/** @type {string} */ line) => /实机/.test(line) && /Chrome\s*\d{3}/.test(line);
const VERIFIED_EN = (/** @type {string} */ line) => /\b(?:by hand|manually)\b/i.test(line) && /Chrome\s*\d{3}/.test(line);

/**
 * 只在发布前查的：定稿标记、CHANGELOG 本版一节、README 的已验证版本和安装一节。缺文件的记为 null。
 * @param {{ version: string, files: Readonly<Record<string, string | null>> }} input
 */
export function finalTextProblems({ version, files }) {
  const problems = [];
  for (const [name, text] of Object.entries(files)) {
    if (text === null) {
      problems.push(`${name} 不存在`);
      continue;
    }
    for (const { line, reason } of findPendingMarkers(text)) problems.push(`${name} 第 ${line} 行还有待定标记：${reason}`);
  }
  const { "CHANGELOG.md": changelog, "README.md": readme, "README.en.md": readmeEn } = files;
  if (typeof changelog === "string") {
    try {
      extractChangelogSection(changelog, version);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (typeof readme === "string") {
    if (!readme.split("\n").some(VERIFIED_ZH)) problems.push("README.md 没写实机验证过的 Chrome 版本");
    if (!new RegExp(`^##+\\s*${INSTALL_HEADING}\\s*$`, "m").test(readme)) {
      problems.push(`README.md 没有「${INSTALL_HEADING}」一节，发布说明的安装链接会落空`);
    }
  }
  if (typeof readmeEn === "string" && !readmeEn.split("\n").some(VERIFIED_EN)) {
    problems.push("README.en.md 没写实机验证过的 Chrome 版本");
  }
  return problems;
}

/** 只改版本号的测试包用的新版本号。 @param {string} version @param {string} part */
export function bumpVersion(version, part) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`版本号要是三段数字：${version}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (part === "patch") return `${major}.${minor}.${Number(patch) + 1}`;
  if (part === "minor") return `${major}.${Number(minor) + 1}.0`;
  if (part === "major") return `${Number(major) + 1}.0.0`;
  throw new Error(`--bump 只认 patch、minor、major：${part}`);
}
