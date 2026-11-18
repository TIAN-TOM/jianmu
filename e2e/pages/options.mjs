// 设置页：确认启用之前只有启用说明和资料一节；确认以后能保存服务商、密钥和模型，拉模型列表、测试连接对着模拟的模型服务走通，
// 密钥只进会话存储；本机 http 地址不填密钥也能保存、拉列表和测试连接；导出的备份清除全部数据后能再导回来，
// 超过单条消息上限的备份也一样。各测试开头先清除全部数据，从没启用的状态开始。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { videoKey } from "../../src/core/video-ref.ts";
import { API_KEY_SESSION_KEY, PAGE_PATHS, SETTINGS_STORAGE_KEY } from "../../src/shared/names.ts";
import { FEATURE_MODEL_SLOTS } from "../../src/shared/settings-schema.ts";
import { ANTHROPIC, VIDEOS } from "../fixtures.mjs";
import { scenario } from "./harness.mjs";

const test = scenario(import.meta.url);
const WIDTH = 900;
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

const statusOf = (page, section) => page.evaluate(`document.querySelector("#${section} .status")?.textContent ?? ""`);

/** 等某一节的状态行以这段文字开头；等不到时把当时的状态行写进报错。 */
async function statusStarts(page, section, prefix, timeoutMs = undefined) {
  try {
    await page.waitFor(`状态行出现「${prefix}」`, `(document.querySelector("#${section} .status")?.textContent ?? "").startsWith(${JSON.stringify(prefix)})`, timeoutMs);
  } catch (error) {
    throw new Error(`${error.message}；状态行是「${await statusOf(page, section)}」`);
  }
  return statusOf(page, section);
}

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
  assert.deepEqual(before.sections, ["学习资料"]);
  assert.deepEqual(before.buttons, ["导出备份", "清除缓存", "清除全部数据"], "确认前不能恢复备份");
  await enable(page);
  const after = await page.evaluate(`[...document.querySelectorAll(".card > h2")].map((node) => node.textContent)`);
  assert.deepEqual(after, ["外观", "播放页", "YouTube", "AI 服务", "打开就出结论", "速览和精读", "稍后再看粗筛", "学习资料"]);
  // 测试构建里 YouTube 开关打开；没给过授权，这一节只有启用按钮。
  await page.waitFor("YouTube 的启用按钮", `[...document.querySelectorAll("#youtube button")].map((node) => node.textContent.trim()).join() === "在 YouTube 上启用"`);
  assert.equal(await page.overflowsX(), false);
});

test("设置页：选服务商、填密钥、勾同意后保存，拉模型列表和测试连接对着模拟服务走通，密钥只进会话", async ({ open }) => {
  const page = await freshOptions(open);
  await enable(page);
  await fill(page, "#preset", ANTHROPIC.presetId);
  await fill(page, "#aiApiKey", ANTHROPIC.key);
  await page.click("#dataConsent");
  await page.waitFor("同意记下了", `document.getElementById("dataConsent").checked`);

  await clickButton(page, "拉取模型列表");
  assert.equal(await statusStarts(page, "ai-service", "拉到"), "拉到 1 个模型，可以在模型框里直接选。");
  const listed = await page.evaluate(`[...document.querySelectorAll("#model-options option")].map((node) => node.value)`);
  assert.deepEqual(listed, [ANTHROPIC.model]);
  await fill(page, "#aiModel", ANTHROPIC.model);

  await clickButton(page, "保存并授权");
  assert.equal(await statusStarts(page, "ai-service", "已保存"), "已保存并授权。");
  await clickButton(page, "测试连接");
  assert.equal(await statusStarts(page, "ai-service", "默认模型"), `默认模型（${ANTHROPIC.model}）连接正常，回复「可用」`);

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
});

/** 本机的 OpenAI 兼容服务，只开 http、不要密钥。记下每个请求的地址和认证头。 */
async function startLocalService() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? "", authorization: req.headers.authorization ?? null, apiKey: req.headers["x-api-key"] ?? null });
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      if (req.url?.endsWith("/models")) res.end(JSON.stringify({ object: "list", data: [{ id: "local-model", object: "model" }] }));
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
    assert.equal(await statusStarts(page, "ai-service", "拉到"), "拉到 1 个模型，可以在模型框里直接选。");
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

test("设置页：打开就出结论默认关；没同意时勾开关先列出说明，同意并打开后才开；关掉、改时长不用同意", async ({ open }) => {
  const page = await freshOptions(open);
  await enable(page);
  const stored = () => page.evaluate(`chrome.storage.local.get(${JSON.stringify(SETTINGS_STORAGE_KEY)}).then((items) => items[${JSON.stringify(SETTINGS_STORAGE_KEY)}] ?? {})`);
  assert.equal(await page.evaluate(`document.getElementById("autoOverview").checked`), false);
  assert.equal(await page.evaluate(`document.getElementById("autoOverviewMinutes").value`), "10");

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

  await fill(page, "#autoOverviewMinutes", "25");
  await page.waitFor("时长存下", `chrome.storage.local.get(${JSON.stringify(SETTINGS_STORAGE_KEY)}).then((items) => items[${JSON.stringify(SETTINGS_STORAGE_KEY)}]?.autoOverviewMinutes === 25)`);
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

test("设置页：推理强度新安装全关；每项功能单独选，实际档位和选的不一样时旁边标出，保存后重新打开照旧", async ({ open }) => {
  const page = await freshOptions(open);
  await enable(page);
  const efforts = () => page.evaluate(`Object.fromEntries([...document.querySelectorAll("[data-effort]")].map((node) => [node.dataset.effort, node.value]))`);
  const noteOf = (feature) => page.evaluate(`document.querySelector('[data-effort-note="${feature}"]')?.textContent ?? ""`);
  const initial = await efforts();
  assert.deepEqual(Object.keys(initial), FEATURE_MODEL_SLOTS.map(({ id }) => id), "每项用到模型的功能一行");
  assert.ok(Object.values(initial).every((value) => value === "off"), JSON.stringify(initial));
  assert.match(await page.evaluate(`document.getElementById("featureEfforts").textContent`), /越贵也越慢/);

  await fill(page, "#preset", ANTHROPIC.presetId);
  await fill(page, "#aiApiKey", ANTHROPIC.key);
  await fill(page, "#aiModel", "claude-sonnet-5-5");
  await page.evaluate(`document.querySelector("#featureModels").open = true`);
  await fill(page, '[data-feature="notes"]', "claude-haiku-4-5");
  await page.waitFor("改了模型还没保存时先不标", `document.getElementById("featureEfforts").textContent.includes("保存以后再标")`);
  await clickButton(page, "保存并授权");
  await statusStarts(page, "ai-service", "已保存");

  await fill(page, '[data-effort="qa"]', "high");
  await fill(page, '[data-effort="notes"]', "high");
  await page.waitFor("笔记润色标出实际档位", `document.querySelector('[data-effort-note="notes"]') !== null`);
  assert.equal(await noteOf("notes"), "这个模型调不了推理强度，实际按「关」");
  assert.equal(await noteOf("qa"), "", "做得到的档位不标");
  await clickButton(page, "保存并授权");
  // 状态行还是上一次保存的那句，直接等存储。
  const storedEfforts = `chrome.storage.local.get(${JSON.stringify(SETTINGS_STORAGE_KEY)}).then((items) => items[${JSON.stringify(SETTINGS_STORAGE_KEY)}].featureEfforts)`;
  await page.waitFor("档位存下", `${storedEfforts}.then((efforts) => efforts.qa === "high")`);
  assert.deepEqual(await page.evaluate(storedEfforts), { ...initial, qa: "high", notes: "high" });

  const reopened = await open(PAGE_PATHS.options, { width: WIDTH });
  await reopened.waitFor("重新打开后档位填回来、照样标出", `document.querySelector('[data-effort="qa"]')?.value === "high" && document.querySelector('[data-effort-note="notes"]') !== null`);
  assert.equal(await reopened.overflowsX(), false);
});
