// 扩展页面的外观：主题、明暗、字号落到根节点上，跟着设置变；清除全部数据后按默认值重写首帧缓存。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPageApi } from "../../../../src/pages/shared/api.ts";
import { applyAppearance, applyUiFontScale, pageAppearanceSources, resolveThemeMode, watchAppearance, type WatchAppearanceDeps } from "../../../../src/pages/shared/theme.ts";
import { APPEARANCE_CACHE_KEY, SETTINGS_STORAGE_KEY } from "../../../../src/shared/names.ts";
import { ACCENT_THEMES, THEME_MODES, UI_FONT_SCALES } from "../../../../src/shared/settings-schema.ts";
import { EXTENSION_ID } from "../../../helpers/chrome.ts";
import { deferred, nextTurn } from "../../../helpers/deferred.ts";
import { fakePage, memoryLocalStorage } from "../../../helpers/fake-page.ts";
import { fakeRuntime } from "../../../helpers/fake-runtime.ts";
import { memoryStorage } from "../../../helpers/memory-storage.ts";
import { until } from "../../../helpers/wait-until.ts";

type Listener = Parameters<NonNullable<WatchAppearanceDeps["onChanged"]>["addListener"]>[0];

/** 本机存储加它的变化事件；reads 是读了几次设置，clearedListeners 是订阅了清除广播的页面。 */
function fakeSource(stored?: unknown) {
  const local = memoryStorage(stored === undefined ? {} : { [SETTINGS_STORAGE_KEY]: stored });
  const listeners = new Set<Listener>();
  const clearedListeners = new Set<(scope: "cache" | "all") => void>();
  let reads = 0;
  const deps: WatchAppearanceDeps = {
    local: {
      get: (key) => {
        reads += 1;
        return local.get(key);
      },
    },
    onChanged: { addListener: (listener) => void listeners.add(listener), removeListener: (listener) => void listeners.delete(listener) },
    onDataCleared: (listener) => {
      clearedListeners.add(listener);
      return () => void clearedListeners.delete(listener);
    },
  };
  const emit = (changes: Record<string, { newValue?: unknown }>, area = "local"): void => {
    for (const listener of [...listeners]) listener(changes, area);
  };
  const broadcastCleared = (scope: "cache" | "all"): void => {
    for (const listener of [...clearedListeners]) listener(scope);
  };
  return { local, deps, emit, broadcastCleared, listeners, clearedListeners, reads: () => reads };
}

test("resolveThemeMode 把跟随系统解析成具体明暗（无浏览器环境按浅色）", () => {
  assert.equal(resolveThemeMode("light"), "light");
  assert.equal(resolveThemeMode("dark"), "dark");
  // Node 里没有 matchMedia，跟随系统回落为浅色
  assert.equal(resolveThemeMode("system"), "light");
  assert.equal(resolveThemeMode(), "light");
  // 有页面时按页面的系统明暗
  const dark = { matchMedia: (query: string) => ({ matches: query === "(prefers-color-scheme: dark)" }) };
  assert.equal(resolveThemeMode("system", dark), "dark");
  assert.equal(resolveThemeMode("light", dark), "light");
});

test("watchAppearance：先按存储落地外观，存储变了跟着变，别处的变化不理", async () => {
  const source = fakeSource({ accentTheme: "redblack", themeMode: "dark", uiFontScale: 118 });
  const localStorage = memoryLocalStorage();
  const { root } = fakePage({ localStorage });

  const watch = await watchAppearance(source.deps, root);
  assert.deepEqual(watch.current(), { accentTheme: "redblack", themeMode: "dark", uiFontScale: 112, language: "auto" });
  assert.equal(root.dataset.accentTheme, "redblack");
  assert.equal(root.dataset.themeMode, "dark");
  assert.equal(root.style.values["--ui-font-zoom"], "1.12");

  source.emit({ [SETTINGS_STORAGE_KEY]: { newValue: { accentTheme: "pinkblue", themeMode: "light" } } });
  assert.equal(root.dataset.accentTheme, "pinkblue", "设置页换了主题，页面立刻跟着换");
  assert.equal(root.dataset.themeMode, "light");
  assert.equal(root.style.values["--ui-font-zoom"], "1");
  assert.deepEqual(JSON.parse(localStorage.getItem(APPEARANCE_CACHE_KEY) ?? "null"), { accentTheme: "pinkblue", themeMode: "light", uiFontScale: 100, language: "auto" });

  source.emit({ [SETTINGS_STORAGE_KEY]: { newValue: { accentTheme: "marker" } } }, "sync");
  source.emit({ [SETTINGS_STORAGE_KEY]: { newValue: { accentTheme: "marker" } } }, "session");
  source.emit({ other_key: { newValue: {} } });
  assert.equal(root.dataset.accentTheme, "pinkblue", "别的存储区、别的键变了不理");

  // 没有变化事件的环境（比如测试替身）也不能抛
  const plain = fakePage().root;
  const quiet = await watchAppearance({ local: memoryStorage() }, plain);
  assert.equal(plain.dataset.accentTheme, "marker");
  assert.equal(quiet.current()?.themeMode, "system");
});

test("读设置的途中设置变了：以变化为准，不让读回来的旧值盖回去；读设置失败就留着首帧的样子", async () => {
  const source = fakeSource({ accentTheme: "redblack" });
  const gate = deferred();
  const { root } = fakePage();
  const slow = async (key: string) => {
    await gate.promise;
    return source.local.get(key);
  };
  const pending = watchAppearance({ ...source.deps, local: { get: slow } }, root);
  source.emit({ [SETTINGS_STORAGE_KEY]: { newValue: { accentTheme: "pinkblue" } } });
  gate.resolve();
  const watch = await pending;
  assert.equal(root.dataset.accentTheme, "pinkblue");
  assert.equal(watch.current()?.accentTheme, "pinkblue");

  const failing = fakePage().root;
  failing.dataset.accentTheme = "redblack";
  const broken = await watchAppearance({ local: { get: () => Promise.reject(new Error("读不到")) } }, failing);
  assert.equal(broken.current(), null);
  assert.equal(failing.dataset.accentTheme, "redblack", "首帧脚本写下的样子不动");

  // 首帧脚本也没写主题（比如没加载它）：写上默认主题，各套主题的版面规则都按这个属性写
  const bare = fakePage().root;
  await watchAppearance({ local: { get: () => Promise.reject(new Error("读不到")) } }, bare);
  assert.equal(bare.dataset.accentTheme, "marker");
});

test("收到清除全部数据：按清除后的设置（默认值）重写外观和首帧缓存；只清缓存时不动", async () => {
  const source = fakeSource({ accentTheme: "pinkblue", themeMode: "dark", uiFontScale: 125 });
  const localStorage = memoryLocalStorage();
  const { root } = fakePage({ localStorage });
  const watch = await watchAppearance(source.deps, root);
  assert.equal(JSON.parse(localStorage.getItem(APPEARANCE_CACHE_KEY) ?? "null").accentTheme, "pinkblue");

  source.broadcastCleared("cache");
  await nextTurn();
  assert.equal(source.reads(), 1, "只清缓存：外观设置还在，不重读");
  assert.equal(root.dataset.accentTheme, "pinkblue");

  await source.local.remove(SETTINGS_STORAGE_KEY);
  source.broadcastCleared("all");
  assert.ok(await until(() => root.dataset.accentTheme === "marker"));
  assert.equal(watch.current()?.accentTheme, "marker");
  assert.deepEqual({ ...root.dataset }, { accentTheme: "marker", themeMode: "light" });
  assert.equal(root.style.values["--ui-font-zoom"], "1");
  assert.deepEqual(JSON.parse(localStorage.getItem(APPEARANCE_CACHE_KEY) ?? "null"), { accentTheme: "marker", themeMode: "system", uiFontScale: 100, language: "auto" });

  // 清除以后读设置失败：照样按默认值重写
  const other = fakeSource({ accentTheme: "redblack" });
  const otherCache = memoryLocalStorage();
  const otherPage = fakePage({ localStorage: otherCache });
  let reads = 0;
  await watchAppearance(
    {
      ...other.deps,
      local: {
        get: (key) => {
          reads += 1;
          return reads === 1 ? other.local.get(key) : Promise.reject(new Error("读不到"));
        },
      },
    },
    otherPage.root,
  );
  other.broadcastCleared("all");
  assert.ok(await until(() => otherPage.root.dataset.accentTheme === "marker"));
  assert.equal(JSON.parse(otherCache.getItem(APPEARANCE_CACHE_KEY) ?? "null").accentTheme, "marker");
});

test("页面接上消息客户端：后台广播清除全部数据就按默认值重写外观；只清缓存、不是后台发的清除都不动；停止以后退订", async () => {
  const source = fakeSource({ accentTheme: "pinkblue", themeMode: "dark", uiFontScale: 125 });
  const runtime = fakeRuntime();
  const api = createPageApi({ runtime: runtime.runtime, sleep: async () => {}, reportError: (error) => assert.fail(String(error)) });
  const page = fakePage();
  const watch = await watchAppearance(pageAppearanceSources(api, { local: source.deps.local, onChanged: source.deps.onChanged }), page.root);
  assert.equal(page.root.dataset.accentTheme, "pinkblue");

  await source.local.remove(SETTINGS_STORAGE_KEY);
  runtime.broadcast({ type: "data.cleared", scope: "cache" });
  runtime.broadcast({ type: "data.cleared", scope: "all" }, { id: EXTENSION_ID, tab: { id: 3 } });
  await nextTurn();
  assert.equal(source.reads(), 1, "只清缓存、从网页标签页里来的都不重读");
  assert.equal(page.root.dataset.accentTheme, "pinkblue");

  runtime.broadcast({ type: "data.cleared", scope: "all" });
  assert.ok(await until(() => page.root.dataset.accentTheme === "marker"));
  assert.equal(watch.current()?.uiFontScale, 100);

  watch.stop();
  assert.equal(runtime.listeners(), 1, "客户端的监听由页面停客户端时撤");
  await source.local.set({ [SETTINGS_STORAGE_KEY]: { accentTheme: "redblack" } });
  runtime.broadcast({ type: "data.cleared", scope: "all" });
  await nextTurn();
  assert.equal(source.reads(), 2, "停止以后清除广播不再触发重读");
  api.stop();
  assert.equal(runtime.listeners(), 0);
});

test("跟随系统时系统明暗变了跟着换，选定明暗时不跟；停止以后什么都不再改", async () => {
  const source = fakeSource({ themeMode: "system" });
  const page = fakePage();
  const watch = await watchAppearance(source.deps, page.root);
  assert.equal(page.root.dataset.themeMode, "light");
  page.setPrefersDark(true);
  assert.equal(page.root.dataset.themeMode, "dark");

  source.emit({ [SETTINGS_STORAGE_KEY]: { newValue: { themeMode: "light" } } });
  page.setPrefersDark(false);
  page.setPrefersDark(true);
  assert.equal(page.root.dataset.themeMode, "light");

  watch.stop();
  assert.equal(source.listeners.size, 0);
  assert.equal(source.clearedListeners.size, 0);
  assert.equal(page.schemeListeners(), 0);
  source.emit({ [SETTINGS_STORAGE_KEY]: { newValue: { accentTheme: "redblack" } } });
  assert.equal(page.root.dataset.accentTheme, "marker");
});

test("卡片的明暗跟着所在的页面：给了页面的明暗就不跟设置和系统；页面换了，重新落地；认不出时照旧按设置", async () => {
  // 设置选了深色、系统也是深色，页面是浅色。
  const source = fakeSource({ accentTheme: "redblack", themeMode: THEME_MODES.DARK });
  const page = fakePage({ prefersDark: true });
  let host: "light" | "dark" | null = "light";
  const watch = await watchAppearance({ ...source.deps, hostMode: () => host }, page.root);
  assert.deepEqual({ ...page.root.dataset }, { accentTheme: "redblack", themeMode: "light" });

  // 设置里改明暗不影响卡片，改主题照常生效。
  source.emit({ [SETTINGS_STORAGE_KEY]: { newValue: { accentTheme: "pinkblue", themeMode: THEME_MODES.SYSTEM } } });
  assert.deepEqual({ ...page.root.dataset }, { accentTheme: "pinkblue", themeMode: "light" });

  host = "dark";
  watch.refresh();
  assert.equal(page.root.dataset.themeMode, "dark");

  // 页面的明暗认不出了：回到设置里的（跟随系统，系统是深色）。
  host = null;
  watch.refresh();
  assert.equal(page.root.dataset.themeMode, "dark");

  watch.stop();
  host = "light";
  watch.refresh();
  assert.equal(page.root.dataset.themeMode, "dark", "停止以后不再改");
});

test("设置读回来之前页面的明暗已经变了：按最新的落地；读设置失败时只换明暗，主题留着首帧的样子", async () => {
  let release: (value: Record<string, unknown>) => void = () => undefined;
  const reading = new Promise<Record<string, unknown>>((resolve) => (release = resolve));
  const page = fakePage();
  let host: "light" | "dark" = "light";
  const pending = watchAppearance({ local: { get: () => reading }, hostMode: () => host }, page.root);
  host = "dark";
  release({ [SETTINGS_STORAGE_KEY]: { accentTheme: "marker", themeMode: THEME_MODES.LIGHT } });
  const watch = await pending;
  assert.deepEqual({ ...page.root.dataset }, { accentTheme: "marker", themeMode: "dark" });
  watch.stop();

  const broken = fakePage();
  broken.root.dataset.accentTheme = "redblack";
  const failed = await watchAppearance({ local: { get: () => Promise.reject(new Error("读不到")) }, hostMode: () => host }, broken.root);
  assert.equal(failed.current(), null);
  failed.refresh();
  assert.deepEqual({ ...broken.root.dataset }, { accentTheme: "redblack", themeMode: "dark" });
});

test("applyAppearance 把主题和明暗落到根节点的 data 属性上", () => {
  const root = { dataset: {} as Record<string, string | undefined> };
  const normalized = applyAppearance({ accentTheme: "redblack", themeMode: "dark" }, root);
  assert.deepEqual({ ...root.dataset }, { accentTheme: "redblack", themeMode: "dark" });
  assert.deepEqual(normalized, { accentTheme: "redblack", themeMode: "dark", uiFontScale: 100, language: "auto" });

  // 跟随系统要在无浏览器环境时安全落地
  const plain = { dataset: {} as Record<string, string | undefined> };
  applyAppearance({}, plain);
  assert.equal(plain.dataset.themeMode, "light");

  // 没有可写的根节点时不能抛错
  assert.doesNotThrow(() => applyAppearance({}, null));

  // 界面字号就近归档，写成根字号的倍数
  const scaled = fakePage().root;
  assert.equal(applyUiFontScale(130, scaled), 125);
  assert.equal(scaled.style.values["--ui-font-zoom"], "1.25");

  // 不管存的是什么，写到根节点的值都在合法范围内
  const zooms = new Set(UI_FONT_SCALES.map((scale) => String(scale / 100)));
  for (const raw of [undefined, null, "oops", 42, { accentTheme: "violet", themeMode: "sepia", uiFontScale: "abc" }, { accentTheme: "__proto__", uiFontScale: 999 }, { accentTheme: ["marker"], themeMode: 1 }]) {
    const target = fakePage().root;
    applyAppearance(raw, target);
    assert.ok(Object.hasOwn(ACCENT_THEMES, target.dataset.accentTheme ?? ""), `${JSON.stringify(raw)} → ${target.dataset.accentTheme}`);
    assert.ok([THEME_MODES.LIGHT, THEME_MODES.DARK].includes(target.dataset.themeMode as "light"), `${JSON.stringify(raw)} → ${target.dataset.themeMode}`);
    assert.ok(zooms.has(target.style.values["--ui-font-zoom"] ?? ""), `${JSON.stringify(raw)} → ${target.style.values["--ui-font-zoom"]}`);
  }
});

/** 带整页淡化的页面替身：淡化的回调和动画帧都排着，测试自己决定什么时候跑。 */
function fadingPage() {
  const localStorage = memoryLocalStorage();
  const transitions: (() => void)[] = [];
  const frames: (() => void)[] = [];
  const values: Record<string, string> = {};
  const view = {
    location: { protocol: "chrome-extension:" },
    localStorage,
    matchMedia: (_query: string) => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }),
    document: { visibilityState: "visible", startViewTransition: (update: () => void) => void transitions.push(update) },
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
  };
  const root = { dataset: {} as Record<string, string | undefined>, style: { values, setProperty: (name: string, value: string) => void (values[name] = value) }, ownerDocument: { defaultView: view } };
  const run = (queue: (() => void)[]): void => {
    for (const callback of queue.splice(0)) callback();
  };
  return { root, localStorage, transitions, flushTransitions: () => run(transitions), flushFrames: () => run(frames) };
}

test("watchAppearance：换主题时整页淡过去，换的那几帧挂着标记；淡化的回调晚到时已经又换回来了，不把旧主题写回去", async () => {
  const source = fakeSource({ accentTheme: "marker", themeMode: "light" });
  const page = fadingPage();
  const watch = await watchAppearance(source.deps, page.root);
  assert.equal(page.root.dataset.accentTheme, "marker");
  assert.equal(page.transitions.length, 0, "第一次落地照着首帧直接写，不淡化");

  source.emit({ [SETTINGS_STORAGE_KEY]: { newValue: { accentTheme: "pinkblue", themeMode: "light" } } });
  assert.equal(page.transitions.length, 1, "换主题走整页淡化");
  assert.equal(page.root.dataset.accentTheme, "marker", "淡化的回调还没跑，页面还是旧的");
  page.flushTransitions();
  assert.equal(page.root.dataset.accentTheme, "pinkblue");
  assert.equal(page.root.dataset.themeSwitching, "true", "换的那几帧关掉换色过渡");
  page.flushFrames();
  page.flushFrames();
  assert.equal(page.root.dataset.themeSwitching, undefined, "两帧以后拿掉标记");

  // 换成荧光笔、回调还没跑就又换回粉蓝：先换的那次晚到的回调不能把荧光笔写回去。
  source.emit({ [SETTINGS_STORAGE_KEY]: { newValue: { accentTheme: "marker", themeMode: "light" } } });
  source.emit({ [SETTINGS_STORAGE_KEY]: { newValue: { accentTheme: "pinkblue", themeMode: "light" } } });
  page.flushTransitions();
  page.flushFrames();
  page.flushFrames();
  assert.equal(page.root.dataset.accentTheme, "pinkblue");
  assert.equal(watch.current()?.accentTheme, "pinkblue");
  assert.equal(JSON.parse(page.localStorage.getItem(APPEARANCE_CACHE_KEY) ?? "null")?.accentTheme, "pinkblue", "首帧缓存也是最后那次");
  watch.stop();
});
