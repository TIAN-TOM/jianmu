// chrome.permissions 的封装。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPermissions } from "../../../src/platform/permissions.ts";
import { CONTENT_MATCHES, fakePermissions, REQUIRED_HOSTS } from "../../helpers/fake-permissions.ts";

const permissionsOn = (browser: ReturnType<typeof fakePermissions>) => createPermissions(browser.api, browser.manifest);

test("declared 列出清单主机和内容脚本的匹配规则", () => {
  assert.deepEqual(permissionsOn(fakePermissions()).declared(), [...REQUIRED_HOSTS, ...CONTENT_MATCHES]);
});

test("清单里没有主机和内容脚本时 declared 是空的", () => {
  const permissions = createPermissions(fakePermissions().api, () => ({}));
  assert.deepEqual(permissions.declared(), []);
});

test("listed 原样给出浏览器列出的规则：清单主机、内容脚本的匹配规则和运行时授权都在", async () => {
  const browser = fakePermissions();
  browser.grant("https://api.example.com/");

  assert.deepEqual(
    await permissionsOn(browser).listed(),
    [...REQUIRED_HOSTS, ...CONTENT_MATCHES, "https://api.example.com/*"].sort(),
  );
});

test("浏览器的回答里没有 origins 时 listed 是空的", async () => {
  const permissions = createPermissions({ ...fakePermissions().api, getAll: async () => ({}) }, () => ({}));
  assert.deepEqual(await permissions.listed(), []);
});

test("contains 只查一个来源，授权过的主机和清单主机都算，没授权的不算", async () => {
  const browser = fakePermissions();
  browser.grant("https://api.example.com/");
  const permissions = permissionsOn(browser);

  assert.equal(await permissions.contains("https://api.example.com/"), true);
  assert.equal(await permissions.contains("https://www.video.example/"), true);
  assert.equal(await permissions.contains("https://other.example.com/"), false);
  assert.deepEqual(browser.removeCalls, [], "只查不改");
});

test("revoke 一次只把一条规则交给浏览器", async () => {
  const browser = fakePermissions({ granted: ["https://api.example.com/*"] });

  assert.equal(await permissionsOn(browser).revoke("https://api.example.com/*"), true);
  assert.deepEqual(browser.removeCalls, [["https://api.example.com/*"]]);
  assert.deepEqual(browser.removed, ["https://api.example.com/*"]);
});

test("createPermissions 默认用浏览器的接口和清单", async (t) => {
  const browser = fakePermissions({ granted: ["https://api.example.com/*"] });
  Object.defineProperty(globalThis, "chrome", {
    value: { permissions: browser.api, runtime: { getManifest: browser.manifest } },
    configurable: true,
  });
  t.after(() => {
    Reflect.deleteProperty(globalThis, "chrome");
  });

  const permissions = createPermissions();
  assert.deepEqual(permissions.declared(), [...REQUIRED_HOSTS, ...CONTENT_MATCHES]);
  assert.ok((await permissions.listed()).includes("https://api.example.com/*"));
});
