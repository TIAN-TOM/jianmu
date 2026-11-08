// 认发送方：闸门之前只按扩展编号、来源、扩展页面的路径和框架编号分类，不读网页地址；站点和视频过了闸门再按地址认。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createSenders, type MessageSender, type SenderCtx } from "../../../src/background/senders.ts";
import { PAGE_PATHS } from "../../../src/shared/names.ts";
import { splitSource } from "../../helpers/source-scan.ts";
import {
  createFakeChrome,
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  extensionUrl,
  SAMPLE_VIDEO_ID,
  senders,
  tubeUrl,
  watchedSender,
  watchUrl,
} from "../../helpers/chrome.ts";

function setup() {
  const fake = createFakeChrome();
  return { fake, rules: createSenders({ extensionId: EXTENSION_ID, extensionUrl, rules: fake.siteRules }) };
}

const kindOf = (ctx: SenderCtx | null) => (ctx ? (ctx.page ? `${ctx.kind}:${ctx.page}` : ctx.kind) : null);

test("发送方分类矩阵：侧边栏、设置页、粗筛页、其他扩展页面、卡片、内容脚本，认不出的拒绝", () => {
  const { rules } = setup();
  const cases: readonly [string, MessageSender | undefined, string | null][] = [
    ["侧边栏", senders.panel(), "panel"],
    ["侧边栏页面自己占一个标签页", senders.panelInTab(), "panel"],
    ["设置页", senders.options(), "page:options"],
    ["粗筛页", senders.triage(), "page:triage"],
    ["认不出路径的扩展页面", senders.otherPage(), "page:other"],
    ["没带标签页的设置页", { id: EXTENSION_ID, origin: EXTENSION_ORIGIN, url: extensionUrl(PAGE_PATHS.options) }, "page:options"],
    ["没带标签页的卡片页认不出来历", { id: EXTENSION_ID, origin: EXTENSION_ORIGIN, url: extensionUrl(PAGE_PATHS.card) }, "page:other"],
    ["嵌在视频页里的卡片", senders.card(), "card"],
    ["嵌在视频页里、路径编码过的卡片", senders.card(21, "pages/%63ard.html"), "card"],
    ["嵌在视频页里、冒充设置页路径的扩展框架", senders.card(21, PAGE_PATHS.options), "card"],
    ["卡片页自己占一个标签页", senders.page(PAGE_PATHS.card), "card"],
    ["一个站的内容脚本", senders.content(), "content"],
    ["另一个站的内容脚本", senders.content(tubeUrl()), "content"],
    ["别的扩展", senders.foreign(), null],
    ["编号对、既不是扩展页面也没有标签页", senders.stray(), null],
    ["没有发送方", undefined, null],
  ];
  for (const [label, sender, expected] of cases) assert.equal(kindOf(rules.authenticate(sender)), expected, label);
});

test("扩展页面的路径编码过、大小写不同、多了斜杠也认成同一页", () => {
  const { rules } = setup();
  for (const path of ["pages/%6Fptions.html", "PAGES/Options.html", "pages//options.html", "pages/options.html?from=x#top"]) {
    assert.equal(kindOf(rules.authenticate(senders.page(path))), "page:options", path);
  }
});

test("认发送方时带上标签页、窗口和框架编号，不带地址", () => {
  const { rules } = setup();
  assert.deepEqual(rules.authenticate(senders.content(watchUrl(), 31)), { kind: "content", tabId: 31, windowId: 3, frameId: 0 });
  assert.deepEqual(rules.authenticate(senders.card(21)), { kind: "card", tabId: 21, windowId: 2, frameId: 7 });
});

test("闸门之前的分类不读网页地址：标签页地址、标题和内容脚本的地址都不碰，也不解析地址", () => {
  const { fake, rules } = setup();
  for (const sender of [senders.panel(), senders.options(), senders.card(), senders.content(), senders.content(tubeUrl()), senders.foreign()]) {
    const reads: string[] = [];
    rules.authenticate(watchedSender(sender, reads, () => false));
    const forbidden = reads.filter((name) => ["tab.url", "tab.pendingUrl", "tab.title"].includes(name));
    assert.deepEqual(forbidden, [], JSON.stringify(sender));
    if (sender.origin !== EXTENSION_ORIGIN) assert.equal(reads.includes("sender.url"), false, "内容脚本的地址不读");
  }
  assert.deepEqual(fake.calls.siteParses, []);
});

test("过了闸门才按标签页地址认站点和视频；认不出的视频页是 null", () => {
  const { rules } = setup();
  const content = senders.content(watchUrl(SAMPLE_VIDEO_ID), 31);
  const ctx = rules.authenticate(content);
  assert.ok(ctx);
  assert.deepEqual(rules.resolveSite(ctx, content), {
    kind: "content",
    tabId: 31,
    windowId: 3,
    frameId: 0,
    site: "bilibili",
    video: { platform: "bilibili", videoId: SAMPLE_VIDEO_ID },
  });

  const tube = senders.content(tubeUrl("abc"), 32);
  assert.equal(rules.resolveSite(rules.authenticate(tube) ?? assert.fail(), tube)?.site, "youtube");

  const elsewhere = senders.content("https://watch.example/home", 33);
  assert.equal(rules.resolveSite(rules.authenticate(elsewhere) ?? assert.fail(), elsewhere), null);
  assert.equal(rules.resolveSite(rules.authenticate(senders.options()) ?? assert.fail(), senders.options()), null, "扩展页面没有站点");
});

test("认扩展页面用不带前导斜杠的路径常量拼完整地址，源码里不写斜杠开头的页面路径", () => {
  const source = readFileSync(new URL("../../../src/background/senders.ts", import.meta.url), "utf8");
  const leading = splitSource(source).strings.filter((value) => /^\/[\w.-]+\//.test(value));
  assert.deepEqual(leading, []);
  for (const path of Object.values(PAGE_PATHS)) assert.doesNotMatch(path, /^\//);
});
