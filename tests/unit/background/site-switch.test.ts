// 要用户另外授权的站（YouTube）：授权在就注册内容脚本，不在就注销；安装、更新后重新注册；新授权往已开页面补注入，
// 撤权通知发过消息的页面撤下；撤了权，那个站上残留的内容脚本发来的请求不放行。授权本身就是启用。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../src/background/app.ts";
import { videoKey } from "../../../src/core/video-ref.ts";
import { SETTINGS_STORAGE_KEY } from "../../../src/shared/names.ts";
import { CONFIRMED, createFakeChrome, senders, TUBE_ORIGIN, tubeUrl, type FakeChromeOptions } from "../../helpers/chrome.ts";

const ORIGIN = `${TUBE_ORIGIN}/*`;
const SCRIPT_ID = "jianmu-youtube";
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
  assert.deepEqual([...granted.fake.registered.entries()], [[SCRIPT_ID, { matches: [ORIGIN], js: ["content/youtube.js"] }]]);

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
  assert.deepEqual(actions(fake), [`register ${SCRIPT_ID}`, `unregister ${SCRIPT_ID}`, `register ${SCRIPT_ID}`]);
  await app.onStartup();
  assert.equal(actions(fake).length, 3, "注册还在，浏览器启动时不动");
  fake.registered.clear();
  await app.onStartup();
  assert.deepEqual(actions(fake).at(-1), `register ${SCRIPT_ID}`);
});

test("新给了授权：注册，并往已开的页面补注入一次；确认启用之前只注册、不查标签页", async () => {
  const { fake, app } = appOn({ urlTabs: { [TUBE_TAB]: tubeUrl() } });
  await app.onInstalled("install");
  fake.grant(ORIGIN);
  await app.onPermissionsChanged();
  assert.ok(fake.registered.has(SCRIPT_ID));
  assert.deepEqual(
    fake.calls.injections.map(({ value }) => value),
    [{ tabId: TUBE_TAB, files: ["content/youtube.js"] }],
  );

  const before = appOn({ local: {}, urlTabs: { [TUBE_TAB]: tubeUrl() } });
  before.fake.grant(ORIGIN);
  await before.app.onPermissionsChanged();
  assert.ok(before.fake.registered.has(SCRIPT_ID));
  assert.deepEqual(before.fake.calls.tabQueries, []);
  assert.deepEqual(before.fake.calls.injections, []);
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
});
