// 扩展页面的外观：主题、明暗、字号落到根节点上，跟着设置变；清除全部数据后按默认值重写首帧缓存。
import assert from "node:assert/strict";
import { test } from "node:test";
import { applyAppearance, applyUiFontScale, resolveThemeMode, watchAppearance, type WatchAppearanceDeps } from "../../../../src/pages/shared/theme.ts";
import { APPEARANCE_CACHE_KEY, SETTINGS_STORAGE_KEY } from "../../../../src/shared/names.ts";
import { ACCENT_THEMES, THEME_MODES, UI_FONT_SCALES } from "../../../../src/shared/settings-schema.ts";
import { deferred, nextTurn } from "../../../helpers/deferred.ts";
import { fakePage, memoryLocalStorage } from "../../../helpers/fake-page.ts";
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
  const source = fakeSource({ accentTheme: "ochre", themeMode: "dark", uiFontScale: 118 });
  const localStorage = memoryLocalStorage();
  const { root } = fakePage({ localStorage });

  const watch = await watchAppearance(source.deps, root);
  assert.deepEqual(watch.current(), { accentTheme: "ochre", themeMode: "dark", uiFontScale: 112 });
  assert.equal(root.dataset.accentTheme, "ochre");
  assert.equal(root.dataset.themeMode, "dark");
  assert.equal(root.style.values["--ui-font-zoom"], "1.12");

  source.emit({ [SETTINGS_STORAGE_KEY]: { newValue: { accentTheme: "graphite", themeMode: "light" } } });
  assert.equal(root.dataset.accentTheme, "graphite", "设置页换了主题，页面立刻跟着换");
  assert.equal(root.dataset.themeMode, "light");
  assert.equal(root.style.values["--ui-font-zoom"], "1");
  assert.deepEqual(JSON.parse(localStorage.getItem(APPEARANCE_CACHE_KEY) ?? "null"), { accentTheme: "graphite", themeMode: "light", uiFontScale: 100 });

  source.emit({ [SETTINGS_STORAGE_KEY]: { newValue: { accentTheme: "ink" } } }, "sync");
  source.emit({ [SETTINGS_STORAGE_KEY]: { newValue: { accentTheme: "ink" } } }, "session");
  source.emit({ other_key: { newValue: {} } });
  assert.equal(root.dataset.accentTheme, "graphite", "别的存储区、别的键变了不理");

  // 没有变化事件的环境（比如测试替身）也不能抛
  const plain = fakePage().root;
  const quiet = await watchAppearance({ local: memoryStorage() }, plain);
  assert.equal(plain.dataset.accentTheme, "ink");
  assert.equal(quiet.current()?.themeMode, "system");
});

test("读设置的途中设置变了：以变化为准，不让读回来的旧值盖回去；读设置失败就留着首帧的样子", async () => {
  const source = fakeSource({ accentTheme: "ochre" });
  const gate = deferred();
  const { root } = fakePage();
  const slow = async (key: string) => {
    await gate.promise;
    return source.local.get(key);
  };
  const pending = watchAppearance({ ...source.deps, local: { get: slow } }, root);
  source.emit({ [SETTINGS_STORAGE_KEY]: { newValue: { accentTheme: "graphite" } } });
  gate.resolve();
  const watch = await pending;
  assert.equal(root.dataset.accentTheme, "graphite");
  assert.equal(watch.current()?.accentTheme, "graphite");

  const failing = fakePage().root;
  failing.dataset.accentTheme = "ochre";
  const broken = await watchAppearance({ local: { get: () => Promise.reject(new Error("读不到")) } }, failing);
  assert.equal(broken.current(), null);
  assert.equal(failing.dataset.accentTheme, "ochre", "首帧脚本写下的样子不动");
});

test("收到清除全部数据：按清除后的设置（默认值）重写外观和首帧缓存；只清缓存时不动", async () => {
  const source = fakeSource({ accentTheme: "graphite", themeMode: "dark", uiFontScale: 125 });
  const localStorage = memoryLocalStorage();
  const { root } = fakePage({ localStorage });
  const watch = await watchAppearance(source.deps, root);
  assert.equal(JSON.parse(localStorage.getItem(APPEARANCE_CACHE_KEY) ?? "null").accentTheme, "graphite");

  source.broadcastCleared("cache");
  await nextTurn();
  assert.equal(source.reads(), 1, "只清缓存：外观设置还在，不重读");
  assert.equal(root.dataset.accentTheme, "graphite");

  await source.local.remove(SETTINGS_STORAGE_KEY);
  source.broadcastCleared("all");
  assert.ok(await until(() => root.dataset.accentTheme === "ink"));
  assert.equal(watch.current()?.accentTheme, "ink");
  assert.deepEqual({ ...root.dataset }, { accentTheme: "ink", themeMode: "light" });
  assert.equal(root.style.values["--ui-font-zoom"], "1");
  assert.deepEqual(JSON.parse(localStorage.getItem(APPEARANCE_CACHE_KEY) ?? "null"), { accentTheme: "ink", themeMode: "system", uiFontScale: 100 });

  // 清除以后读设置失败：照样按默认值重写
  const other = fakeSource({ accentTheme: "ochre" });
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
  assert.ok(await until(() => otherPage.root.dataset.accentTheme === "ink"));
  assert.equal(JSON.parse(otherCache.getItem(APPEARANCE_CACHE_KEY) ?? "null").accentTheme, "ink");
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
  source.emit({ [SETTINGS_STORAGE_KEY]: { newValue: { accentTheme: "ochre" } } });
  assert.equal(page.root.dataset.accentTheme, "ink");
});

test("applyAppearance 把主题和明暗落到根节点的 data 属性上", () => {
  const root = { dataset: {} as Record<string, string | undefined> };
  const normalized = applyAppearance({ accentTheme: "ochre", themeMode: "dark" }, root);
  assert.deepEqual({ ...root.dataset }, { accentTheme: "ochre", themeMode: "dark" });
  assert.deepEqual(normalized, { accentTheme: "ochre", themeMode: "dark", uiFontScale: 100 });

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
  for (const raw of [undefined, null, "oops", 42, { accentTheme: "violet", themeMode: "sepia", uiFontScale: "abc" }, { accentTheme: "__proto__", uiFontScale: 999 }, { accentTheme: ["ink"], themeMode: 1 }]) {
    const target = fakePage().root;
    applyAppearance(raw, target);
    assert.ok(Object.hasOwn(ACCENT_THEMES, target.dataset.accentTheme ?? ""), `${JSON.stringify(raw)} → ${target.dataset.accentTheme}`);
    assert.ok([THEME_MODES.LIGHT, THEME_MODES.DARK].includes(target.dataset.themeMode as "light"), `${JSON.stringify(raw)} → ${target.dataset.themeMode}`);
    assert.ok(zooms.has(target.style.values["--ui-font-zoom"] ?? ""), `${JSON.stringify(raw)} → ${target.style.values["--ui-font-zoom"]}`);
  }
});
