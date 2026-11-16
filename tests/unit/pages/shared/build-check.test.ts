// 页面核对后台是不是同一次构建：一致时照常启动；标识不同、后台不认识这条请求时只显示重新加载的提示；问不到时照常启动。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createPageApi } from "../../../../src/pages/shared/api.ts";
import { checkBackground, startWhenCurrent } from "../../../../src/pages/shared/build-check.ts";
import { BUILD_ID } from "../../../../src/shared/build-id.ts";
import { BROWSER_ERRORS, fakeRuntime, type FakeReply } from "../../../helpers/fake-runtime.ts";

const PAGE_BUILD = "page-build-sample";

function pageWith(reply: FakeReply) {
  const fake = fakeRuntime();
  fake.reply("build.id", reply);
  const api = createPageApi({ runtime: fake.runtime, sleep: async () => undefined, reportError: () => undefined });
  return { fake, api };
}

const CASES: readonly (readonly [string, FakeReply, "same" | "stale" | "unknown"])[] = [
  ["标识一致", () => ({ ok: true, value: { build: PAGE_BUILD } }), "same"],
  ["标识不同", () => ({ ok: true, value: { build: "older-build-sample" } }), "stale"],
  ["回复里没有标识", () => ({ ok: true, value: {} }), "stale"],
  ["还没有这条路由的旧后台", () => ({ ok: false, code: "FORBIDDEN" }), "stale"],
  ["后台不认识这条请求", () => ({ ok: false, code: "UNKNOWN_ROUTE" }), "stale"],
  ["后台没响应", () => {
    throw new Error(BROWSER_ERRORS.unreachable);
  }, "unknown"],
  ["后台出错", () => ({ ok: false, code: "BACKGROUND_FAILED" }), "unknown"],
];

for (const [name, reply, expected] of CASES) {
  test(`${name}：${expected}`, async () => {
    const { api, fake } = pageWith(reply);
    assert.equal(await checkBackground(api, PAGE_BUILD), expected);
    assert.deepEqual(fake.sent.map(({ type }) => type).filter((type) => type !== "build.id"), [], "核对时不发别的请求");
  });
}

test("后台旧了只显示提示，不启动页面；一致或问不到时启动页面", async () => {
  for (const [name, reply, expected] of CASES) {
    // startWhenCurrent 比的是这次构建的标识，单元测试里没经构建是 dev：一致的那一项换成回 dev。
    const { api } = pageWith(expected === "same" ? () => ({ ok: true, value: { build: BUILD_ID } }) : reply);
    const calls: string[] = [];
    await startWhenCurrent(api, () => calls.push("start"), () => calls.push("stale"));
    assert.deepEqual(calls, [expected === "stale" ? "stale" : "start"], name);
  }
});
