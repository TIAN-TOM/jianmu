// 后台、扩展页面和内容脚本不按站名分支：要问一个站能做什么，经站点契约的能力问（例如 sites/rules.ts 的 captionsInPage）。
// 这里读源码文本，去掉注释以后拦几种按站名分支的写法；确实只属于一个站的地方进放行表，并写明原因。
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { bilibiliRules } from "../../../src/sites/bilibili/url.ts";
import type { Platform } from "../../../src/core/video-ref.ts";
import { CONTENT_SENDERS } from "../../../src/shared/messages.ts";
import { captionsInPage, watchRefOf } from "../../../src/sites/rules.ts";
import type { SiteRules } from "../../../src/sites/types.ts";
import { youtubeRules } from "../../../src/sites/youtube/url.ts";
import { stripComments } from "../../helpers/strip-comments.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const SCANNED = ["src/background", "src/pages", "src/content"];
const SITE = "(?:bilibili|youtube)";

// 每种写法一条：名字说清它为什么不行。
const RULES: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "拿平台和站名做相等比较", pattern: new RegExp(`[!=]==\\s*["'\`]${SITE}["'\`]|["'\`]${SITE}["'\`]\\s*[!=]==|\\bcase\\s+["'\`]${SITE}["'\`]`) },
  { name: "拿视频键的站名前缀判站", pattern: new RegExp(`["'\`]${SITE}:`) },
  { name: "手写某个站的内容脚本发送方（用 CONTENT_SENDERS 或按平台拼）", pattern: new RegExp(`["'\`]content:${SITE}`) },
];

// 确实只属于一个站的地方：文件、这一行里要有的片段、原因。
const ALLOWED: readonly { readonly file: string; readonly snippet: string; readonly reason: string }[] = [
  { file: "src/background/routes/youtube.ts", snippet: '?.platform === "youtube"', reason: "YouTube 专属的路由，只收 YouTube 的视频" },
  { file: "src/pages/sidepanel/panel.ts", snippet: '?.platform === "bilibili"', reason: "只为挑「UP 主」还是「频道」这个词，不决定能做什么" },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [relative(ROOT, path).split(sep).join("/")] : [];
  });
}

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly text: string;
}

function scan(file: string, source: string): Hit[] {
  return stripComments(source)
    .split("\n")
    .flatMap((text, index) => RULES.filter(({ pattern }) => pattern.test(text)).map(({ name }) => ({ file, line: index + 1, rule: name, text: text.trim() })));
}

const allowed = (hit: Hit): boolean => ALLOWED.some(({ file, snippet }) => file === hit.file && hit.text.includes(snippet));

test("字幕由谁读按站点契约答：B 站后台自己读，YouTube 经页面读，没登记的站按经页面读算", () => {
  assert.equal(bilibiliRules.captions, "service");
  assert.equal(youtubeRules.captions, "page");
  assert.equal(captionsInPage("bilibili"), false);
  assert.equal(captionsInPage("youtube"), true);
  // 注入的规则表优先：关掉 YouTube 的构建里规则表没有它。
  assert.equal(captionsInPage("youtube", [bilibiliRules]), true);
  assert.equal(captionsInPage("bilibili", []), true);
  assert.equal(captionsInPage("bilibili", [{ ...bilibiliRules, captions: "page" }]), true);
});

test("认播放页上的视频：按传入的规则表逐条认，第一条认得出的说了算，都认不出是 null", () => {
  const rule = (platform: Platform, prefix: string): SiteRules => ({
    ...bilibiliRules,
    platform,
    parseWatchUrl: (url) => (url.startsWith(prefix) ? { platform, videoId: url.slice(prefix.length) } : null),
  });
  const rules = [rule("bilibili", "https://a.example/"), rule("youtube", "https://")];
  assert.deepEqual(watchRefOf("https://a.example/x1", rules), { platform: "bilibili", videoId: "x1" });
  assert.deepEqual(watchRefOf("https://b.example/x2", rules), { platform: "youtube", videoId: "b.example/x2" });
  assert.equal(watchRefOf("ftp://a.example/x1", rules), null);
  assert.equal(watchRefOf("https://a.example/x1", []), null);
});

test("内容脚本的发送方按平台表生成，每个平台一个", () => {
  assert.deepEqual([...CONTENT_SENDERS].sort(), ["content:bilibili", "content:youtube"]);
});

test("检查本身拦得住：几种按站名分支的写法都认得出，注释里的和别的字符串不算", () => {
  const bad = [
    'if (ref.platform === "bilibili") return;',
    "const inPage = platform !== 'youtube';",
    'return "youtube" === parseVideoKey(video)?.platform;',
    "switch (platform) { case `bilibili`: break; }",
    'const canAsk = current.startsWith("bilibili:");',
    "const tube = key.startsWith(`youtube:`);",
    'senders: ["panel", "content:bilibili"],',
    "const kind = 'content:youtube';",
  ];
  for (const line of bad) assert.equal(scan("x.ts", line).length, 1, line);
  const fine = [
    '// ref.platform === "bilibili" 只在注释里',
    "if (captionsInPage(ref.platform)) return;",
    'openSettingsAt("youtube");',
    'const id = "youtube-section";',
    "const same = a.platform === b.platform;",
    "if (!route.senders.includes(`content:${site.site}`)) return;",
    'senders: ["panel", "page", ...CONTENT_SENDERS],',
  ];
  for (const line of fine) assert.deepEqual(scan("x.ts", line), [], line);
});

test("后台、扩展页面和内容脚本里没有按站名分支的写法，放行表里写明的除外", () => {
  const hits = SCANNED.flatMap((dir) => sourceFiles(join(ROOT, dir))).flatMap((file) => scan(file, readFileSync(join(ROOT, file), "utf8")));
  assert.deepEqual(hits.filter((hit) => !allowed(hit)).map(({ file, line, rule, text }) => `${file}:${line} ${rule}：${text}`), []);
  // 放行表里的每一条都还用得着，用不着了就删掉那一条。
  for (const entry of ALLOWED) assert.ok(hits.some((hit) => hit.file === entry.file && hit.text.includes(entry.snippet)), `${entry.file}：${entry.reason}`);
});
