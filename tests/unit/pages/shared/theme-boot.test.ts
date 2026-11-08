// 首帧外观：applyAppearance 每次落地外观时留一份 localStorage 缓存，首帧脚本在 <head> 里同步读它，
// 第一帧就用上选好的主题、明暗和字号，而且和读回设置后落的一模一样。
import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { build } from "esbuild";
import { applyAppearance } from "../../../../src/pages/shared/theme.ts";
import { applyCache, CACHE_KEY, FONT_SCALES, MODES, readCache, THEMES } from "../../../../src/pages/shared/theme-boot.ts";
import { APPEARANCE_CACHE_KEY } from "../../../../src/shared/names.ts";
import { ACCENT_THEMES, THEME_MODES, UI_FONT_SCALES } from "../../../../src/shared/settings-schema.ts";
import { fakePage, memoryLocalStorage, type MemoryLocalStorage } from "../../../helpers/fake-page.ts";

// 页面读回设置以后落下的样子，以及它留下的缓存。
function landedFromStorage(stored: unknown, prefersDark: boolean) {
  const localStorage = memoryLocalStorage();
  const { root } = fakePage({ localStorage, prefersDark });
  applyAppearance(stored, root);
  return { dataset: { ...root.dataset }, zoom: root.style.values["--ui-font-zoom"], cache: localStorage };
}

const cachedIn = (storage: MemoryLocalStorage): unknown => JSON.parse(storage.getItem(APPEARANCE_CACHE_KEY) ?? "null");

// 和构建一样打成经典脚本，在一个假的页面里真的跑一遍，看它在 <html> 上写了什么。
const BOOT_SCRIPT = (
  await build({
    entryPoints: [new URL("../../../../src/pages/shared/theme-boot.ts", import.meta.url).pathname],
    bundle: true,
    format: "iife",
    target: "chrome116",
    write: false,
    logLevel: "silent",
  })
).outputFiles[0]?.text ?? "";

function runBootInPage({ localStorage, prefersDark = false, storageThrows = false }: { localStorage?: Pick<Storage, "getItem">; prefersDark?: boolean; storageThrows?: boolean } = {}) {
  const { root } = fakePage();
  const context: Record<string, unknown> = {
    document: { documentElement: root },
    matchMedia: (query: string) => ({ matches: query === "(prefers-color-scheme: dark)" && prefersDark }),
  };
  Object.defineProperty(context, "localStorage", {
    get() {
      if (storageThrows) throw new Error("SecurityError: Access is denied for this document.");
      return localStorage;
    },
  });
  vm.runInNewContext(BOOT_SCRIPT, context);
  return { dataset: { ...root.dataset }, zoom: root.style.values["--ui-font-zoom"] };
}

test("缓存的键名和合法取值与设置模块一致", () => {
  assert.equal(CACHE_KEY, APPEARANCE_CACHE_KEY);
  assert.match(CACHE_KEY, /^jianmu_/, "存储键沿用 jianmu_ 前缀");
  assert.deepEqual([...THEMES], Object.keys(ACCENT_THEMES));
  assert.deepEqual([...MODES], Object.values(THEME_MODES));
  assert.deepEqual([...FONT_SCALES], [...UI_FONT_SCALES]);
});

test("applyAppearance 落地外观时把主题、明暗和字号记进页面的 localStorage，旧色板记成映射后的主题", () => {
  const localStorage = memoryLocalStorage();
  const { root } = fakePage({ localStorage });
  // 认不出的主题名（比如别的版本留下的色板）按设置模块规整成三套之一，缓存里记规整后的值。
  applyAppearance({ accentTheme: "amber", themeMode: "dark", uiFontScale: 118 }, root);
  assert.deepEqual(cachedIn(localStorage), { accentTheme: "ink", themeMode: "dark", uiFontScale: 112 });
  applyAppearance({ accentTheme: "ochre", themeMode: "light", uiFontScale: 125 }, root);
  assert.deepEqual(cachedIn(localStorage), { accentTheme: "ochre", themeMode: "light", uiFontScale: 125 });

  // 「跟随系统」记原值，不记解析结果：下次打开时系统可能已经换了明暗
  applyAppearance({ themeMode: "system" }, root);
  assert.equal((cachedIn(localStorage) as { themeMode: string }).themeMode, "system");
});

test("缓存只写扩展自己的页面；存储写不进去时照样落地外观，不抛错", () => {
  // 万一这段代码被带进别人的网页：那边的 localStorage 不能碰
  const foreign = memoryLocalStorage();
  applyAppearance({ accentTheme: "graphite" }, fakePage({ protocol: "https:", localStorage: foreign }).root);
  assert.equal(foreign.values.size, 0);

  const broken = fakePage({
    localStorage: {
      getItem: () => null,
      setItem() {
        throw new Error("QuotaExceededError");
      },
    },
  }).root;
  assert.doesNotThrow(() => applyAppearance({ accentTheme: "graphite" }, broken));
  assert.equal(broken.dataset.accentTheme, "graphite");

  // 根节点没有所在页面（单元测试里的桩）时什么都不写
  const bare = { dataset: {} as Record<string, string | undefined> };
  assert.doesNotThrow(() => applyAppearance({ accentTheme: "ochre" }, bare));
  assert.equal(bare.dataset.accentTheme, "ochre");
});

test("每种主题、明暗、字号：首帧按缓存写下的，和读回存储后落的一模一样", () => {
  for (const accentTheme of THEMES) {
    for (const themeMode of MODES) {
      for (const uiFontScale of FONT_SCALES) {
        for (const prefersDark of [false, true]) {
          const landed = landedFromStorage({ accentTheme, themeMode, uiFontScale }, prefersDark);
          const first = fakePage().root;
          applyCache(readCache(landed.cache), first, prefersDark);
          const label = `${accentTheme}/${themeMode}/${uiFontScale}/系统${prefersDark ? "深" : "浅"}色`;
          assert.deepEqual({ ...first.dataset }, landed.dataset, label);
          assert.equal(first.style.values["--ui-font-zoom"], landed.zoom, label);
        }
      }
    }
  }
});

test("缓存没有、损坏、读存储抛错时什么都不写；不合法的那一项单独丢掉", () => {
  const storageWith = (raw?: string) => memoryLocalStorage(raw === undefined ? {} : { [CACHE_KEY]: raw });

  assert.deepEqual(readCache(storageWith()), {});
  assert.deepEqual(readCache(null), {});
  assert.deepEqual(readCache(undefined), {});
  for (const raw of ["", "{", "null", "42", '"ink"', "[]", "undefined"]) {
    assert.deepEqual(readCache(storageWith(raw)), {}, raw);
  }
  assert.deepEqual(
    readCache({
      getItem() {
        throw new Error("SecurityError");
      },
    }),
    {},
  );

  // 只认三套主题、三种明暗、三档字号；别的主题名、大小写不对、字符串字号都不认
  const partial = readCache(storageWith(JSON.stringify({ accentTheme: "pink", themeMode: "dark", uiFontScale: "112" })));
  assert.deepEqual(partial, { themeMode: "dark" });
  const odd = readCache(storageWith(JSON.stringify({ accentTheme: "__proto__", themeMode: "Dark", uiFontScale: 140 })));
  assert.deepEqual(odd, {});
  const nested = readCache(storageWith('{"__proto__": {"accentTheme": "ochre"}, "uiFontScale": 125}'));
  assert.deepEqual(nested, { uiFontScale: 125 });

  // 什么都没认出来时根节点原样不动，交给样式表的默认
  const root = fakePage().root;
  applyCache({}, root, true);
  assert.deepEqual({ dataset: { ...root.dataset }, style: { ...root.style.values } }, { dataset: {}, style: {} });
});

test("在页面里真的跑一遍：同步写好 <html>，读不了存储时按默认画、不抛错", () => {
  const localStorage = memoryLocalStorage({
    [CACHE_KEY]: JSON.stringify({ accentTheme: "graphite", themeMode: "system", uiFontScale: 125 }),
  });
  assert.deepEqual(runBootInPage({ localStorage, prefersDark: true }), {
    dataset: { accentTheme: "graphite", themeMode: "dark" },
    zoom: "1.25",
  });
  assert.equal(runBootInPage({ localStorage, prefersDark: false }).dataset.themeMode, "light");

  // 刚装好还没有缓存：什么都不写，样式表的默认（宣纸墨青、跟随系统、标准字号）接手
  assert.deepEqual(runBootInPage({ localStorage: memoryLocalStorage() }), { dataset: {}, zoom: undefined });
  // 存储被禁用时连读 localStorage 属性都会抛错
  assert.deepEqual(runBootInPage({ storageThrows: true }), { dataset: {}, zoom: undefined });
  // 打出来的是经典脚本：不带模块语法，也不往页面上挂全局变量
  assert.doesNotMatch(BOOT_SCRIPT, /^\s*(?:import|export)\b/m);
  const context: Record<string, unknown> = {};
  vm.runInNewContext(BOOT_SCRIPT, context);
  assert.deepEqual(Object.keys(context), []);
});
