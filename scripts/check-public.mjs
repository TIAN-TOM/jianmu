// 公开结构检查：只看哪些路径会进仓库，不看文件内容，也不含任何带名字的名单。
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TOP_LEVEL = new Set([
  ".gitattributes", ".github", ".gitignore", ".node-version", ".npmrc",
  "AGENTS.md", "CHANGELOG.md", "LICENSE", "PRIVACY.md", "README.en.md", "README.md", "SECURITY.md",
  "e2e", "manifest.template.json", "notes", "package-lock.json", "package.json", "prompts", "scripts",
  "src", "static", "tests",
  "tsconfig.base.json", "tsconfig.node.json", "tsconfig.pages.json", "tsconfig.sw.json",
]);

const NOTES = new Set([
  "notes/architecture.md", "notes/dual-site-launch-plan.md", "notes/manual-checklist.md", "notes/product-prd.md",
]);

// 允许出现 JSON 的位置；其余的 JSON 按实验导出处理。
const JSON_ALLOWED = [
  /^manifest\.template\.json$/,
  /^package(-lock)?\.json$/,
  /^tsconfig\.[a-z]+\.json$/,
  /^static\/_locales\/[^/]+\/messages\.json$/,
  /^tests\/fixtures\//,
];

const BANNED_FILES = [
  [/\.map$/, "source map"],
  [/(^|\/)\.env[^/]*$/, "环境变量文件"],
  [/\.har$/, "网络抓取记录"],
  [/\.log$/, "调试日志"],
  [/\.zip$/, "构建产物"],
  [/(^|\/)\.DS_Store$/, "系统临时文件"],
  // 扩展身份的私钥和签名包放在仓库以外。
  [/\.(pem|crx|key)$/i, "私钥或签名包"],
];

const EXPERIMENT_SEGMENT = /^(spikes?|experiments?)$/i;

// README 用的截图和演示动图只放 .github/assets/，只许 PNG 和 GIF，单个不超过 5 MB。
const ASSETS_DIR = ".github/assets/";
const ASSET_FILE = /\.(png|gif)$/;
const ASSET_MAX_BYTES = 5 * 1024 * 1024;
const MEDIA_FILE = /\.(png|gif|jpe?g|webp|avif|svg|bmp|ico|tiff?|heic|mp4|webm|mov)$/i;

/**
 * @param {readonly string[]} paths
 * @param {{ sizeOf?: (path: string) => number | undefined }} [options] 读文件大小；不给就不查大小
 * @returns {string[]}
 */
export function findViolations(paths, { sizeOf } = {}) {
  const problems = [];
  for (const path of paths) {
    const segments = path.split("/");
    const [top = ""] = segments;
    if (!TOP_LEVEL.has(top)) problems.push(`${path}：顶层路径不在白名单里`);
    if (top === "notes" && !NOTES.has(path)) problems.push(`${path}：notes/ 只放白名单里的文档`);
    if (segments.some((segment) => EXPERIMENT_SEGMENT.test(segment))) problems.push(`${path}：实验目录不进仓库`);
    if (path.endsWith(".json") && !JSON_ALLOWED.some((pattern) => pattern.test(path))) {
      problems.push(`${path}：这个位置不该有 JSON，实验导出不进仓库`);
    }
    for (const [pattern, label] of BANNED_FILES) {
      if (/** @type {RegExp} */ (pattern).test(path)) problems.push(`${path}：${label}不进仓库`);
    }
    if (path.startsWith(ASSETS_DIR)) {
      if (!ASSET_FILE.test(path)) problems.push(`${path}：${ASSETS_DIR} 只放 PNG 和 GIF`);
      const bytes = sizeOf?.(path);
      if (bytes !== undefined && bytes > ASSET_MAX_BYTES) problems.push(`${path}：超过 5 MB`);
    } else if (top === ".github" && MEDIA_FILE.test(path)) {
      problems.push(`${path}：图片和视频只放 ${ASSETS_DIR}`);
    }
  }
  return problems;
}

function main() {
  // 已跟踪的文件，加上没被忽略、随时可能提交的文件。
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const paths = output.split("\0").filter(Boolean);
  // 已跟踪但工作区里删掉了的文件没有大小可查。
  const sizeOf = (/** @type {string} */ path) => {
    const file = join(ROOT, path);
    return existsSync(file) ? statSync(file).size : undefined;
  };
  const problems = findViolations(paths, { sizeOf });
  if (problems.length > 0) {
    console.error(`公开结构检查没过，共 ${problems.length} 项：`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`公开结构检查通过，检查了 ${paths.length} 个文件`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
