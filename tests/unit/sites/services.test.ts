// 服务注册表：全局 fetch 换成严格替身，扩展存储换成内存实现，不发真实请求。
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createSiteCtx, siteService } from "../../../src/sites/services.ts";
import { fakeSite } from "../../helpers/bilibili-fetch.ts";
import { json } from "../../helpers/bilibili-fixtures.ts";
import { memoryStorage } from "../../helpers/memory-storage.ts";

const SAMPLE_URL = "https://sample.example.com/ping";
const NEVER = new AbortController().signal;
const realFetch = globalThis.fetch;

function installChrome(): void {
  const storage = { local: memoryStorage(), session: memoryStorage() };
  Object.defineProperty(globalThis, "chrome", { value: { storage }, configurable: true });
}

afterEach(() => {
  globalThis.fetch = realFetch;
  Reflect.deleteProperty(globalThis, "chrome");
});

test("模块加载时不碰扩展接口，第一次用到退避时才建", () => {
  assert.equal(Reflect.has(globalThis, "chrome"), false, "这个文件导入时没有 chrome");
  assert.throws(() => createSiteCtx("bilibili", NEVER), ReferenceError);

  installChrome();
  assert.ok(createSiteCtx("bilibili", NEVER).backoff);
});

test("siteService 两次返回同一实例，还没接上的站没有服务", () => {
  const first = siteService("bilibili");
  assert.ok(first);
  assert.equal(siteService("bilibili"), first);
  assert.equal(first.rules.platform, "bilibili");
  assert.equal(siteService("youtube"), undefined);
});

test("createSiteCtx 绑定了 fetch：以方法形式调用不抛错", async () => {
  installChrome();
  const site = fakeSite({ [SAMPLE_URL]: () => json(200, {}) });
  globalThis.fetch = site.fetch;

  const ctx = createSiteCtx("bilibili", NEVER);
  const response = await ctx.fetch(SAMPLE_URL);

  assert.equal(response.status, 200);
  assert.equal(site.requests.length, 1);
});

test("每个 ctx 带自己的取消信号", () => {
  installChrome();
  const controller = new AbortController();
  assert.equal(createSiteCtx("bilibili", controller.signal).signal, controller.signal);
  assert.equal(createSiteCtx("bilibili", NEVER).signal, NEVER);
});

test("同站两个 ctx 共用一个退避，不同站不共用", async () => {
  installChrome();
  const first = createSiteCtx("bilibili", NEVER);
  const second = createSiteCtx("bilibili", NEVER);
  assert.equal(first.backoff, second.backoff);
  assert.notEqual(createSiteCtx("youtube", NEVER).backoff, first.backoff);
});
