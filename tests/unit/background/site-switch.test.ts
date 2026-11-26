// 要用户另外授权的站（YouTube）：授权在就注册内容脚本，不在就注销；安装、更新后重新注册；新授权往已开页面补注入，
// 撤权按编号通知全部已开标签页撤下（后台重启过、页面没出声也发得到）；撤了权，那个站上残留的内容脚本发来的请求不放行。授权本身就是启用。
// 主世界的小桥另外要首次启用确认算数才注册：确认前不注册，确认以后补上，清除全部数据以后撤掉。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../src/background/app.ts";
import { videoKey } from "../../../src/core/video-ref.ts";
import { SETTINGS_STORAGE_KEY } from "../../../src/shared/names.ts";
import { CONFIRMED, createFakeChrome, senders, TUBE_ORIGIN, tubeUrl, type FakeChromeOptions } from "../../helpers/chrome.ts";
import { until } from "../../helpers/wait-until.ts";

const ORIGIN = `${TUBE_ORIGIN}/*`;
const SCRIPT_ID = "jianmu-youtube";
const BRIDGE_ID = "jianmu-youtube-bridge";
const TUBE_TAB = 71;

function appOn(options: FakeChromeOptions = {}) {
  const fake = createFakeChrome({ local: { [SETTINGS_STORAGE_KEY]: CONFIRMED }, manifest: {}, ...options });
  const errors: string[] = [];
  const app = createApp(fake.deps({ warn() {}, error: (message: string) => void errors.push(message) }));
  return { fake, app, errors };
}

const actions = (fake: ReturnType<typeof appOn>["fake"]) => fake.calls.registrations.map(({ value }) => `${value.action} ${value.ids.join(",")}`);

test("安装时授权在就注册，脚本和匹配规则取自站点规则，浏览器重启后也在；没授权就不注册", async () => {
  const granted = appOn({ grantedOrigins: [ORIGIN] });
  await granted.app.onInstalled("install");
  assert.deepEqual(
    [...granted.fake.registered.entries()],
    [
      [SCRIPT_ID, { matches: [ORIGIN], js: ["content/youtube.js"] }],
      [BRIDGE_ID, { matches: [ORIGIN], js: ["content/youtube-bridge.js"], world: "MAIN", runAt: "document_start" }],
    ],
  );

  const none = appOn();
  await none.app.onInstalled("install");
  await none.app.onStartup();
  assert.equal(none.fake.registered.size, 0);
  assert.deepEqual(none.errors, []);
});

test("更新后先撤再注册；浏览器启动时注册还在就不动，没了就补上", async () => {
  const { fake, app } = appOn({ grantedOrigins: [ORIGIN] });
  await app.onInstalled("install");
  await app.onInstalled("update");
  assert.deepEqual(actions(fake), [`register ${SCRIPT_ID}`, `register ${BRIDGE_ID}`, `unregister ${SCRIPT_ID},${BRIDGE_ID}`, `register ${SCRIPT_ID}`, `register ${BRIDGE_ID}`]);
  await app.onStartup();
  assert.equal(actions(fake).length, 5, "注册还在，浏览器启动时不动");
  fake.registered.delete(BRIDGE_ID);
  await app.onStartup();
  assert.deepEqual(actions(fake).slice(5), [`register ${BRIDGE_ID}`], "少了哪份补哪份");
  fake.registered.clear();
  await app.onStartup();
  assert.deepEqual(actions(fake).slice(6), [`register ${SCRIPT_ID}`, `register ${BRIDGE_ID}`]);
});

test("新给了授权：注册，并往已开的页面补注入一次；确认启用之前只注册、不查标签页", async () => {
  const { fake, app } = appOn({ urlTabs: { [TUBE_TAB]: tubeUrl() } });
  await app.onInstalled("install");
  fake.grant(ORIGIN);
  await app.onPermissionsChanged();
  assert.ok(fake.registered.has(SCRIPT_ID));
  assert.deepEqual(
    fake.calls.injections.map(({ value }) => value),
    [
      { tabId: TUBE_TAB, files: ["content/youtube.js"] },
      { tabId: TUBE_TAB, files: ["content/youtube-bridge.js"], world: "MAIN" },
    ],
  );

  const before = appOn({ local: {}, urlTabs: { [TUBE_TAB]: tubeUrl() } });
  before.fake.grant(ORIGIN);
  await before.app.onPermissionsChanged();
  assert.ok(before.fake.registered.has(SCRIPT_ID));
  assert.ok(!before.fake.registered.has(BRIDGE_ID), "确认启用之前不注册小桥");
  assert.deepEqual(before.fake.calls.tabQueries, []);
  assert.deepEqual(before.fake.calls.injections, []);
});

test("小桥要启用确认算数才注册：确认前只注册内容脚本，确认以后补上，清除全部数据以后撤掉、内容脚本留着", async () => {
  const { fake, app, errors } = appOn({ local: {}, grantedOrigins: [ORIGIN] });
  await app.onInstalled("install");
  await app.onStartup();
  assert.deepEqual([...fake.registered.keys()], [SCRIPT_ID]);

  assert.equal((await app.dispatch({ type: "activation.confirm", req: {} }, senders.panel())).ok, true);
  assert.deepEqual([...fake.registered.keys()].sort(), [SCRIPT_ID, BRIDGE_ID]);

  assert.equal((await app.dispatch({ type: "data.clear", req: { scope: "all" } }, senders.options())).ok, true);
  await app.onStorageChanged({ [SETTINGS_STORAGE_KEY]: { oldValue: CONFIRMED, newValue: undefined } }, "local");
  assert.deepEqual([...fake.registered.keys()], [SCRIPT_ID]);
  // 浏览器重启或扩展更新时照样按启用确认来：没确认就不补上。
  await app.onStartup();
  assert.deepEqual([...fake.registered.keys()], [SCRIPT_ID], "浏览器重启");
  await app.onInstalled("update");
  assert.deepEqual([...fake.registered.keys()], [SCRIPT_ID], "扩展更新");
  assert.deepEqual(errors, []);
});

test("启用确认不经路由、直接写进存储变得算数：存储变化时也补上小桥；外观这类变化不动注册", async () => {
  const { fake, app } = appOn({ local: {}, grantedOrigins: [ORIGIN] });
  await app.onInstalled("install");
  assert.deepEqual([...fake.registered.keys()], [SCRIPT_ID]);
  fake.local.data[SETTINGS_STORAGE_KEY] = CONFIRMED;
  await app.onStorageChanged({ [SETTINGS_STORAGE_KEY]: { oldValue: undefined, newValue: CONFIRMED } }, "local");
  assert.deepEqual([...fake.registered.keys()].sort(), [SCRIPT_ID, BRIDGE_ID]);
  const before = fake.calls.registrations.length;
  await app.onStorageChanged({ [SETTINGS_STORAGE_KEY]: { oldValue: CONFIRMED, newValue: { ...CONFIRMED, accentTheme: "redblack" } } }, "local");
  assert.equal(fake.calls.registrations.length, before);
});

test("撤了授权：注销，并通知发过消息的页面撤下；别的授权变化不重复补注入", async () => {
  const { fake, app } = appOn({ grantedOrigins: [ORIGIN], urlTabs: { [TUBE_TAB]: tubeUrl() } });
  await app.onInstalled("install");
  // 页面发过一次消息，后台记下它的标签页。
  await app.dispatch({ type: "appearance.get", req: {} }, senders.content(tubeUrl(), TUBE_TAB));
  await app.onPermissionsChanged();
  const injections = fake.calls.injections.length;
  await app.onPermissionsChanged();
  assert.equal(fake.calls.injections.length, injections, "授权没变，不再补注入");

  fake.revoke(ORIGIN);
  await app.onPermissionsChanged();
  assert.equal(fake.registered.size, 0);
  assert.deepEqual(
    fake.calls.tabMessages.filter(({ message }) => (message as { type?: string }).type === "site.changed"),
    [{ tabId: TUBE_TAB, message: { type: "site.changed", platform: "youtube", enabled: false } }],
  );
});

test("撤了授权以后，那个站上残留的内容脚本发来的业务请求回没启用；授权在时照常", async () => {
  const video = videoKey({ platform: "youtube", videoId: "tube-sample" });
  const request = { type: "playback.info", req: { video, durationSec: 1200 } };
  const off = appOn();
  assert.deepEqual(await off.app.dispatch(request, senders.content(tubeUrl(), TUBE_TAB)), { ok: false, code: "NOT_ENABLED" });
  // 不在观看页的页面一样拦。
  assert.deepEqual(
    await off.app.dispatch({ type: "notes.saveAtTime", req: { video, atSec: 3 } }, senders.content(`${TUBE_ORIGIN}/feed`, TUBE_TAB)),
    { ok: false, code: "NOT_ENABLED" },
  );
  const on = appOn({ grantedOrigins: [ORIGIN] });
  assert.equal((await on.app.dispatch(request, senders.content(tubeUrl(), TUBE_TAB))).ok, true);
  // B 站的内容脚本不受影响。
  assert.equal((await off.app.dispatch({ type: "appearance.get", req: {} }, senders.content())).ok, true);
});

test("确认启用时的补注入带上授权了的站的脚本", async () => {
  const { fake, app } = appOn({ local: {}, grantedOrigins: [ORIGIN], urlTabs: { [TUBE_TAB]: tubeUrl() } });
  assert.equal((await app.dispatch({ type: "activation.confirm", req: {} }, senders.panel())).ok, true);
  assert.ok(fake.calls.injections.some(({ value }) => value.files.includes("content/youtube.js")));
  assert.ok(fake.calls.injections.some(({ value }) => value.files.includes("content/youtube-bridge.js") && value.world === "MAIN"));
});

test("后台被回收以后撤权：一直没出声的页面也按编号发出撤权通知，不按地址查", async () => {
  const { fake, app: earlier } = appOn({ grantedOrigins: [ORIGIN], openTabs: [TUBE_TAB, 5] });
  await earlier.onInstalled("install");
  fake.revoke(ORIGIN);
  const app = createApp(fake.deps({ warn() {}, error() {} }));
  const queriesBefore = fake.calls.tabQueries.length;
  await app.onPermissionsChanged();
  const revoked = JSON.stringify({ type: "site.changed", platform: "youtube", enabled: false });
  const notified = fake.calls.tabMessages.filter(({ message }) => JSON.stringify(message) === revoked).map(({ tabId }) => tabId);
  assert.deepEqual(notified.sort((a, b) => a - b), [5, TUBE_TAB]);
  const later = fake.calls.tabQueries.slice(queriesBefore).map(({ value }) => value as { url?: unknown });
  assert.ok(later.length > 0 && later.every((query) => query.url === undefined), "撤权以后只不带地址条件查");
});

test("后台被回收以后撤权：注销、通知扩展页面、删掉这个站的观看会话；残留页面一发消息就叫它撤下", async () => {
  const { fake, app: earlier } = appOn({ grantedOrigins: [ORIGIN] });
  await earlier.onInstalled("install");
  const video = videoKey({ platform: "youtube", videoId: "tube-sample" });
  assert.equal((await earlier.dispatch({ type: "playback.info", req: { video, durationSec: 1200 } }, senders.content(tubeUrl(), TUBE_TAB))).ok, true);
  assert.equal((await earlier.dispatch({ type: "playback.info", req: { video: videoKey({ platform: "bilibili", videoId: "BV1Sample001", segment: 1 }), durationSec: 1200 } }, senders.content())).ok, true);
  const sessionsBefore = Object.keys(fake.session.data["jianmu_watch_sessions"] as object).sort();
  assert.equal(sessionsBefore.length, 2);
  // 撤权把后台叫醒：新的后台内存里的名单是空的，注册由浏览器留着。
  fake.revoke(ORIGIN);
  const app = createApp(fake.deps({ warn() {}, error() {} }));
  await app.onPermissionsChanged();
  assert.equal(fake.registered.size, 0);
  assert.ok(fake.calls.broadcasts.some((message) => JSON.stringify(message) === JSON.stringify({ type: "site.changed", platform: "youtube", enabled: false })));
  assert.deepEqual(Object.keys(fake.session.data["jianmu_watch_sessions"] as object), sessionsBefore.filter((tab) => tab !== String(TUBE_TAB)));

  // 残留的内容脚本问启用状态：不放行，并叫它撤下。
  assert.deepEqual(await app.dispatch({ type: "activation.get", req: {} }, senders.content(tubeUrl(), TUBE_TAB)), { ok: false, code: "NOT_ENABLED" });
  assert.ok(await until(() => fake.calls.tabMessages.some(({ tabId, message }) => tabId === TUBE_TAB && (message as { type?: string }).type === "site.changed")));
  // 主机名末尾带点、带端口的写法一样认得是这个站。
  for (const url of [`${TUBE_ORIGIN}./v/tube-sample`, `${TUBE_ORIGIN}:8443/v/tube-sample`, "not a url"]) {
    assert.deepEqual(await app.dispatch({ type: "appearance.get", req: {} }, { ...senders.content(tubeUrl(), TUBE_TAB), url, tab: { id: TUBE_TAB, windowId: 3 } }), { ok: false, code: "NOT_ENABLED" }, url);
  }
});

test("后台刚醒、和 YouTube 无关的授权变化：注册还在就不补注入", async () => {
  const { fake, app } = appOn({ grantedOrigins: [ORIGIN], urlTabs: { [TUBE_TAB]: tubeUrl() } });
  fake.registered.set(SCRIPT_ID, { matches: [ORIGIN], js: ["content/youtube.js"] });
  fake.registered.set(BRIDGE_ID, { matches: [ORIGIN], js: ["content/youtube-bridge.js"], world: "MAIN" });
  await Promise.all([app.onPermissionsChanged(), app.onPermissionsChanged(), app.onPermissionsChanged()]);
  assert.deepEqual(fake.calls.injections, []);
  assert.deepEqual(fake.calls.registrations, []);
});

test("刚给就撤：同步排着做，最后没授权也没注册", async () => {
  const { fake, app } = appOn();
  fake.grant(ORIGIN);
  const first = app.onPermissionsChanged();
  fake.revoke(ORIGIN);
  await Promise.all([first, app.onPermissionsChanged()]);
  assert.equal(fake.registered.size, 0);
});
