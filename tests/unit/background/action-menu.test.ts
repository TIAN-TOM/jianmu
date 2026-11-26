// 工具栏图标的右键菜单：走真实的后台装配和设置仓库，浏览器接口是替身。建菜单时三项和初始勾选；粗筛项打开粗筛页；
// 卡片开关经设置仓库改、存储变化再广播给视频页；打开就出结论同意齐全时才打开，否则勾退回、打开设置页并滚到那一节；
// 没确认启用时两个开关都不改设置；设置在别处变了勾选跟着变；重复建不报错。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../src/background/app.ts";
import { ACTION_MENU, PAGE_PATHS, SETTINGS_STORAGE_KEY } from "../../../src/shared/names.ts";
import { DATA_CONSENT_CONFIRMED } from "../../../src/shared/settings-schema.ts";
import { CONFIRMED, createFakeChrome, extensionUrl, senders, watchUrl } from "../../helpers/chrome.ts";
import { stillFalse, until } from "../../helpers/wait-until.ts";

const TEMPLATE_SCRIPTS = [{ matches: ["https://watch.example/watch/*"], js: ["content/bilibili.js"] }];
const OPTIONS_PAGE = "pages/options.html";
/** 打开就出结论改不成时打开的设置页：地址带着那一节的节名。 */
const AUTO_SECTION_URL = `${extensionUrl(OPTIONS_PAGE)}#auto-overview`;
// 同一个版本号、旧指纹：同意过，后来说明有更新，要重新同意。
const STALE_CONSENT = { dataConsentVersion: DATA_CONSENT_CONFIRMED.dataConsentVersion, dataConsentFingerprint: "0000000000000000" };

function setup(settings: Record<string, unknown> | undefined) {
  const errors: string[] = [];
  const fake = createFakeChrome({
    ...(settings ? { local: { [SETTINGS_STORAGE_KEY]: settings } } : {}),
    manifest: { content_scripts: TEMPLATE_SCRIPTS, options_ui: { page: OPTIONS_PAGE } },
    urlTabs: { 7: watchUrl() },
  });
  const app = createApp(fake.deps({ warn() {}, error: (message: string) => void errors.push(message) }));
  // 照入口的写法接上点击：浏览器把事件交给后台。
  fake.chrome.contextMenus.onClicked.addListener(((info: never) => void app.onMenuClicked(info)) as never);
  const stored = () => fake.local.data[SETTINGS_STORAGE_KEY] as Record<string, unknown> | undefined;
  const checked = (id: string) => fake.menuItems.get(id)?.checked;
  // 存储变化照浏览器的做法另起一轮派发，交给后台的存储监听。
  fake.chrome.storage.onChanged.addListener(((changes: never, area: never) => void app.onStorageChanged(changes, area)) as never);
  return { fake, app, errors, stored, checked };
}

const enabled = (extra: Record<string, unknown> = {}) => ({ ...CONFIRMED, ...DATA_CONSENT_CONFIRMED, ...extra });

test("安装时建三项，只放在工具栏图标的菜单里，勾选按当时的设置；读不到设置按没勾", async () => {
  const { fake, app, checked } = setup(enabled({ inPageCard: false, autoOverview: true }));
  await app.onInstalled("install");
  assert.deepEqual(
    [...fake.menuItems].map(([id, item]) => [id, item.title, item.type, item.contexts]),
    [
      [ACTION_MENU.triage, "稍后再看粗筛", "normal", ["action"]],
      [ACTION_MENU.inPageCard, "在视频右侧显示总结卡片", "checkbox", ["action"]],
      [ACTION_MENU.autoOverview, "打开视频就出结论（花 API 额度）", "checkbox", ["action"]],
    ],
  );
  for (const id of Object.values(ACTION_MENU)) assert.match(id, /^jianmu-/);
  assert.equal(checked(ACTION_MENU.inPageCard), false);
  assert.equal(checked(ACTION_MENU.autoOverview), true);

  const broken = setup(enabled());
  const deps = broken.fake.deps({ warn() {}, error() {} });
  const failing = createApp({ ...deps, storage: { ...deps.storage, local: { ...deps.storage.local, get: () => Promise.reject(new Error("读不出来")) } } });
  await failing.onStartup();
  assert.equal(broken.checked(ACTION_MENU.inPageCard), false);
  assert.equal(broken.checked(ACTION_MENU.autoOverview), false);
});

test("安装、更新、浏览器启动各建一次也不报错，菜单项不重复", async () => {
  const { fake, app, errors } = setup(enabled());
  await app.onInstalled("install");
  await app.onStartup();
  await app.onInstalled("update");
  await app.onInstalled("chrome_update");
  assert.equal(fake.menuItems.size, 3);
  assert.deepEqual(errors, []);
  // 卡片默认开着。
  assert.equal(fake.menuItems.get(ACTION_MENU.inPageCard)?.checked, true);
});

test("安装和浏览器启动接连来、不等前一次建完，也不撞同名标识", async () => {
  const { fake, app, errors } = setup(enabled());
  await Promise.all([app.onInstalled("install"), app.onStartup(), app.onInstalled("update")]);
  assert.equal(fake.menuItems.size, 3);
  assert.deepEqual(errors, []);
});

test("点粗筛项在新标签页打开粗筛页，没确认启用时也一样，不改设置", async () => {
  for (const settings of [enabled(), undefined]) {
    const { fake, app, stored } = setup(settings);
    await app.onInstalled("install");
    const before = structuredClone(stored());
    fake.fireMenuClicked(ACTION_MENU.triage);
    assert.ok(await until(() => fake.calls.tabsCreated.length === 1));
    assert.deepEqual(fake.calls.tabsCreated, [extensionUrl(PAGE_PATHS.triage)]);
    assert.equal(fake.calls.optionsOpened, 0);
    assert.deepEqual(stored(), before);
  }
});

test("卡片开关经设置仓库关上再打开，存储变化把开关广播给视频页", async () => {
  const { fake, app, stored, checked } = setup(enabled({ aiModel: "test-model", accentTheme: "redblack" }));
  await app.onInstalled("install");
  const broadcasts = () => fake.calls.tabMessages.filter(({ message }) => (message as { type?: string }).type === "appearance.changed");

  fake.fireMenuClicked(ACTION_MENU.inPageCard);
  assert.ok(await until(() => stored()?.["inPageCard"] === false));
  assert.ok(await until(() => broadcasts().length === 1));
  assert.deepEqual(broadcasts()[0], { tabId: 7, message: { type: "appearance.changed", accentTheme: "redblack", inPageCard: false, language: "auto" } });
  assert.equal(checked(ACTION_MENU.inPageCard), false);
  // 只改这一项，别的设置原样。
  assert.equal(stored()?.["aiModel"], "test-model");
  assert.equal(stored()?.["autoOverview"], false);

  fake.fireMenuClicked(ACTION_MENU.inPageCard);
  assert.ok(await until(() => stored()?.["inPageCard"] === true));
  assert.ok(await until(() => broadcasts().length === 2));
  assert.deepEqual(broadcasts()[1]?.message, { type: "appearance.changed", accentTheme: "redblack", inPageCard: true, language: "auto" });
  assert.equal(checked(ACTION_MENU.inPageCard), true);
  assert.equal(fake.calls.optionsOpened, 0);
});

test("打开就出结论：数据说明同意齐全时打开，关掉随时可以", async () => {
  const { fake, app, stored, checked } = setup(enabled());
  await app.onInstalled("install");
  fake.fireMenuClicked(ACTION_MENU.autoOverview);
  assert.ok(await until(() => stored()?.["autoOverview"] === true));
  assert.equal(checked(ACTION_MENU.autoOverview), true);
  fake.fireMenuClicked(ACTION_MENU.autoOverview);
  assert.ok(await until(() => stored()?.["autoOverview"] === false));
  // 两次存储变化都处理完以后，勾和存着的设置一致。
  assert.ok(await until(() => checked(ACTION_MENU.autoOverview) === false));
  assert.ok(await stillFalse(() => checked(ACTION_MENU.autoOverview) !== false));
  assert.equal(fake.calls.optionsOpened, 0);
});

test("打开就出结论：没同意或说明有更新要重新同意时不打开，勾退回去，打开设置页并滚到打开就出结论那一节", async () => {
  for (const consent of [{}, STALE_CONSENT]) {
    const { fake, app, stored, checked } = setup({ ...CONFIRMED, ...consent });
    await app.onInstalled("install");
    const before = structuredClone(stored());
    fake.fireMenuClicked(ACTION_MENU.autoOverview);
    assert.ok(await until(() => fake.calls.tabsCreated.length === 1));
    assert.deepEqual(fake.calls.tabsCreated, [AUTO_SECTION_URL]);
    assert.equal(fake.calls.optionsOpened, 0, "不走只会停在顶上的打开方式");
    assert.equal(checked(ACTION_MENU.autoOverview), false);
    assert.deepEqual(stored(), before, "设置和同意都不动");
  }
  // 已经开着的（比如说明后来有更新）照样能关。
  const { fake, app, stored } = setup({ ...CONFIRMED, ...STALE_CONSENT, autoOverview: true });
  await app.onInstalled("install");
  fake.fireMenuClicked(ACTION_MENU.autoOverview);
  assert.ok(await until(() => stored()?.["autoOverview"] === false));
  assert.equal(fake.calls.optionsOpened, 0);
});

test("没确认启用时两个开关都不改设置，勾退回去，打开设置页；打开就出结论那一项带着节名", async () => {
  for (const settings of [undefined, { ...DATA_CONSENT_CONFIRMED, inPageCard: true }]) {
    const { fake, app, stored, checked } = setup(settings);
    await app.onInstalled("install");
    const before = structuredClone(stored());
    fake.fireMenuClicked(ACTION_MENU.inPageCard);
    assert.ok(await until(() => fake.calls.optionsOpened === 1));
    assert.equal(checked(ACTION_MENU.inPageCard), true);
    fake.fireMenuClicked(ACTION_MENU.autoOverview);
    assert.ok(await until(() => fake.calls.tabsCreated.length === 1));
    assert.deepEqual(fake.calls.tabsCreated, [AUTO_SECTION_URL]);
    assert.equal(checked(ACTION_MENU.autoOverview), false);
    assert.deepEqual(stored(), before);
    assert.deepEqual(fake.calls.tabMessages, []);
  }
});

test("设置在别处变了，菜单上的勾跟着变：设置页里改、清除全部数据", async () => {
  const { fake, app, checked } = setup(enabled({ inPageCard: false }));
  await app.onInstalled("install");
  assert.equal(checked(ACTION_MENU.inPageCard), false);

  // 设置页即改即存，在页面里经设置仓库直接写存储，后台只看到存储变化。
  const current = fake.local.data[SETTINGS_STORAGE_KEY] as Record<string, unknown>;
  await fake.local.set({ [SETTINGS_STORAGE_KEY]: { ...current, inPageCard: true, autoOverview: true } });
  assert.ok(await until(() => checked(ACTION_MENU.inPageCard) === true && checked(ACTION_MENU.autoOverview) === true));

  // 清除全部数据：设置回到默认，卡片默认开着，打开就出结论默认关着。
  await fake.local.set({ [SETTINGS_STORAGE_KEY]: { ...CONFIRMED, inPageCard: false, autoOverview: true } });
  assert.ok(await until(() => checked(ACTION_MENU.inPageCard) === false));
  const cleared = await app.dispatch({ type: "data.clear", req: { scope: "all" } }, senders.options());
  assert.equal((cleared as { ok?: boolean }).ok, true);
  assert.ok(await until(() => checked(ACTION_MENU.inPageCard) === true && checked(ACTION_MENU.autoOverview) === false));
});

test("别的扩展存储变化、会话存储变化不动菜单；菜单还没建时设置变了也不报错", async () => {
  const { fake, app, errors } = setup(enabled());
  await fake.local.set({ [SETTINGS_STORAGE_KEY]: enabled({ inPageCard: false }) });
  assert.ok(await stillFalse(() => errors.length > 0));
  assert.equal(fake.menuItems.size, 0);
  await app.onInstalled("install");
  await app.onStorageChanged({ [SETTINGS_STORAGE_KEY]: { oldValue: enabled(), newValue: enabled({ inPageCard: true }) } }, "session");
  assert.equal(fake.menuItems.get(ACTION_MENU.inPageCard)?.checked, false);
});

// 菜单的文字跟着语言设置：浏览器的界面语言另外给，替身默认没有，按中文。
function setupIn(settings: Record<string, unknown>, uiLanguage: string) {
  const fake = createFakeChrome({ local: { [SETTINGS_STORAGE_KEY]: settings }, manifest: { content_scripts: TEMPLATE_SCRIPTS }, urlTabs: { 7: watchUrl() } });
  const app = createApp({ ...fake.deps({ warn() {}, error() {} }), uiLanguage: () => uiLanguage });
  fake.chrome.storage.onChanged.addListener(((changes: never, area: never) => void app.onStorageChanged(changes, area)) as never);
  const titles = () => [...fake.menuItems.values()].map(({ title }) => title);
  return { fake, app, titles };
}

const ZH_TITLES = ["稍后再看粗筛", "在视频右侧显示总结卡片", "打开视频就出结论（花 API 额度）"];
const HANT_TITLES = ["稍後再看粗篩", "在影片右側顯示總結卡片", "打開影片就出結論（花 API 額度）"];

test("菜单的文字：选英文就是英文，选繁体或跟随繁体的浏览器是繁体，跟随浏览器时看浏览器的界面语言，没给界面语言按中文", async () => {
  for (const [language, uiLanguage, expected] of [["zh-Hant", "en-AU", HANT_TITLES], ["auto", "zh-TW", HANT_TITLES], ["auto", "zh-HK", HANT_TITLES]] as const) {
    const { app, titles } = setupIn(enabled({ language }), uiLanguage);
    await app.onInstalled("install");
    assert.deepEqual(titles(), expected, `${language}/${uiLanguage}`);
  }
  for (const [language, uiLanguage, english] of [["en", "zh-CN", true], ["zh", "en-AU", false], ["auto", "en-AU", true], ["auto", "zh-CN", false]] as const) {
    const { app, titles } = setupIn(enabled({ language }), uiLanguage);
    await app.onInstalled("install");
    const shown = titles();
    assert.equal(shown.length, 3);
    if (english) {
      assert.deepEqual(shown, ["Watch Later triage", "Show summary card beside video", "Verdict on open (uses API credit)"]);
      for (const title of shown) assert.doesNotMatch(title, /[\u4e00-\u9fff]/, `${language}/${uiLanguage}`);
      // 浏览器会截断过长的菜单项，最长的一项还决定整个菜单的宽度。
      for (const title of shown) assert.ok(title.length <= 60, `菜单项太长：${title}`);
    } else {
      assert.deepEqual(shown, ZH_TITLES, `${language}/${uiLanguage}`);
    }
  }
  const { app, fake } = setup(enabled({ language: "auto" }));
  await app.onInstalled("install");
  assert.deepEqual([...fake.menuItems.values()].map(({ title }) => title), ZH_TITLES);
});

test("设置里的语言改了，菜单按新语言重建，勾选照旧；别的设置变了不重建", async () => {
  const { fake, app, titles } = setupIn(enabled({ language: "zh", inPageCard: false, autoOverview: true }), "zh-CN");
  await app.onInstalled("install");
  assert.deepEqual(titles(), ZH_TITLES);
  const current = () => fake.local.data[SETTINGS_STORAGE_KEY] as Record<string, unknown>;
  await fake.local.set({ [SETTINGS_STORAGE_KEY]: { ...current(), language: "en" } });
  // 重建是先清掉再逐项建，等三项都建好。
  assert.ok(await until(() => titles().length === 3 && titles()[2]?.startsWith("Verdict on open") === true));
  assert.equal(titles()[0], "Watch Later triage");
  assert.equal(fake.menuItems.get(ACTION_MENU.inPageCard)?.checked, false);
  assert.equal(fake.menuItems.get(ACTION_MENU.autoOverview)?.checked, true);

  await fake.local.set({ [SETTINGS_STORAGE_KEY]: { ...current(), language: "auto" } });
  assert.ok(await until(() => titles().length === 3 && titles()[2] === ZH_TITLES[2]), "跟随浏览器，浏览器是中文");
  await fake.local.set({ [SETTINGS_STORAGE_KEY]: { ...current(), inPageCard: true } });
  assert.ok(await until(() => fake.menuItems.get(ACTION_MENU.inPageCard)?.checked === true));
  assert.deepEqual(titles(), ZH_TITLES);
});
