// 回收主机授权：替身的 getAll() 按实测形状列出清单主机和内容脚本的匹配规则，回收按实测一批里有一条回收不了就整批拒绝。
// 主机名是造的，「B站权限」对应清单里写死的必需主机。设置走真实的仓库和规则。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createGrants, type Grants } from "../../../src/background/grants.ts";
import { createLocks } from "../../../src/platform/locks.ts";
import { createPermissions, type ManifestHosts, type PermissionsApi } from "../../../src/platform/permissions.ts";
import { createSettingsStore, type SettingsStore } from "../../../src/platform/settings-store.ts";
import { SETTINGS_STORAGE_KEY } from "../../../src/shared/names.ts";
import { DATA_CONSENT_CONFIRMED, normalize, type SettingsInput } from "../../../src/shared/settings-schema.ts";
import {
  CONTENT_MATCHES,
  fakePermissions,
  REQUIRED_HOSTS,
  type FakePermissions,
  type FakePermissionsOptions,
} from "../../helpers/fake-permissions.ts";
import { memoryStorage } from "../../helpers/memory-storage.ts";

const DECLARED = [...REQUIRED_HOSTS, ...CONTENT_MATCHES];

/** 这里的存储是直接摆好的，没有修订号。 */
const NO_REVISION = "";

const addressed = (aiBaseUrl: string): SettingsInput => ({
  presetId: "custom",
  protocol: "openai",
  aiBaseUrl,
  aiModel: "chat-model",
  ...DATA_CONSENT_CONFIRMED,
});

interface WorldOptions extends FakePermissionsOptions {
  readonly settings?: SettingsInput;
  readonly siteOrigins?: readonly string[];
  readonly api?: (browser: FakePermissions) => PermissionsApi;
  readonly manifest?: ManifestHosts;
  readonly loadSettings?: (store: SettingsStore) => SettingsStore["load"];
}

interface World {
  readonly browser: FakePermissions;
  readonly store: SettingsStore;
  readonly grants: Grants;
  readonly logged: { message: string; detail: unknown }[];
}

function world({
  settings = addressed("https://api.example.com"),
  siteOrigins = [],
  api = (browser) => browser.api,
  manifest,
  loadSettings = (store) => store.load,
  ...browserOptions
}: WorldOptions = {}): World {
  const browser = fakePermissions(browserOptions);
  const store = createSettingsStore({
    storage: {
      local: memoryStorage({ [SETTINGS_STORAGE_KEY]: normalize(settings) }),
      session: memoryStorage(),
    },
    locks: createLocks(),
  });
  const logged: World["logged"] = [];
  const grants = createGrants({
    permissions: createPermissions(api(browser), manifest ? () => manifest : browser.manifest),
    loadSettings: loadSettings(store),
    siteOrigins: () => siteOrigins,
    logError: (message, detail) => logged.push({ message, detail }),
  });
  return { browser, store, grants, logged };
}

test("保存新地址后回收旧地址和只测过的地址，留下刚保存的和清单里的 B站权限", async () => {
  const { browser, store, grants } = world({
    granted: ["https://api.example.com/*", "https://tried-once.example.org/*"],
  });

  browser.grant("https://new.example.net/");
  const saved = await store.save(addressed("https://new.example.net/v1"), NO_REVISION);
  const result = await grants.releaseUnused();

  assert.equal(saved.aiBaseUrl, "https://new.example.net/v1");
  assert.deepEqual([...browser.removed].sort(), ["https://api.example.com/*", "https://tried-once.example.org/*"]);
  assert.deepEqual(browser.origins(), [...DECLARED, "https://new.example.net/*"].sort());
  assert.deepEqual([...result.released].sort(), [...browser.removed].sort());
  assert.deepEqual(result.failed, []);
});

test("按功能另选的模型和默认模型走同一个地址，保存后这个来源留着", async () => {
  const featureModels = { verdict: "fast-model", qa: "smart-model" };
  const { browser, store, grants } = world({
    settings: { ...addressed("https://api.example.com"), featureModels },
    granted: ["https://api.example.com/*", "https://old.example.org/*"],
  });

  const saved = await store.save(await store.load(), NO_REVISION);
  await grants.releaseUnused();

  assert.deepEqual(saved.featureModels, featureModels);
  assert.deepEqual(browser.removed, ["https://old.example.org/*"]);
  assert.ok(browser.origins().includes("https://api.example.com/*"));
});

test("没有用不上的授权时不调用回收", async () => {
  const { browser, store, grants } = world({ granted: ["https://api.example.com/*"] });

  await store.save(await store.load(), NO_REVISION);
  const result = await grants.releaseUnused();

  assert.deepEqual(browser.removeCalls, []);
  assert.deepEqual(result, { released: [], failed: [] });
});

test("一条一条回收，内容脚本的匹配规则混在列表里也不影响", async () => {
  const { browser, grants } = world({
    granted: ["https://api.example.com/*", "https://old-a.example.org/*", "https://old-b.example.org/*"],
  });

  await grants.releaseUnused();

  assert.deepEqual(browser.removeCalls, [["https://old-a.example.org/*"], ["https://old-b.example.org/*"]]);
  assert.deepEqual(browser.origins(), [...DECLARED, "https://api.example.com/*"].sort());
});

test("只有内容脚本用到的主机也不回收", async () => {
  const contentMatches = new Set<string>(CONTENT_MATCHES);
  const { browser, grants } = world({ manifest: { content_scripts: [{ matches: CONTENT_MATCHES }] } });

  await grants.releaseUnused();

  assert.deepEqual(browser.removeCalls.flat().filter((pattern) => contentMatches.has(pattern)), []);
});

test("一条被浏览器拒绝时记日志，后面的照收", async () => {
  const stuck = "https://old-a.example.org/*";
  const { browser, grants, logged } = world({
    granted: [stuck, "https://old-b.example.org/*"],
    api: (fake) => ({
      ...fake.api,
      remove: async (request) => {
        if (request.origins.includes(stuck)) throw new Error("浏览器拒绝了");
        return fake.api.remove(request);
      },
    }),
  });

  const result = await grants.releaseUnused();

  assert.deepEqual(result, { released: ["https://old-b.example.org/*"], failed: [stuck] });
  assert.deepEqual(browser.removed, ["https://old-b.example.org/*"]);
  assert.equal(logged.length, 1);
  assert.deepEqual(logged[0]?.detail, { pattern: stuck, error: new Error("浏览器拒绝了") });
});

test("浏览器回答没收掉时算失败，记日志", async () => {
  const stuck = "https://old-a.example.org/*";
  const { grants, logged } = world({
    granted: [stuck, "https://old-b.example.org/*"],
    api: (fake) => ({
      ...fake.api,
      remove: async (request) => (request.origins.includes(stuck) ? false : fake.api.remove(request)),
    }),
  });

  const result = await grants.releaseUnused();

  assert.deepEqual(result, { released: ["https://old-b.example.org/*"], failed: [stuck] });
  assert.deepEqual(logged.map(({ detail }) => detail), [{ pattern: stuck }]);
});

test("浏览器列出清单以外的必需规则时，只有这条收不掉，用不上的照样收回", async () => {
  const unknownRequired = "https://bundled.example.org/*";
  const { browser, grants, logged } = world({
    alsoRequired: [unknownRequired],
    granted: ["https://old.example.org/*"],
  });

  const result = await grants.releaseUnused();

  assert.deepEqual(result, { released: ["https://old.example.org/*"], failed: [unknownRequired] });
  assert.deepEqual(browser.removed, ["https://old.example.org/*"]);
  assert.equal(logged.length, 1);
});

for (const pattern of [
  "https://api.example.com/*",
  "https://api.example.com/",
  "https://api.example.com/v1/*",
  "https://*.example.com/*",
  "*://api.example.com/*",
]) {
  test(`当前地址的授权写成 ${pattern} 也算在用`, async () => {
    const { browser, grants } = world({ granted: [pattern] });

    await grants.releaseUnused();

    assert.deepEqual(browser.removeCalls, []);
  });
}

test("相邻域名不算当前地址的来源", async () => {
  const { browser, grants } = world({ granted: ["https://xapi.example.com/*", "https://api.example.com.evil.example/*"] });

  await grants.releaseUnused();

  assert.deepEqual([...browser.removed].sort(), ["https://api.example.com.evil.example/*", "https://xapi.example.com/*"]);
});

test("通配授权盖得住裸域名，盖不住只是结尾相同的域名", async () => {
  const wildcard = "https://*.example.com/*";

  const bare = world({ settings: addressed("https://example.com"), granted: [wildcard] });
  await bare.grants.releaseUnused();
  assert.deepEqual(bare.browser.removeCalls, []);

  const lookalike = world({ settings: addressed("https://notexample.com"), granted: [wildcard] });
  await lookalike.grants.releaseUnused();
  assert.deepEqual(lookalike.browser.removed, [wildcard]);
});

for (const { grantedRule, address } of [
  { grantedRule: "https://api.example.com/*", address: "https://api.example.com:8443/v1" },
  { grantedRule: "https://api.example.com:*/*", address: "https://api.example.com:8443/v1" },
  { grantedRule: "https://api.example.com:8443/*", address: "https://api.example.com:8443/v1" },
  { grantedRule: "https://*.example.org/*", address: "https://gw.example.org:8443/v1" },
  { grantedRule: "https://localhost/*", address: "https://localhost:8443/v1" },
]) {
  test(`当前地址 ${address} 的授权写成 ${grantedRule} 也算在用`, async () => {
    const { browser, grants } = world({ settings: addressed(address), granted: [grantedRule] });

    await grants.releaseUnused();

    assert.deepEqual(browser.removeCalls, []);
    assert.ok(browser.origins().includes(grantedRule));
  });
}

test("不写端口和写了端口的授权都在时都不回收：收前一条会把后一条连带收掉", async () => {
  const bare = "https://api.example.com/*";
  const ported = "https://api.example.com:8443/*";
  const { browser, grants } = world({ settings: addressed("https://api.example.com:8443/v1"), granted: [bare, ported] });

  await grants.releaseUnused();

  assert.deepEqual(browser.removeCalls, []);
  assert.ok(browser.origins().includes(bare));
  assert.ok(browser.origins().includes(ported));
});

test("同一主机换了端口的旧授权照收", async () => {
  const { browser, grants } = world({
    settings: addressed("https://api.example.com:8443/v1"),
    granted: ["https://api.example.com:8443/*", "https://api.example.com:9000/*"],
  });

  await grants.releaseUnused();

  assert.deepEqual(browser.removed, ["https://api.example.com:9000/*"]);
});

test("别的主机写了端口或端口通配的授权照收", async () => {
  const stale = ["https://old.example.net:*/*", "https://old.example.org:8443/*"];
  const { browser, grants } = world({ granted: stale });

  await grants.releaseUnused();

  assert.deepEqual([...browser.removed].sort(), stale);
});

test("当前地址没写端口时，同一主机带端口的授权留着：多留一条比收错安全", async () => {
  const { browser, grants } = world({
    settings: addressed("https://api.example.com/v1"),
    granted: ["https://api.example.com:8443/*"],
  });

  await grants.releaseUnused();

  assert.deepEqual(browser.removeCalls, []);
});

test("落在必需通配主机里的授权不回收", async () => {
  const { browser, grants } = world({ granted: ["https://cdn.static.example/*"] });

  await grants.releaseUnused();

  assert.deepEqual(browser.removeCalls, []);
});

for (const wide of ["https://*/*", "https://*.video.example/*"]) {
  test(`比必需主机宽的授权 ${wide} 不回收，否则必需主机会被一起收掉`, async () => {
    const { browser, grants } = world({ granted: [wide] });

    await grants.releaseUnused();

    assert.deepEqual(browser.removeCalls, []);
    for (const host of REQUIRED_HOSTS) assert.ok(browser.origins().includes(host), host);
  });
}

for (const pattern of ["<all_urls>", "file:///*", "http://old.example.org/*", "https://[2001:db8::1]/*"]) {
  test(`认不出写法的规则 ${pattern} 不碰，可能比必需主机还宽`, async () => {
    const { browser, grants } = world({ granted: [pattern] });

    await grants.releaseUnused();

    assert.deepEqual(browser.removeCalls, []);
  });
}

test("保存 AI 设置不影响已启用站点的授权", async () => {
  const site = "https://site.example.net/";
  const { browser, store, grants } = world({
    granted: [`${site}*`, "https://api.example.com/*"],
    siteOrigins: [site],
  });

  browser.grant("https://new.example.org/");
  await store.save(addressed("https://new.example.org/v1"), NO_REVISION);
  await grants.releaseUnused();

  assert.deepEqual(browser.removed, ["https://api.example.com/*"]);
  assert.ok(browser.origins().includes(`${site}*`));
});

test("站点停用以后，下次回收把它的授权收回", async () => {
  const { browser, grants } = world({ granted: ["https://site.example.net/*", "https://api.example.com/*"] });

  await grants.releaseUnused();

  assert.deepEqual(browser.removed, ["https://site.example.net/*"]);
});

test("当前地址不合法时这次不回收", async () => {
  const { browser, grants } = world({
    settings: addressed("http://api.example.com"),
    granted: ["https://api.example.com/*", "https://old.example.org/*"],
  });

  assert.deepEqual(await grants.releaseUnused(), { released: [], failed: [] });
  assert.deepEqual(browser.removeCalls, []);
});

test("读不到设置时不回收，记日志，不抛错", async () => {
  const { browser, grants, logged } = world({
    granted: ["https://old.example.org/*"],
    loadSettings: () => async () => {
      throw new Error("读不出来");
    },
  });

  assert.deepEqual(await grants.releaseUnused(), { released: [], failed: [] });
  assert.deepEqual(browser.removeCalls, []);
  assert.equal(logged.length, 1);
});

test("读不到授权列表时不回收，记日志，不抛错", async () => {
  const { browser, grants, logged } = world({
    granted: ["https://old.example.org/*"],
    api: (fake) => ({
      ...fake.api,
      getAll: async () => {
        throw new Error("读不出来");
      },
    }),
  });

  assert.deepEqual(await grants.releaseUnused(), { released: [], failed: [] });
  assert.deepEqual(browser.removeCalls, []);
  assert.equal(logged.length, 1);
});
