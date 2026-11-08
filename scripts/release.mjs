// 发布用的命令，只在本机跑，不碰 GitHub 上的标签和 Releases：
//   candidate [--out <目录>]           在远端 main 的最新提交上打候选，写 zip、.sha256 和 candidate.json
//   verify --record <candidate.json>    核对当前提交相对候选只改了包外的文件，重新打包的校验值和候选相同
//   notes --record <candidate.json> [--out <文件>]   从 CHANGELOG 生成发布说明草稿
//   final-check                         发布前的文字核对：待定标记、本版更新内容、已验证的浏览器版本、存储和权限
//   upgrade-test [--bump patch] [--out <目录>]       同一份代码只改版本号的测试包，给升级测试用，不进 Releases
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, release, tmpdir, type } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  ACTIVATION_FINGERPRINT,
  ACTIVATION_VERSION,
  BUILD_FEATURES,
  DATA_CONSENT_FINGERPRINT,
  DATA_CONSENT_VERSION,
} from "../src/core/consent.ts";
import { DATABASE_NAME } from "../src/shared/names.ts";
import { STORAGE_PLAN } from "../src/shared/storage-plan.ts";
import {
  bumpVersion,
  buildReleaseNotes,
  candidateBlockers,
  candidateRecordProblems,
  countZipEntries,
  disclosureProblems,
  extractChangelogSection,
  finalTextProblems,
  hashPackageInputs,
  isPackageInput,
  releaseNotesProblems,
} from "./lib/release.mjs";
import { parseChecksumLine } from "./lib/zip-order.mjs";
import { packageDirectory, readExpectedFiles, sourceDateEpoch } from "./package.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

class ReleaseError extends Error {
  /** @param {string} title @param {readonly string[]} [problems] */
  constructor(title, problems = []) {
    super([title, ...problems.map((problem) => `  ${problem}`)].join("\n"));
  }
}

/** @param {string[]} args */
function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

/** @param {string} command @param {string[]} args @param {Record<string, string>} [env] */
function run(command, args, env = {}) {
  try {
    execFileSync(command, args, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });
  } catch {
    throw new ReleaseError(`${command} ${args.join(" ")} 没有通过`);
  }
}

/** @param {string} file */
function readOptional(file) {
  const path = join(ROOT, file);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

function readVersion() {
  return String(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
}

/** 未提交的改动和没被忽略的新文件，按路径列出。 */
function dirtyPaths() {
  return execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3));
}

/** 远端某个引用指向的提交，没有就是 null。 @param {string} ref */
function remoteRef(ref) {
  const line = git("ls-remote", "origin", ref).split("\n").find((entry) => entry.endsWith(`\t${ref}`));
  return line ? (line.split("\t")[0] ?? null) : null;
}

/** @param {string} ref */
function hasLocalRef(ref) {
  try {
    git("rev-parse", "--quiet", "--verify", ref);
    return true;
  } catch {
    return false;
  }
}

/** 已跟踪的包输入，内容从工作树读；调用前已确认这些文件没有未提交的改动。 */
function packageInputEntries() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
    .split("\0")
    .filter((path) => path && isPackageInput(path))
    .map((path) => ({ path, content: readFileSync(join(ROOT, path)) }));
}

/** 隐私政策要列出的存储名：库名、仓库名和存储键。 */
function storageNames() {
  return [DATABASE_NAME, ...Object.keys(STORAGE_PLAN)];
}

function manifestPermissions() {
  const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.template.json"), "utf8"));
  return [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])].map(String);
}

function privacyDisclosureProblems() {
  return disclosureProblems({ privacy: readOptional("PRIVACY.md"), names: storageNames(), permissions: manifestPermissions() });
}

/** @param {string} zipPath */
function readZipChecksum(zipPath) {
  const { sha256, fileName } = parseChecksumLine(readFileSync(`${zipPath}.sha256`, "utf8"));
  if (fileName !== basename(zipPath)) throw new ReleaseError(`${basename(zipPath)}.sha256 写的是别的文件：${fileName}`);
  return sha256;
}

function toolVersions() {
  const zipLine = execFileSync("zip", ["-v"], { encoding: "utf8" }).split("\n").find((line) => line.startsWith("This is Zip"));
  return {
    node: process.version,
    npm: execFileSync("npm", ["--version"], { cwd: ROOT, encoding: "utf8" }).trim(),
    esbuild: String(JSON.parse(readFileSync(join(ROOT, "node_modules/esbuild/package.json"), "utf8")).version),
    zip: zipLine ? zipLine.replace(/^This is /, "").trim() : "unknown",
    os: `${type()} ${release()} ${arch()}`,
  };
}

/** @param {string} recordPath */
function readRecord(recordPath) {
  const record = JSON.parse(readFileSync(resolve(recordPath), "utf8"));
  const problems = candidateRecordProblems(record);
  if (problems.length > 0) throw new ReleaseError("候选记录不完整：", problems);
  return record;
}

/** @param {{ out?: string }} options */
function candidate({ out }) {
  const version = readVersion();
  const blockers = [
    ...candidateBlockers({
      version,
      dirty: dirtyPaths(),
      head: git("rev-parse", "HEAD"),
      remoteMain: remoteRef("refs/heads/main"),
      localTag: hasLocalRef(`refs/tags/v${version}`),
      remoteTag: remoteRef(`refs/tags/v${version}`) !== null,
    }),
    ...privacyDisclosureProblems(),
  ];
  const outDir = out ? resolve(out) : null;
  const zipName = `jianmu-${version}.zip`;
  const targets = [zipName, `${zipName}.sha256`, "candidate.json"];
  if (outDir) blockers.push(...targets.filter((name) => existsSync(join(outDir, name))).map((name) => `${join(outDir, name)} 已经存在`));
  if (blockers.length > 0) throw new ReleaseError("不能打候选：", blockers);

  const head = git("rev-parse", "HEAD");
  const epoch = Number(git("log", "-1", "--format=%ct", head));
  run("npm", ["run", "check"]);
  run("npm", ["run", "package"], { SOURCE_DATE_EPOCH: String(epoch) });
  const after = dirtyPaths();
  if (after.length > 0 || git("rev-parse", "HEAD") !== head) throw new ReleaseError("构建期间工作树或 HEAD 变了：", after);

  const zipPath = join(DIST, zipName);
  const zip = readFileSync(zipPath);
  const record = {
    version,
    commit: head,
    tree: git("rev-parse", `${head}^{tree}`),
    packageInputs: hashPackageInputs(packageInputEntries()),
    zip: { name: zipName, sha256: readZipChecksum(zipPath), bytes: zip.length, files: countZipEntries(zip) },
    features: { ...BUILD_FEATURES },
    notices: {
      activation: { version: ACTIVATION_VERSION, fingerprint: ACTIVATION_FINGERPRINT },
      dataConsent: { version: DATA_CONSENT_VERSION, fingerprint: DATA_CONSENT_FINGERPRINT },
    },
    tools: toolVersions(),
    sourceDateEpoch: epoch,
    builtAt: new Date().toISOString(),
  };
  const problems = candidateRecordProblems(record);
  if (problems.length > 0) throw new ReleaseError("候选记录不完整：", problems);
  writeFileSync(join(DIST, "candidate.json"), `${JSON.stringify(record, null, 2)}\n`);
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    for (const name of targets) copyFileSync(join(DIST, name), join(outDir, name));
  }
  console.log(`候选：${zipName}，提交 ${head.slice(0, 7)}，SHA-256 ${record.zip.sha256}`);
  console.log(`记录：${outDir ? join(outDir, "candidate.json") : relative(process.cwd(), join(DIST, "candidate.json"))}`);
}

/** @param {{ record?: string }} options */
function verify({ record: recordPath }) {
  if (!recordPath) throw new ReleaseError("用 --record 指定候选记录");
  const record = readRecord(recordPath);
  if (!hasLocalRef(`${record.commit}^{commit}`)) throw new ReleaseError(`本地没有候选提交 ${record.commit.slice(0, 7)}，先 fetch`);
  try {
    git("merge-base", "--is-ancestor", record.commit, "HEAD");
  } catch {
    throw new ReleaseError(`候选提交 ${record.commit.slice(0, 7)} 不在当前提交的历史里`);
  }
  const changed = git("diff", "--name-only", "--no-renames", "-z", record.commit, "HEAD").split("\0").filter((path) => path && isPackageInput(path));
  const dirty = dirtyPaths().filter(isPackageInput);
  const problems = [
    ...changed.map((path) => `候选之后改了包里的文件：${path}`),
    ...dirty.map((path) => `工作树里有没提交的包内改动：${path}`),
  ];
  if (problems.length > 0) throw new ReleaseError("当前提交不能沿用这个候选，要换新的候选：", problems);
  if (hashPackageInputs(packageInputEntries()) !== record.packageInputs) {
    throw new ReleaseError("包输入的内容和候选记录对不上，要换新的候选");
  }
  run("npm", ["run", "package"], { SOURCE_DATE_EPOCH: String(record.sourceDateEpoch) });
  const sha256 = readZipChecksum(join(DIST, record.zip.name));
  if (sha256 !== record.zip.sha256) throw new ReleaseError(`重新打包的校验值 ${sha256} 和候选的 ${record.zip.sha256} 不同`);
  console.log(`当前提交 ${git("rev-parse", "--short", "HEAD")} 相对候选只改了包外的文件，重新打包的校验值相同：${sha256}`);
}

/** @param {{ record?: string, out?: string }} options */
function notes({ record: recordPath, out }) {
  if (!recordPath) throw new ReleaseError("用 --record 指定候选记录");
  const record = readRecord(recordPath);
  const changelog = readOptional("CHANGELOG.md");
  if (changelog === null) throw new ReleaseError("CHANGELOG.md 不存在");
  const text = buildReleaseNotes({
    version: record.version,
    section: extractChangelogSection(changelog, record.version),
    zipName: record.zip.name,
    sha256: record.zip.sha256,
  });
  const problems = releaseNotesProblems(text);
  if (problems.length > 0) throw new ReleaseError("发布说明没过核对：", problems);
  if (!out) {
    process.stdout.write(text);
    return;
  }
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), text);
  console.log(`发布说明草稿：${resolve(out)}`);
}

function finalCheck() {
  const files = Object.fromEntries(
    ["PRIVACY.md", "README.md", "README.en.md", "CHANGELOG.md", "SECURITY.md"].map((name) => [name, readOptional(name)]),
  );
  const problems = [...finalTextProblems({ version: readVersion(), files }), ...privacyDisclosureProblems()];
  if (problems.length > 0) throw new ReleaseError(`发布前检查没过，共 ${problems.length} 项：`, problems);
  console.log("发布前检查通过");
}

/** @param {{ bump?: string, out?: string }} options */
function upgradeTest({ bump = "patch", out }) {
  const next = bumpVersion(readVersion(), bump);
  run("npm", ["run", "build"]);
  const work = mkdtempSync(join(tmpdir(), "jianmu-upgrade-test-"));
  try {
    cpSync(join(ROOT, "build"), work, { recursive: true });
    const manifestPath = join(work, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, version: next }, null, 2)}\n`);
    const output = join(out ? resolve(out) : join(DIST, "upgrade-test"), `jianmu-${next}-upgrade-test.zip`);
    const { sha256 } = packageDirectory({ dir: work, version: next, expectedFiles: readExpectedFiles(), output, epoch: sourceDateEpoch() });
    console.log(`升级测试包：${output}\nSHA-256：${sha256}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const COMMANDS = {
  candidate: { options: ["out"], action: candidate },
  verify: { options: ["record"], action: verify },
  notes: { options: ["record", "out"], action: notes },
  "final-check": { options: [], action: finalCheck },
  "upgrade-test": { options: ["bump", "out"], action: upgradeTest },
};

function main() {
  const [name = "", ...rest] = process.argv.slice(2);
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[/** @type {keyof typeof COMMANDS} */ (name)] : null;
  if (!command) {
    console.error(`用法：node scripts/release.mjs <${Object.keys(COMMANDS).join("|")}> [选项]`);
    process.exit(2);
  }
  try {
    const { values } = parseArgs({
      args: rest,
      options: Object.fromEntries(command.options.map((option) => [option, { type: "string" }])),
      strict: true,
    });
    command.action(/** @type {Record<string, string>} */ (values));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
