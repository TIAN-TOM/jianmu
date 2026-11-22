// 设置页：确认启用之前只有启用说明、资料和「关于」两节，「关于」里的版本号、构建标识和四个链接都对；确认以后能保存服务商、密钥和模型，拉模型列表（状态行说已保存，框里的型号不在列表里时提醒）、测试连接对着模拟的模型服务走通，
// 密钥只进会话存储；本机 http 地址不填密钥也能保存、拉列表和测试连接；导出的备份清除全部数据后能再导回来，
// 超过单条消息上限的备份也一样。各测试开头先清除全部数据，从没启用的状态开始。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { videoKey } from "../../src/core/video-ref.ts";
import { BUILD_ID_FILE } from "../../src/shared/build-id.ts";
import { API_KEY_SESSION_KEY, ISSUES_URL, PAGE_PATHS, PRIVACY_POLICY_URL, RELEASES_URL, SETTINGS_STORAGE_KEY, SOURCE_URL, SPONSOR_URLS } from "../../src/shared/names.ts";
import { DATA_CONSENT_TABLE, dataConsentErrorText, noticeStatus, noticeText } from "../../src/core/consent.ts";
import { OPTIONS_EN } from "../../src/pages/options/text-en.ts";
import { OPTIONS_HANT } from "../../src/pages/options/text-hant.ts";
import { OPTIONS_ZH } from "../../src/pages/options/text-zh.ts";
import { FEATURE_MODEL_SLOTS, UI_FONT_SCALES } from "../../src/shared/settings-schema.ts";
import { charsIn, SIMPLIFIED_ONLY } from "../../tests/helpers/hant-chars.ts";
import { ANTHROPIC, VIDEOS } from "../fixtures.mjs";
import { scenario } from "./harness.mjs";

const test = scenario(import.meta.url);
const FULL_CONSENT = noticeStatus(DATA_CONSENT_TABLE, {});
/** 数据说明第一条的英文措辞。 */
const DATA_CONSENT_EN_FIRST = FULL_CONSENT.state === "needed" ? (FULL_CONSENT.items[0]?.en ?? "") : "";
/** 数据说明第一条的繁体措辞。 */
const DATA_CONSENT_HANT_FIRST = FULL_CONSENT.state === "needed" && FULL_CONSENT.items[0] ? noticeText(FULL_CONSENT.items[0], "zh-Hant") : "";
const WIDTH = 900;
const PACKAGE_VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
const [VIDEO_ID = ""] = Object.keys(VIDEOS);
const VIDEO = videoKey({ platform: "bilibili", videoId: VIDEO_ID, segment: 1 });

/** 发给后台一条消息，回后台的回复。 */
const send = (page, type, req) => page.call(`(type, req) => chrome.runtime.sendMessage({ type, req })`, type, req);

/** 清掉上一个测试留下的数据，另开一个设置页。 */
async function freshOptions(open) {
  const first = await open(PAGE_PATHS.options, { width: WIDTH });
  assert.deepEqual(await send(first, "data.clear", { scope: "all" }), { ok: true, value: {} });
  const page = await open(PAGE_PATHS.options, { width: WIDTH });
  await page.waitFor("显示启用说明", `document.querySelector(".activation") !== null`);
  return page;
}

/** 按文字找按钮，真实点击它中间。 */
async function clickButton(page, text, within = "body") {
  const box = await page.call(
    `(text, within) => {
      const node = [...document.querySelector(within).querySelectorAll("button")].find((button) => button.textContent.trim() === text);
      if (!node) throw new Error("找不到按钮 " + text);
      node.scrollIntoView({ block: "center" });
      const rect = node.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }`,
    text,
    within,
  );
  await page.clickAt(box.x, box.y);
}

/** 填输入框或选下拉框，按用户输入的样子发事件。 */
const fill = (page, selector, value) =>
  page.call(
    `(selector, value) => {
      const node = document.querySelector(selector);
      if (!node) throw new Error("找不到 " + selector);
      node.focus();
      node.value = value;
      node.dispatchEvent(new Event("input", { bubbles: true }));
      node.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }`,
    selector,
    value,
  );

/** 某一节里有字的那条状态行。「AI 服务」一节有好几个位置，同一时间只有一个位置有字。 */
const statusText = (section) => `([...document.querySelectorAll("#${section} .status")].map((node) => node.textContent).find((text) => text) ?? "")`;
const statusOf = (page, section) => page.evaluate(statusText(section));

/** 等某一节的状态行以这段文字开头；等不到时把当时的状态行写进报错。 */
async function statusStarts(page, section, prefix, timeoutMs = undefined) {
  try {
    await page.waitFor(`状态行出现「${prefix}」`, `${statusText(section)}.startsWith(${JSON.stringify(prefix)})`, timeoutMs);
  } catch (error) {
    throw new Error(`${error.message}；状态行是「${await statusOf(page, section)}」`);
  }
  return statusOf(page, section);
}

/** 「AI 服务」一节里有字的状态行落在哪：跟着哪个控件、离上面那个元素多远、在不在视口里，这一节一共几条有字。 */
const placedStatus = (page, above) =>
  page.call(
    `(above) => {
      const shown = [...document.querySelectorAll("#ai-service .status")].filter((node) => node.textContent);
      const [node] = shown;
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const anchor = document.querySelector(above).getBoundingClientRect();
      return { at: node.dataset.statusAt, gap: Math.round(rect.top - anchor.bottom), inView: rect.top >= 0 && rect.bottom <= innerHeight, shown: shown.length };
    }`,
    above,
  );

async function enable(page) {
  await clickButton(page, "启用简幕");
  await page.waitFor("确认启用后出现 AI 服务一节", `document.getElementById("preset") !== null`);
}

test("设置页：确认启用之前只有启用说明和资料一节，确认以后才有 AI 服务和外观", async ({ open }) => {
  const page = await freshOptions(open);
  const before = await page.evaluate(`({
    sections: [...document.querySelectorAll(".card > h2")].map((node) => node.textContent),
    hasPreset: document.getElementById("preset") !== null,
    buttons: [...document.querySelectorAll("#learning-data button")].map((node) => node.textContent.trim()),
  })`);
  assert.equal(before.hasPreset, false);
  assert.deepEqual(before.sections, ["学习资料", "关于"]);
  assert.deepEqual(before.buttons, ["导出备份", "清除缓存", "清除全部数据"], "确认前不能恢复备份");
  await enable(page);
  const after = await page.evaluate(`[...document.querySelectorAll(".card > h2")].map((node) => node.textContent)`);
  assert.deepEqual(after, ["外观", "播放页", "YouTube", "AI 服务", "打开就出结论", "速览和精读", "稍后再看粗筛", "学习资料", "关于"]);
  // 测试构建里 YouTube 开关打开；没给过授权，这一节只有启用按钮。
  await page.waitFor("YouTube 的启用按钮", `[...document.querySelectorAll("#youtube button")].map((node) => node.textContent.trim()).join() === "在 YouTube 上启用"`);
  assert.equal(await page.overflowsX(), false);
});

test("设置页：「关于」一节显示清单里的版本号和这次构建的标识，更新记录、源码、隐私政策、反馈问题和赞助在新标签页打开", async ({ open, extensionDir }) => {
  const page = await freshOptions(open);
  const manifest = JSON.parse(readFileSync(join(extensionDir, "manifest.json"), "utf8"));
  const build = readFileSync(join(extensionDir, BUILD_ID_FILE), "utf8").trim();
  const about = await page.evaluate(`(() => {
    const link = (id) => {
      const node = document.getElementById(id);
      return { text: node.textContent, href: node.getAttribute("href"), target: node.getAttribute("target"), rel: node.getAttribute("rel") };
    };
    return {
      version: document.getElementById("aboutVersion").textContent,
      build: document.getElementById("aboutBuild").textContent,
      selectable: getComputedStyle(document.getElementById("aboutBuild")).userSelect,
      releases: link("aboutReleases"),
      source: link("aboutSource"),
      privacy: link("aboutPrivacy"),
      issues: link("aboutIssues"),
      sponsor: link("aboutSponsor"),
      order: [...document.querySelectorAll(".about-links a")].map((node) => node.id),
    };
  })()`);
  assert.equal(about.version, manifest.version);
  assert.equal(about.version, PACKAGE_VERSION);
  assert.match(build, /^[0-9a-f]{16}$/);
  assert.equal(about.build, build);
  assert.notEqual(about.selectable, "none");
  const rel = "noopener noreferrer";
  assert.deepEqual(about.releases, { text: "更新记录", href: RELEASES_URL, target: "_blank", rel });
  assert.deepEqual(about.source, { text: "源码", href: SOURCE_URL, target: "_blank", rel });
  assert.deepEqual(about.order, ["aboutReleases", "aboutSource", "aboutPrivacy", "aboutIssues", "aboutSponsor"]);
  assert.deepEqual(about.privacy, { text: "隐私政策", href: PRIVACY_POLICY_URL, target: "_blank", rel });
  assert.deepEqual(about.issues, { text: "反馈问题", href: ISSUES_URL, target: "_blank", rel });
  assert.deepEqual(about.sponsor, { text: "赞助", href: SPONSOR_URLS.zh, target: "_blank", rel });
  assert.equal(PRIVACY_POLICY_URL, "https://github.com/TIAN-TOM/jianmu/blob/main/PRIVACY.md");
  assert.equal(ISSUES_URL, "https://github.com/TIAN-TOM/jianmu/issues");
  assert.equal(RELEASES_URL, "https://github.com/TIAN-TOM/jianmu/releases");
  assert.equal(SOURCE_URL, "https://github.com/TIAN-TOM/jianmu");
  assert.equal(SPONSOR_URLS.zh, "https://github.com/TIAN-TOM/jianmu#赞助");
  assert.equal(SPONSOR_URLS.en, "https://github.com/TIAN-TOM/jianmu/blob/main/README.en.md#sponsor");
  assert.equal(await page.overflowsX(), false);
});

test("设置页：选服务商、填密钥、勾同意后保存，拉模型列表和测试连接对着模拟服务走通，密钥只进会话", async ({ open }) => {
  const page = await freshOptions(open);
  await enable(page);
  await fill(page, "#preset", ANTHROPIC.presetId);
  await fill(page, "#aiApiKey", ANTHROPIC.key);
  // 没勾同意先保存：提示还差同意。勾上以后这句话跟着变，不留着「请勾选」。
  await clickButton(page, "保存并授权");
  assert.match(await statusStarts(page, "ai-service", "已保存并授权，但 AI 功能暂时用不了"), /我已了解/);
  await page.click("#dataConsent");
  await page.waitFor("同意记下了", `document.getElementById("dataConsent").checked`);
  await page.waitFor("那句还差同意的提示换掉了", `${statusText("ai-service")} === "已保存并授权。"`);

  // 状态行跟着点的那个控件走：拉取的结果紧挨在模型框下面，不用滚到这一节最底下找。
  // 拉取先保存过，状态行说出来；框里预填的型号不在拉到的列表里，多提醒一句。
  const prefilled = await page.evaluate(`document.getElementById("aiModel").value`);
  await clickButton(page, "拉取模型列表");
  assert.equal(
    await statusStarts(page, "ai-service", "已保存并授权，拉到"),
    `已保存并授权，拉到 1 个模型，可以在模型框里直接选。模型框里的「${prefilled}」不在列表里，可能是旧名字或打错了，核对一下；有的服务也认列表外的别名。`,
  );
  const fetched = await placedStatus(page, "#aiModel");
  assert.deepEqual({ at: fetched.at, inView: fetched.inView, shown: fetched.shown }, { at: "model", inView: true, shown: 1 });
  assert.ok(fetched.gap >= 0 && fetched.gap <= 16, `离模型框 ${fetched.gap} 像素`);
  // 框里预填的型号不在拉到的列表里：框右边多一个箭头，在框的边框里面；点开照样列出拉到的全部，贴在框下面、和框一样宽。
  const toggle = `button[data-model-pick="aiModel"]`;
  const modelBox = () =>
    page.evaluate(`(() => {
      const field = document.getElementById("aiModel");
      const a = field.getBoundingClientRect();
      const b = document.querySelector(${JSON.stringify(toggle)}).getBoundingClientRect();
      const list = field.parentElement.querySelector("[role=listbox]");
      const c = list?.getBoundingClientRect();
      const options = [...(list?.querySelectorAll("[role=option]") ?? [])];
      return {
        value: field.value,
        role: field.getAttribute("role"),
        expanded: field.getAttribute("aria-expanded"),
        focused: document.activeElement === field,
        toggleInside: b.left >= a.left && b.right <= a.right && b.top >= a.top && b.bottom <= a.bottom,
        toggleWidth: b.width,
        options: options.map((node) => node.textContent),
        selected: options.filter((node) => node.getAttribute("aria-selected") === "true").map((node) => node.textContent),
        active: options.find((node) => node.id === field.getAttribute("aria-activedescendant"))?.textContent ?? null,
        placed: c ? { below: c.top >= a.bottom && c.top - a.bottom <= 8, sameWidth: Math.abs(c.left - a.left) <= 1 && Math.abs(c.right - a.right) <= 1 } : null,
        oldControls: document.querySelectorAll("datalist, select.model-pick").length,
        featureToggles: document.querySelectorAll("#featureModels button[data-model-pick]").length,
        featureInputs: document.querySelectorAll("#featureModels input[data-feature]").length,
      };
    })()`);
  const closed = await modelBox();
  assert.notEqual(closed.value, ANTHROPIC.model);
  assert.deepEqual(
    { role: closed.role, expanded: closed.expanded, options: closed.options, toggleInside: closed.toggleInside, oldControls: closed.oldControls },
    { role: "combobox", expanded: "false", options: [], toggleInside: true, oldControls: 0 },
  );
  assert.ok(closed.toggleWidth > 0 && closed.toggleWidth <= 40, `下拉箭头宽 ${closed.toggleWidth} 像素`);
  assert.ok(closed.featureToggles > 0 && closed.featureToggles === closed.featureInputs, `按功能选模型的 ${closed.featureInputs} 个框里有 ${closed.featureToggles} 个带箭头`);
  await page.click(toggle);
  await page.waitFor("点箭头列出拉到的模型", `document.getElementById("aiModel").getAttribute("aria-expanded") === "true"`);
  const opened = await modelBox();
  assert.deepEqual(
    { options: opened.options, selected: opened.selected, active: opened.active, focused: opened.focused, placed: opened.placed },
    { options: [ANTHROPIC.model], selected: [], active: null, focused: true, placed: { below: true, sameWidth: true } },
  );
  assert.equal(await page.overflowsX(), false);
  // 焦点留在框里，方向键移到候选上，回车填进框里并收起。
  await page.press("ArrowDown");
  await page.waitFor("方向键停在第一个候选上", `document.getElementById("aiModel").hasAttribute("aria-activedescendant")`);
  assert.equal((await modelBox()).active, ANTHROPIC.model);
  await page.press("Enter");
  await page.waitFor("选的型号填进模型框", `document.getElementById("aiModel").value === ${JSON.stringify(ANTHROPIC.model)}`);
  assert.deepEqual((({ expanded, options }) => ({ expanded, options }))(await modelBox()), { expanded: "false", options: [] });
  // 点框也能打开，框里的型号在列表里标成已选。
  await page.click("#aiModel");
  await page.waitFor("点框打开候选", `document.getElementById("aiModel").getAttribute("aria-expanded") === "true"`);
  assert.deepEqual((await modelBox()).selected, [ANTHROPIC.model]);
  // 打的字列表里没有：候选收起，照填的名称用。
  await fill(page, "#aiModel", "sample-unlisted-model");
  await page.waitFor("没有匹配的候选时收起", `document.getElementById("aiModel").getAttribute("aria-expanded") === "false"`);
  await fill(page, "#aiModel", ANTHROPIC.model.slice(0, 4).toUpperCase());
  await page.waitFor("打字按框里的字筛，不分大小写", `document.querySelectorAll("#ai-service [role=option] mark").length === 1`);
  await page.click("#ai-service [role=option]");
  await page.waitFor("点候选填进模型框", `document.getElementById("aiModel").value === ${JSON.stringify(ANTHROPIC.model)}`);
  assert.equal(await page.overflowsX(), false);

  // 勾记住密钥：要点保存才算数的那句话写在勾选框下面；取消以后也写在那里。没保存过，密钥还是只在会话里。
  await page.click("#rememberApiKey");
  assert.equal(await statusStarts(page, "ai-service", "点「保存并授权」以后"), "点「保存并授权」以后，密钥才会记在这台电脑上。");
  const remembering = await placedStatus(page, "#rememberApiKey");
  assert.deepEqual({ at: remembering.at, inView: remembering.inView, shown: remembering.shown }, { at: "remember", inView: true, shown: 1 });
  assert.ok(remembering.gap >= 0 && remembering.gap <= 16, `离勾选框 ${remembering.gap} 像素`);
  await page.click("#rememberApiKey");
  await statusStarts(page, "ai-service", "已不再记住密钥");
  assert.equal((await placedStatus(page, "#rememberApiKey")).at, "remember");

  await clickButton(page, "保存并授权");
  assert.equal(await statusStarts(page, "ai-service", "已保存"), "已保存并授权。");
  assert.equal((await placedStatus(page, "#aiModel")).at, "actions");
  await clickButton(page, "测试连接");
  assert.equal(await statusStarts(page, "ai-service", "默认模型"), `默认模型（${ANTHROPIC.model}）连接正常，回复「可用」`);
  assert.deepEqual((({ at, shown }) => ({ at, shown }))(await placedStatus(page, "#aiModel")), { at: "actions", shown: 1 });
  // 框里换成列表里有的型号以后再拉，不再提醒。
  await clickButton(page, "拉取模型列表");
  await page.waitFor("再拉一次只说已保存和拉到几个", `${statusText("ai-service")} === "已保存并授权，拉到 1 个模型，可以在模型框里直接选。"`);

  const stored = await page.evaluate(`Promise.all([chrome.storage.local.get(null), chrome.storage.session.get(${JSON.stringify(API_KEY_SESSION_KEY)})])`);
  const [local, session] = stored;
  assert.equal(local[SETTINGS_STORAGE_KEY].presetId, ANTHROPIC.presetId);
  assert.equal(local[SETTINGS_STORAGE_KEY].aiModel, ANTHROPIC.model);
  assert.equal(JSON.stringify(local).includes(ANTHROPIC.key), false, "没选记住，密钥不进本机存储");
  assert.equal(session[API_KEY_SESSION_KEY]?.key, ANTHROPIC.key);

  // 重新打开设置页，表单按存着的设置填回来。
  const reopened = await open(PAGE_PATHS.options, { width: WIDTH });
  await reopened.waitFor("重新打开后表单填回来", `document.getElementById("aiModel")?.value === ${JSON.stringify(ANTHROPIC.model)}`);
  assert.equal(await reopened.evaluate(`document.getElementById("aiApiKey").value`), ANTHROPIC.key);
  assert.equal(await statusOf(reopened, "ai-service"), "", "密钥还在，不提示");

  // 浏览器重启以后会话里的密钥没了：再打开设置页，密钥框下面直接说要重新填，也不再摆「先选一类服务」。
  await reopened.evaluate(`chrome.storage.session.remove(${JSON.stringify(API_KEY_SESSION_KEY)}).then(() => true)`);
  const restarted = await open(PAGE_PATHS.options, { width: WIDTH });
  await restarted.waitFor("密钥框下面说要重新填", `${statusText("ai-service")}.includes("重新填")`);
  const missing = await placedStatus(restarted, "#aiApiKey");
  assert.deepEqual({ at: missing.at, shown: missing.shown }, { at: "key", shown: 1 });
  assert.ok(missing.gap >= 0 && missing.gap <= 16, `离密钥框 ${missing.gap} 像素`);
  assert.equal(await restarted.evaluate(`[...document.querySelectorAll("#ai-service button")].some((node) => node.textContent.trim() === "国内服务")`), false);
  await fill(restarted, "#aiApiKey", ANTHROPIC.key);
  await restarted.waitFor("开始填密钥，那句话收起", `${statusText("ai-service")} === ""`);
});

/** 本机的 OpenAI 兼容服务，只开 http、不要密钥。记下每个请求的地址和认证头。models 是它列出的模型。 */
async function startLocalService(models = ["local-model"]) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? "", authorization: req.headers.authorization ?? null, apiKey: req.headers["x-api-key"] ?? null });
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      if (req.url?.endsWith("/models")) res.end(JSON.stringify({ object: "list", data: models.map((id) => ({ id, object: "model" })) }));
      else res.end(JSON.stringify({ id: "local", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: "可用" }, finish_reason: "stop" }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  return {
    base: `http://127.0.0.1:${port}/v1`,
    seen,
    close: () => new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve(undefined));
    }),
  };
}

// 自造的模型名：够多，列表要滚；有一个很长，一行放不下。按名字排好，设置页也是这个顺序。
const LONG_MODEL = "sample-vendor-with-a-long-name/sample-model-with-a-very-long-identifier-preview-extended-context";
const MANY_MODELS = [
  ...["large", "medium", "small", "tiny"].flatMap((size) => [`sample-${size}-2`, `sample-${size}-2-fast`, `sample-${size}-1`]),
  "sample-vision-2",
  "sample-reason-1",
  "other-chat-3",
  LONG_MODEL,
].sort();

test("设置页：拉到很多模型时，候选列表自己滚、长名字折行不撑出框，打字按字筛并标出命中，框靠近窗口底边时列表开在上面", async ({ open }) => {
  const local = await startLocalService(MANY_MODELS);
  try {
    const page = await freshOptions(open);
    await enable(page);
    await fill(page, "#preset", "custom");
    await page.waitFor("出现地址框", `document.getElementById("aiBaseUrl") !== null`);
    await fill(page, "#protocol", "openai");
    await fill(page, "#aiBaseUrl", local.base);
    await page.click("#dataConsent");
    await page.waitFor("同意记下了", `document.getElementById("dataConsent").checked`);
    await clickButton(page, "拉取模型列表");
    await statusStarts(page, "ai-service", `已保存并授权，拉到 ${MANY_MODELS.length} 个模型`);

    const list = () =>
      page.evaluate(`(() => {
        const field = document.getElementById("aiModel");
        const menu = field.parentElement.querySelector("[role=listbox]");
        if (!menu) return null;
        const a = field.getBoundingClientRect();
        const b = menu.getBoundingClientRect();
        const options = [...menu.querySelectorAll("[role=option]")];
        const active = document.getElementById(field.getAttribute("aria-activedescendant") ?? "");
        const c = active?.getBoundingClientRect();
        return {
          options: options.map((node) => node.textContent),
          marks: options.map((node) => [...node.querySelectorAll("mark")].map((mark) => mark.textContent).join("|")),
          scrolls: menu.scrollHeight > menu.clientHeight,
          insideList: options.every((node) => { const r = node.getBoundingClientRect(); return r.left >= b.left && r.right <= b.right && node.scrollWidth <= node.clientWidth; }),
          sameWidth: Math.abs(b.left - a.left) <= 1 && Math.abs(b.right - a.right) <= 1,
          side: b.top >= a.bottom ? "bottom" : b.bottom <= a.top ? "top" : "over",
          inView: b.top >= 0 && b.bottom <= innerHeight,
          active: active?.textContent ?? null,
          activeInView: c ? c.top >= b.top - 1 && c.bottom <= b.bottom + 1 : null,
        };
      })()`);
    const expanded = (wanted) => `document.getElementById("aiModel").getAttribute("aria-expanded") === "${wanted}"`;

    // 点箭头：全部列出来，列表比框高不了多少、自己滚；最长的那个名字折行，不撑出列表，页面也不出横向滚动条。
    await page.click(`button[data-model-pick="aiModel"]`);
    await page.waitFor("列出全部模型", expanded(true));
    const all = await list();
    assert.deepEqual(all.options, MANY_MODELS);
    assert.deepEqual({ scrolls: all.scrolls, insideList: all.insideList, sameWidth: all.sameWidth, side: all.side }, { scrolls: true, insideList: true, sameWidth: true, side: "bottom" });
    assert.equal(await page.overflowsX(), false);
    // 向上方向键从最后一个起，列表跟着滚到它。
    await page.press("ArrowUp");
    await page.waitFor("停在最后一个候选", `document.getElementById("aiModel").hasAttribute("aria-activedescendant")`);
    assert.deepEqual((({ active, activeInView }) => ({ active, activeInView }))(await list()), { active: MANY_MODELS.at(-1), activeInView: true });
    // 再点一次箭头收起，焦点还在框里。
    await page.click(`button[data-model-pick="aiModel"]`);
    await page.waitFor("再点箭头收起", expanded(false));
    assert.equal((await page.focused()).id, "aiModel");

    // 打字：按空白隔开的每一段筛，不分大小写，命中的字标出来；不替人选第一个，回车只收起，框里还是打的字。
    await fill(page, "#aiModel", "FAST small");
    await page.waitFor("按字筛出候选", expanded(true));
    const filtered = await list();
    assert.deepEqual({ options: filtered.options, marks: filtered.marks, active: filtered.active }, { options: ["sample-small-2-fast"], marks: ["small|fast"], active: null });
    await page.press("Enter");
    await page.waitFor("回车收起", expanded(false));
    assert.equal(await page.evaluate(`document.getElementById("aiModel").value`), "FAST small");
    // 向下方向键打开全部，停在第一个；再按一下到第二个，回车填进框里。
    await page.press("ArrowDown");
    await page.waitFor("方向键打开候选", expanded(true));
    assert.deepEqual((({ options, active }) => ({ count: options.length, active }))(await list()), { count: MANY_MODELS.length, active: MANY_MODELS[0] });
    await page.press("ArrowDown");
    await page.press("Enter");
    await page.waitFor("回车填进模型框", `document.getElementById("aiModel").value === ${JSON.stringify(MANY_MODELS[1])}`);

    // 框贴近窗口底边：列表开在上面，整个露在窗口里。
    // 这里按坐标点：page.click 会先把元素滚到窗口中间。
    const low = await page.evaluate(`(() => {
      scrollBy(0, document.getElementById("aiModel").getBoundingClientRect().bottom - innerHeight + 24);
      const r = document.querySelector('button[data-model-pick="aiModel"]').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await page.clickAt(low.x, low.y);
    await page.waitFor("列表开在上面", `document.getElementById("aiModel").parentElement.dataset.side === "top" && ${expanded(true)}`);
    const above = await list();
    assert.deepEqual({ side: above.side, inView: above.inView, active: above.active, activeInView: above.activeInView }, { side: "top", inView: true, active: MANY_MODELS[1], activeInView: true });
    // 点到别的控件上，列表收起。
    await page.click("#aiBaseUrl");
    await page.waitFor("焦点离开后收起", expanded(false));

    // 按功能选模型的每个框也一样带候选；标签点得到框。
    await page.evaluate(`document.querySelector("#featureModels").open = true`);
    const slot = FEATURE_MODEL_SLOTS[0].id;
    await page.click(`#featureModels button[data-model-pick="${slot}"]`);
    await page.waitFor("功能模型的候选", `document.querySelectorAll("#featureModels [role=option]").length === ${MANY_MODELS.length}`);
    assert.equal(await page.overflowsX(), false);
    await page.click(`#featureModels [role=option]:nth-child(3)`);
    await page.waitFor("选的型号填进功能模型框", `document.querySelector('[data-feature="${slot}"]').value === ${JSON.stringify(MANY_MODELS[2])}`);
    assert.equal(await page.evaluate(`document.querySelectorAll("[role=listbox]").length`), 0);
    assert.equal(await page.evaluate(`document.querySelector('label[for="featureModel-${slot}"]').textContent`), OPTIONS_ZH.ai.slots.analysis);
  } finally {
    await local.close();
  }
});

test("设置页：自定义填本机 http 地址、密钥留空，保存、拉模型列表和测试连接都发到本机，请求不带密钥", async ({ open }) => {
  const local = await startLocalService();
  try {
    const page = await freshOptions(open);
    await enable(page);
    await fill(page, "#preset", "custom");
    await page.waitFor("出现地址框", `document.getElementById("aiBaseUrl") !== null`);
    await fill(page, "#protocol", "openai");
    await fill(page, "#aiBaseUrl", local.base);
    await page.click("#dataConsent");
    await page.waitFor("同意记下了", `document.getElementById("dataConsent").checked`);

    // 模型还没填，先保存拿到授权；提示只说缺模型，不要密钥。
    await clickButton(page, "保存并授权");
    assert.equal(await statusStarts(page, "ai-service", "已保存"), "已保存并授权，但 AI 功能暂时用不了：请填写模型名称，或点击「拉取模型列表」进行选择。");
    await clickButton(page, "拉取模型列表");
    assert.equal(await statusStarts(page, "ai-service", "已保存并授权，拉到"), "已保存并授权，拉到 1 个模型，在模型框里选一个，再点「保存并授权」。");
    await fill(page, "#aiModel", "local-model");
    await clickButton(page, "保存并授权");
    await page.waitFor("模型存下", `chrome.storage.local.get(${JSON.stringify(SETTINGS_STORAGE_KEY)}).then((items) => items[${JSON.stringify(SETTINGS_STORAGE_KEY)}]?.aiModel === "local-model")`);
    await clickButton(page, "测试连接");
    assert.equal(await statusStarts(page, "ai-service", "默认模型"), "默认模型（local-model）连接正常，回复「可用」");

    const stored = await page.evaluate(`chrome.storage.local.get(${JSON.stringify(SETTINGS_STORAGE_KEY)}).then((items) => items[${JSON.stringify(SETTINGS_STORAGE_KEY)}])`);
    assert.equal(stored.aiBaseUrl, local.base);
    assert.deepEqual(local.seen.map(({ path }) => path), ["/v1/models", "/v1/chat/completions"]);
    for (const request of local.seen) assert.deepEqual([request.authorization, request.apiKey], [null, null], request.path);
  } finally {
    await local.close();
  }
});

test("设置页：打开就出结论默认关；没同意时勾开关先列出说明，同意并打开后才开；关掉、改时长不用同意；时长写明范围，填的数被改了就地说一句", async ({ open }) => {
  const { AUTO_OVERVIEW_MINUTES } = await import("../../src/shared/settings-schema.ts");
  const page = await freshOptions(open);
  await enable(page);
  const stored = () => page.evaluate(`chrome.storage.local.get(${JSON.stringify(SETTINGS_STORAGE_KEY)}).then((items) => items[${JSON.stringify(SETTINGS_STORAGE_KEY)}] ?? {})`);
  assert.equal(await page.evaluate(`document.getElementById("autoOverview").checked`), false);
  assert.equal(await page.evaluate(`document.getElementById("autoOverviewMinutes").value`), "10");
  const sectionText = await page.evaluate(`document.getElementById("auto-overview").textContent`);
  assert.match(sectionText, /改了马上生效，不用点「保存并授权」/);
  assert.ok(sectionText.includes(`${AUTO_OVERVIEW_MINUTES.min} 到 ${AUTO_OVERVIEW_MINUTES.max} 的整数`), "写明时长的范围");

  await page.click("#autoOverview");
  await page.waitFor("列出数据说明", `document.querySelector("#auto-overview .consent-lines") !== null`);
  const listed = await page.evaluate(`document.querySelector("#auto-overview .consent-lines").textContent`);
  assert.match(listed, /打开「打开就出结论」以后/);
  assert.equal(await page.evaluate(`document.getElementById("autoOverview").checked`), false, "同意之前不打开");
  assert.equal((await stored()).autoOverview, false);

  await clickButton(page, "同意并打开", "#auto-overview");
  await page.waitFor("开关打开", `document.getElementById("autoOverview").checked && document.getElementById("dataConsent").checked`);
  const on = await stored();
  assert.equal(on.autoOverview, true);
  assert.ok(on.dataConsentVersion > 0, "同意一起存下");

  const max = AUTO_OVERVIEW_MINUTES.max;
  const minutesNote = `document.querySelector("#auto-overview .status[role=status]").textContent`;
  await fill(page, "#autoOverviewMinutes", "99999");
  await page.waitFor("超上限存成上限", `chrome.storage.local.get(${JSON.stringify(SETTINGS_STORAGE_KEY)}).then((items) => items[${JSON.stringify(SETTINGS_STORAGE_KEY)}]?.autoOverviewMinutes === ${max})`);
  assert.equal(await page.evaluate(`document.getElementById("autoOverviewMinutes").value`), String(max), "输入框显示存下的数");
  await page.waitFor("就地说改成了多少", `${minutesNote} === ${JSON.stringify(`最多 ${max} 分钟，已改成 ${max}。`)}`);

  await fill(page, "#autoOverviewMinutes", "25");
  await page.waitFor("时长存下", `chrome.storage.local.get(${JSON.stringify(SETTINGS_STORAGE_KEY)}).then((items) => items[${JSON.stringify(SETTINGS_STORAGE_KEY)}]?.autoOverviewMinutes === 25)`);
  await page.waitFor("正常改一次，提示消失", `${minutesNote} === ""`);
  await page.click("#autoOverview");
  await page.waitFor("开关关掉", `chrome.storage.local.get(${JSON.stringify(SETTINGS_STORAGE_KEY)}).then((items) => items[${JSON.stringify(SETTINGS_STORAGE_KEY)}]?.autoOverview === false)`);
  assert.equal(await page.evaluate(`document.querySelector("#auto-overview .consent-lines") === null`), true, "关掉不用同意");
  assert.equal(await page.overflowsX(), false);
});

/** 记下设置页存成文件的内容：导出时页面交给浏览器下载的那份。 */
const keepDownloads = (page) =>
  page.evaluate(`(() => {
    const original = URL.createObjectURL.bind(URL);
    window.__downloads = [];
    URL.createObjectURL = (blob) => {
      window.__downloads.push(blob);
      return original(blob);
    };
    return true;
  })()`);

/** 把一份文件交给「恢复备份」：expression 在页面里算出一个 Blob。 */
const chooseBackup = (page, expression) =>
  page.evaluate(`(async () => {
    const blob = await (${expression});
    const input = document.getElementById("backupImportInput");
    const files = new DataTransfer();
    files.items.add(new File([blob], "backup.json", { type: "application/json" }));
    input.files = files.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);

async function clearAllAndEnable(page) {
  await clickButton(page, "清除全部数据");
  await clickButton(page, "全部清除");
  await page.waitFor("清除完成，回到没启用", `document.querySelector("#learning-data .status").textContent.startsWith("已清除") && document.querySelector(".activation") !== null`);
  assert.deepEqual((await send(page, "notes.list", {})).code, "NOT_ENABLED");
  await enable(page);
}

test("设置页：导出的备份清除全部数据后能再导回来", async ({ open }) => {
  const page = await freshOptions(open);
  await enable(page);
  await keepDownloads(page);
  const saved = await send(page, "notes.save", { video: VIDEO, atSec: 30, text: "页面测试写的笔记" });
  assert.equal(saved.ok, true, JSON.stringify(saved));

  await clickButton(page, "导出备份");
  await statusStarts(page, "learning-data", "已导出 1 条笔记");
  const exported = JSON.parse(await page.evaluate(`window.__downloads.at(-1).text()`));
  assert.equal(exported.kind, "jianmu-backup");
  assert.equal(exported.notes.length, 1);

  await clearAllAndEnable(page);
  await chooseBackup(page, `window.__downloads.at(-1)`);
  assert.match(await statusStarts(page, "learning-data", "合并完成"), /笔记新增 1 条/);
  const notes = await send(page, "notes.list", {});
  assert.deepEqual(
    notes.value.notes.map((note) => note.text),
    ["页面测试写的笔记"],
  );
});

test(
  "设置页：超过单条消息上限的备份分段传，导入、导出、清除后再导回来条数都对得上",
  async ({ open }) => {
    const page = await freshOptions(open);
    await enable(page);
    await keepDownloads(page);
    // 自己造一份九十多 MB 的备份：五十份译文，每份六百段、每段一千来字；再加两百条笔记。
    await page.call(
      `(video) => {
        const line = "这一段是页面测试造的译文，只用来把备份撑大。".repeat(48);
        const translations = Array.from({ length: 50 }, (_, index) => {
          const transcript = { video, kind: "auto", lang: "zh-CN", fingerprint: "fp-page-" + index };
          return {
            id: video + "|" + transcript.fingerprint + "|en",
            video,
            transcript,
            target: "en",
            segments: Object.fromEntries(Array.from({ length: 600 }, (_, segment) => [(segment + 1).toString(16).padStart(8, "f"), segment + " " + line])),
            derived: { basis: { source: "transcript", transcript }, gen: { feature: "rewrite", promptVersion: "1", model: "sample-model", effort: "off" } },
            updatedAt: 100,
          };
        });
        const notes = Array.from({ length: 200 }, (_, index) => ({
          id: "note_page-" + index,
          kind: "note",
          origin: "user",
          video,
          snapshot: { title: "页面测试", author: "样例" },
          atSec: index,
          text: "第 " + index + " 条笔记",
          createdAt: 1,
          updatedAt: 2,
        }));
        window.__big = new Blob([JSON.stringify({ kind: "jianmu-backup", version: 2, exportedAt: "2026-11-19T00:00:00.000Z", notes, overviews: [], qa: [], translations })]);
        return true;
      }`,
      VIDEO,
    );
    const MESSAGE_LIMIT = 64 * 1024 * 1024;
    assert.ok((await page.evaluate(`window.__big.size`)) > MESSAGE_LIMIT * 1.2, "备份要明显超过单条消息的上限");
    // 前提核对：整份放进一条消息，浏览器发不出去。
    assert.match(
      await page.evaluate(`window.__big.text().then((text) => chrome.runtime.sendMessage({ type: "build.id", req: text })).then(() => "发出去了", (error) => String(error))`),
      /exceeded maximum allowed size of 64MiB/,
    );

    await chooseBackup(page, `window.__big`);
    const first = await statusStarts(page, "learning-data", "合并完成", 120_000);
    assert.match(first, /笔记新增 200 条、更新 0 条/);
    assert.match(first, /译文和整理过的字幕新增 50 份、补上 0 份/);
    assert.doesNotMatch(first, /跳过/);

    await clickButton(page, "导出备份");
    assert.match(await statusStarts(page, "learning-data", "已导出", 120_000), /已导出 200 条笔记、0 份概览、0 条问答、50 份译文/);
    assert.ok((await page.evaluate(`window.__downloads.at(-1).size`)) > MESSAGE_LIMIT, "导出的文件也超过单条消息的上限");

    await clearAllAndEnable(page);
    await chooseBackup(page, `window.__downloads.at(-1)`);
    const restored = await statusStarts(page, "learning-data", "合并完成", 120_000);
    assert.match(restored, /笔记新增 200 条、更新 0 条/);
    assert.match(restored, /译文和整理过的字幕新增 50 份、补上 0 份/);
    assert.equal((await send(page, "notes.list", {})).value.notes.length, 200);

    // 再导一次：什么都不新增。
    await chooseBackup(page, `window.__downloads.at(-1)`);
    await page.waitFor("第二次导入合并完", `(document.querySelector("#learning-data .status")?.textContent ?? "").includes("笔记新增 0 条")`, 120_000);
    assert.equal(await statusOf(page, "learning-data"), "合并完成：笔记新增 0 条、更新 0 条，概览新增 0 份、更新 0 份，问答新增 0 条。");
  },
  { timeoutMs: 300_000 },
);

test("设置页：外观一节的语言即改即存，四项是跟随浏览器、简体中文、繁體中文、English，默认跟随浏览器", async ({ open }) => {
  const page = await freshOptions(open);
  await enable(page);
  const options = await page.evaluate(`[...document.querySelectorAll("#language option")].map((node) => [node.value, node.textContent])`);
  assert.deepEqual(options, [["auto", "跟随浏览器"], ["zh", "简体中文"], ["zh-Hant", "繁體中文"], ["en", "English"]]);
  assert.equal(await page.evaluate(`document.getElementById("language").value`), "auto");
  await fill(page, "#language", "en");
  const stored = `chrome.storage.local.get(${JSON.stringify(SETTINGS_STORAGE_KEY)}).then((items) => items[${JSON.stringify(SETTINGS_STORAGE_KEY)}].language)`;
  await page.waitFor("语言不用点保存就存下", `${stored}.then((language) => language === "en")`);
  const reopened = await open(PAGE_PATHS.options, { width: WIDTH });
  await reopened.waitFor("重新打开后填回来", `document.querySelector("#language")?.value === "en"`);
  // 繁体：存下的是 zh-Hant，<html lang> 跟着换，重新打开第一屏就按它定。
  await fill(page, "#language", "zh-Hant");
  await page.waitFor("存下繁体", `${stored}.then((language) => language === "zh-Hant")`);
  await page.waitFor("<html lang> 是 zh-Hant", `document.documentElement.lang === "zh-Hant"`);
  const again = await open(PAGE_PATHS.options, { width: WIDTH });
  await again.waitFor("重新打开后是繁体", `document.documentElement.lang === "zh-Hant" && document.querySelector("#language")?.value === "zh-Hant"`);
});

test("设置页：语言选 English 以后，标题、各节标题和按钮马上换成英文，<html lang> 是 en，重新打开第一屏就是英文；切回中文又全是中文", async ({ open }) => {
  const page = await freshOptions(open);
  await enable(page);
  const view = `({
    lang: document.documentElement.lang,
    title: document.title,
    heading: document.querySelector("h1")?.textContent,
    sections: [...document.querySelectorAll(".card > h2")].map((node) => node.textContent),
    buttons: [...document.querySelectorAll("#ai-service .actions button, #learning-data .actions button")].map((node) => node.textContent.trim()),
    languages: [...document.querySelectorAll("#language option")].map((node) => node.textContent),
  })`;
  const english = {
    lang: "en",
    title: "Jianmu settings",
    heading: "Jianmu settings",
    sections: ["Appearance", "Video page", "YouTube", "AI service", "Verdict on open", "Skim and Study", "Watch Later triage", "Saved data", "About"],
    buttons: ["Save and authorise", "Test connection", "Export backup", "Restore backup", "Clear cache", "Clear all data"],
    languages: ["Match browser", "简体中文", "繁體中文", "English"],
  };
  const chinese = {
    lang: "zh-CN",
    title: "简幕设置",
    heading: "简幕设置",
    sections: ["外观", "播放页", "YouTube", "AI 服务", "打开就出结论", "速览和精读", "稍后再看粗筛", "学习资料", "关于"],
    buttons: ["保存并授权", "测试连接", "导出备份", "恢复备份", "清除缓存", "清除全部数据"],
    languages: ["跟随浏览器", "简体中文", "繁體中文", "English"],
  };
  assert.deepEqual(await page.evaluate(view), chinese);

  await fill(page, "#language", "en");
  await page.waitFor("界面换成英文", `document.documentElement.lang === "en"`);
  assert.deepEqual(await page.evaluate(view), english);

  // 首帧缓存记下了英文：重新打开时一出内容就是英文，不先画一遍中文。
  const reopened = await open(PAGE_PATHS.options, { width: WIDTH });
  await reopened.waitFor("重新打开后出现标题", `document.querySelector("h1") !== null`);
  assert.equal(await reopened.evaluate(`document.querySelector("h1").textContent`), "Jianmu settings");
  await reopened.waitFor("重新打开后各节都在", `document.getElementById("preset") !== null`);
  assert.deepEqual(await reopened.evaluate(view), english);

  await fill(page, "#language", "zh");
  await page.waitFor("界面换回中文", `document.documentElement.lang === "zh-CN"`);
  assert.deepEqual(await page.evaluate(view), chinese);
  await reopened.waitFor("别的设置页跟着换回中文", `document.documentElement.lang === "zh-CN"`);
  assert.deepEqual(await reopened.evaluate(view), chinese);
});

test("设置页：语言选「繁體中文」以后，标题、各节标题和按钮马上换成繁体，<html lang> 是 zh-Hant、字体换成繁体那组，重新打开第一屏就是繁体；切回简体又全是简体", async ({ open }) => {
  const page = await freshOptions(open);
  await enable(page);
  const view = `({
    lang: document.documentElement.lang,
    title: document.title,
    heading: document.querySelector("h1")?.textContent,
    sections: [...document.querySelectorAll(".card > h2")].map((node) => node.textContent),
    buttons: [...document.querySelectorAll("#ai-service .actions button, #learning-data .actions button")].map((node) => node.textContent.trim()),
    languages: [...document.querySelectorAll("#language option")].map((node) => node.textContent),
  })`;
  const traditional = {
    lang: "zh-Hant",
    title: "簡幕設定",
    heading: "簡幕設定",
    sections: ["外觀", "播放頁", "YouTube", "AI 服務", "打開就出結論", "速覽和精讀", "稍後再看粗篩", "學習資料", "關於"],
    buttons: ["儲存並授權", "測試連線", "匯出備份", "還原備份", "清除快取", "清除全部資料"],
    languages: ["跟隨瀏覽器", "简体中文", "繁體中文", "English"],
  };
  const chinese = {
    lang: "zh-CN",
    title: "简幕设置",
    heading: "简幕设置",
    sections: ["外观", "播放页", "YouTube", "AI 服务", "打开就出结论", "速览和精读", "稍后再看粗筛", "学习资料", "关于"],
    buttons: ["保存并授权", "测试连接", "导出备份", "恢复备份", "清除缓存", "清除全部数据"],
    languages: ["跟随浏览器", "简体中文", "繁體中文", "English"],
  };
  const fontSans = `getComputedStyle(document.documentElement).getPropertyValue("--font-sans")`;
  assert.deepEqual(await page.evaluate(view), chinese);
  assert.match(await page.evaluate(fontSans), /PingFang SC/);

  await fill(page, "#language", "zh-Hant");
  await page.waitFor("界面换成繁体", `document.documentElement.lang === "zh-Hant"`);
  assert.deepEqual(await page.evaluate(view), traditional);
  const sans = await page.evaluate(fontSans);
  assert.match(sans, /PingFang TC/);
  assert.doesNotMatch(sans, /PingFang SC/);
  assert.match(await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue("--font-serif")`), /Songti TC/);

  // 首帧缓存记下了繁体：重新打开时一出内容就是繁体，不先画一遍简体。
  const reopened = await open(PAGE_PATHS.options, { width: WIDTH });
  await reopened.waitFor("重新打开后出现标题", `document.querySelector("h1") !== null`);
  assert.equal(await reopened.evaluate(`document.querySelector("h1").textContent`), traditional.heading);
  await reopened.waitFor("重新打开后各节都在", `document.getElementById("preset") !== null`);
  assert.deepEqual(await reopened.evaluate(view), traditional);

  await fill(page, "#language", "zh");
  await page.waitFor("界面换回简体", `document.documentElement.lang === "zh-CN"`);
  assert.deepEqual(await page.evaluate(view), chinese);
  await reopened.waitFor("别的设置页跟着换回简体", `document.documentElement.lang === "zh-CN"`);
  assert.deepEqual(await reopened.evaluate(view), chinese);
});

test("设置页：繁体下数据说明的条目、勾选框和校验提示都是繁体，打开就出结论列出的说明也是繁体；整页可见文字里没有简体专用字，语言下拉里的「简体中文」除外", async ({ open }) => {
  const page = await freshOptions(open);
  await enable(page);
  await fill(page, "#language", "zh-Hant");
  await page.waitFor("界面换成繁体", `document.documentElement.lang === "zh-Hant"`);
  const simplified = (text) => charsIn(text.replaceAll("简体中文", ""), SIMPLIFIED_ONLY);

  const consent = await page.evaluate(`document.getElementById("dataConsentBox").innerText`);
  assert.deepEqual(simplified(consent), [], consent);
  assert.ok(consent.includes(DATA_CONSENT_HANT_FIRST), consent);
  assert.ok(consent.includes(OPTIONS_HANT.consent.agree), consent);

  await fill(page, "#preset", "custom");
  await page.waitFor("出现地址框", `document.getElementById("aiBaseUrl") !== null`);
  await fill(page, "#aiBaseUrl", "http://service.example/v1");
  await clickButton(page, "儲存並授權");
  const badAddress = await statusStarts(page, "ai-service", "API 網址");
  assert.deepEqual(simplified(badAddress), [], badAddress);
  await fill(page, "#preset", ANTHROPIC.presetId);
  await fill(page, "#aiApiKey", ANTHROPIC.key);
  await clickButton(page, "儲存並授權");
  const notReady = await statusStarts(page, "ai-service", "已儲存並授權，但");
  assert.ok(notReady.includes(dataConsentErrorText("zh-Hant")), notReady);

  await page.click("#autoOverview");
  await page.waitFor("列出数据说明", `document.querySelector("#auto-overview .consent-lines") !== null`);
  const listed = await page.evaluate(`document.querySelector("#auto-overview .consent-lines").innerText`);
  assert.deepEqual(simplified(listed), [], listed);
  assert.ok(listed.includes(DATA_CONSENT_HANT_FIRST), listed);

  const visible = await page.evaluate(`document.body.innerText`);
  const leftover = visible.split("\n").filter((line) => simplified(line).length > 0);
  assert.deepEqual(leftover, []);
});

test("设置页：外观里的三个主题卡片一样高，单选圆点、色块和文字都对着卡片正中；English 和两列的窄宽度下也一样", async ({ open }) => {
  const page = await freshOptions(open);
  await enable(page);
  const layout = `[...document.querySelectorAll(".theme-option")].map((card) => {
    const box = card.getBoundingClientRect();
    const offset = (node) => { const r = node.getBoundingClientRect(); return Math.abs(r.top + r.height / 2 - (box.top + box.height / 2)); };
    return { height: Math.round(box.height), offset: Math.max(offset(card.querySelector("input")), offset(card.querySelector(".theme-swatch")), offset(card.querySelector(".theme-text"))) };
  })`;
  for (const language of ["zh", "en"]) {
    await fill(page, "#language", language);
    await page.waitFor("界面换了语言", `document.documentElement.lang.startsWith(${JSON.stringify(language)})`);
    for (const width of [WIDTH, 600]) {
      await page.setWidth(width);
      const cards = await page.evaluate(layout);
      assert.equal(cards.length, 3);
      assert.equal(new Set(cards.map((card) => card.height)).size, 1, `${language} ${width}：${JSON.stringify(cards)}`);
      for (const card of cards) assert.ok(card.offset <= 1, `${language} ${width}：${JSON.stringify(cards)}`);
    }
  }
});

test("设置页：English 下数据说明的条目、勾选框和校验提示都是英文，打开就出结论列出的说明也是英文；整页可见文字里没有汉字，语言下拉里的「简体中文」「繁體中文」除外", async ({ open }) => {
  const page = await freshOptions(open);
  await enable(page);
  await fill(page, "#language", "en");
  await page.waitFor("界面换成英文", `document.documentElement.lang === "en"`);
  const han = /[㐀-鿿！-～「」、。]/;

  // 数据说明：标题、条目和勾选框。
  const consent = await page.evaluate(`document.getElementById("dataConsentBox").innerText`);
  assert.doesNotMatch(consent, han, consent);
  assert.ok(consent.includes(DATA_CONSENT_EN_FIRST), consent);
  assert.ok(consent.includes(OPTIONS_EN.consent.agree), consent);

  // 校验提示：地址不对时保存不了，没同意时存好了也说还差同意。
  await fill(page, "#preset", "custom");
  await page.waitFor("出现地址框", `document.getElementById("aiBaseUrl") !== null`);
  await fill(page, "#aiBaseUrl", "http://service.example/v1");
  await clickButton(page, "Save and authorise");
  assert.equal(await statusStarts(page, "ai-service", "The API address"), "The API address must start with https://. Only local addresses (localhost, 127.0.0.1) can use http://.");
  await fill(page, "#preset", ANTHROPIC.presetId);
  await fill(page, "#aiApiKey", ANTHROPIC.key);
  await clickButton(page, "Save and authorise");
  const notReady = await statusStarts(page, "ai-service", "Saved and authorised, but");
  assert.ok(notReady.includes(dataConsentErrorText("en")), notReady);

  // 打开就出结论：没同意时勾开关，就地列出的说明是英文。
  await page.click("#autoOverview");
  await page.waitFor("列出数据说明", `document.querySelector("#auto-overview .consent-lines") !== null`);
  const listed = await page.evaluate(`document.querySelector("#auto-overview .consent-lines").innerText`);
  assert.doesNotMatch(listed, han, listed);
  assert.ok(listed.includes(DATA_CONSENT_EN_FIRST), listed);

  // 整页：语言下拉里「简体中文」「繁體中文」两项用自己的语言写，别处不该有汉字。
  const visible = await page.evaluate(`document.body.innerText`);
  const leftover = visible.replaceAll("简体中文", "").replaceAll("繁體中文", "").split("\n").filter((line) => han.test(line));
  assert.deepEqual(leftover, []);
});

// 只看几何关系，不看字体：2 倍及以上的屏上框高是整像素时，文字行上下留的空也是整像素，文字才跟边框一起对齐到像素；
// 别的情况行高照旧。页面测试的浏览器是 1 倍屏，在那里核对的是行高没变。
test("设置页：三档字号下输入框和下拉框都是 2rem 高；2 倍屏上 2rem 是整像素时文字行上下留的空是整像素，别的情况行高照旧", async ({ open }) => {
  const page = await freshOptions(open);
  await enable(page);
  const problems = [];
  for (const uiFontScale of UI_FONT_SCALES) {
    await page.setAppearance({ accentTheme: "ink", themeMode: "light", uiFontScale });
    const boxes = await page.evaluate(`(() => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      const rounds = CSS.supports("line-height", "round(1px, 1px)") && CSS.supports("line-height", "rem(1px, 1px)") && matchMedia("(min-resolution: 2dppx)").matches;
      return [...document.querySelectorAll("select.input, input.input")].filter((node) => node.getClientRects().length > 0 && !node.closest("details:not([open])")).map((node) => {
        const style = getComputedStyle(node);
        const height = node.getBoundingClientRect().height;
        const inner = height - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth);
        const lineHeight = parseFloat(style.lineHeight);
        return { id: node.id, height, rem, rounds, lineHeight, snug: parseFloat(style.fontSize) * 1.5, gap: (inner - lineHeight) / 2 };
      });
    })()`);
    assert.ok(boxes.length >= 10, `${uiFontScale}%：只找到 ${boxes.length} 个输入框和下拉框`);
    for (const box of boxes) {
      const label = `${uiFontScale}% ${JSON.stringify(box)}`;
      // 布局按 1/64 像素取整，留一点余量。
      if (Math.abs(box.height - 2 * box.rem) > 0.02) problems.push(`${label}：高度不是 2rem`);
      const snaps = box.rounds && Math.abs(2 * box.rem - Math.round(2 * box.rem)) < 0.001;
      if (snaps && Math.abs(box.gap - Math.round(box.gap)) > 0.02) problems.push(`${label}：文字行上下留的空不是整像素`);
      if (!snaps && Math.abs(box.lineHeight - box.snug) > 0.02) problems.push(`${label}：行高变了`);
    }
  }
  assert.deepEqual(problems, []);
});

test("设置页：推理强度新安装全关；每项功能单独选，改了不用点保存就存下，实际档位和选的不一样时旁边标出，重新打开照旧；概览分块也是改了就存", async ({ open }) => {
  const page = await freshOptions(open);
  await enable(page);
  const efforts = () => page.evaluate(`Object.fromEntries([...document.querySelectorAll("[data-effort]")].map((node) => [node.dataset.effort, node.value]))`);
  const noteOf = (feature) => page.evaluate(`document.querySelector('[data-effort-note="${feature}"]')?.textContent ?? ""`);
  const initial = await efforts();
  assert.deepEqual(Object.keys(initial), FEATURE_MODEL_SLOTS.map(({ id }) => id), "每项用到模型的功能一行");
  assert.ok(Object.values(initial).every((value) => value === "off"), JSON.stringify(initial));
  assert.match(await page.evaluate(`document.getElementById("featureEfforts").textContent`), /越贵也越慢/);
  // 推理强度和概览分块不归「保存并授权」管，排在那个按钮后面。
  const afterSave = await page.evaluate(`(() => {
    const save = [...document.querySelectorAll("#ai-service button")].find((node) => node.textContent.trim() === "保存并授权");
    const follows = (id) => Boolean(save.compareDocumentPosition(document.getElementById(id)) & Node.DOCUMENT_POSITION_FOLLOWING);
    return [follows("featureEfforts"), follows("analysisChunkMode"), follows("dataConsent")];
  })()`);
  assert.deepEqual(afterSave, [true, true, false]);

  await fill(page, "#preset", ANTHROPIC.presetId);
  await fill(page, "#aiApiKey", ANTHROPIC.key);
  await fill(page, "#aiModel", "claude-sonnet-5-5");
  await page.evaluate(`document.querySelector("#featureModels").open = true`);
  await fill(page, '[data-feature="notes"]', "claude-haiku-4-5");
  await page.waitFor("改了模型还没保存时先不标", `document.getElementById("featureEfforts").textContent.includes("保存以后再标")`);
  await clickButton(page, "保存并授权");
  await statusStarts(page, "ai-service", "已保存");

  // 连着改两项，都不点「保存并授权」：改了就存下，后改的不把先改的盖掉。
  await fill(page, '[data-effort="qa"]', "high");
  await fill(page, '[data-effort="notes"]', "high");
  const stored = (field) => `chrome.storage.local.get(${JSON.stringify(SETTINGS_STORAGE_KEY)}).then((items) => items[${JSON.stringify(SETTINGS_STORAGE_KEY)}].${field})`;
  await page.waitFor("档位不用点保存就存下", `${stored("featureEfforts")}.then((efforts) => efforts.qa === "high" && efforts.notes === "high")`);
  assert.deepEqual(await page.evaluate(stored("featureEfforts")), { ...initial, qa: "high", notes: "high" });
  await page.waitFor("笔记润色标出实际档位", `document.querySelector('[data-effort-note="notes"]') !== null`);
  assert.equal(await noteOf("notes"), "这个模型调不了推理强度，实际按「关」");
  assert.equal(await noteOf("qa"), "", "做得到的档位不标");
  assert.match(await page.evaluate(`document.getElementById("featureEfforts").textContent`), /改了马上生效/);

  await fill(page, "#analysisChunkMode", "short");
  await page.waitFor("概览分块不用点保存就存下", `${stored("analysisChunkMode")}.then((mode) => mode === "short")`);

  const reopened = await open(PAGE_PATHS.options, { width: WIDTH });
  await reopened.waitFor(
    "重新打开后档位和分块填回来、照样标出",
    `document.querySelector('[data-effort="qa"]')?.value === "high" && document.querySelector('[data-effort-note="notes"]') !== null && document.querySelector("#analysisChunkMode")?.value === "short"`,
  );
  assert.equal(await reopened.overflowsX(), false);
});
