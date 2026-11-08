// 扩展页面的消息客户端：断线时只有幂等的请求重试一次，写操作和花钱的请求不重发；够不着后台、半路断开各给中文说明，
// 不显示浏览器的英文原文；后台的拒绝原样交出去。广播只收后台发的、形状对的，按任务号、视频键、标签页号过滤；长连接的收发和断开。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoutes } from "../../../../src/background/routes/index.ts";
import { describe as describeError, isErrorCode, type ErrorCode } from "../../../../src/core/errors.ts";
import { TRANSCRIPT_ERROR_TEXT } from "../../../../src/core/errors/transcript.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";
import { createPageApi, IDEMPOTENT_ROUTES, RETRY_DELAY_MS, type PageApi } from "../../../../src/pages/shared/api.ts";
import { stateCopy } from "../../../../src/pages/shared/ui/state.ts";
import type { RouteName } from "../../../../src/shared/messages.ts";
import { EXTENSION_ID, SAMPLE_VIDEO_ID } from "../../../helpers/chrome.ts";
import { BROWSER_ERRORS, fakeRuntime } from "../../../helpers/fake-runtime.ts";

const VIDEO = videoKey({ platform: "bilibili", videoId: SAMPLE_VIDEO_ID });
const OTHER_VIDEO = videoKey({ platform: "bilibili", videoId: SAMPLE_VIDEO_ID, segment: 2 });

function client() {
  const fake = fakeRuntime();
  const waits: number[] = [];
  const errors: unknown[] = [];
  const api = createPageApi({
    runtime: fake.runtime,
    sleep: async (ms) => void waits.push(ms),
    reportError: (error) => void errors.push(error),
  });
  return { fake, api, waits, errors };
}

const throwing = (message: string) => () => {
  throw new Error(message);
};

/** 失败的码；成功了就让测试失败。 */
function codeOf(reply: { readonly ok: boolean; readonly code?: ErrorCode }): ErrorCode {
  assert.equal(reply.ok, false, "应当失败");
  assert.ok(reply.code !== undefined);
  return reply.code;
}

function assertDroppedText(text: string): void {
  assert.match(text, /处理途中断开/);
  assert.match(text, /可能已经发给了模型/);
  assert.doesNotMatch(text, /没能发出去/, "后台已经收到了，不能说没发出去");
  assert.doesNotMatch(text, /message channel closed|message port closed/i, "不显示浏览器的英文原文");
}

function assertUnreachableText(text: string): void {
  assert.match(text, /没能发出去/);
  assert.match(text, /不会删除你的笔记和概览/);
  assert.doesNotMatch(text, /Receiving end|Could not establish/i, "浏览器的英文原文对用户没有指导意义");
}

/** 真实的路由表，依赖一概不碰：这里只读每条路由标没标幂等。 */
function realRouteTable() {
  const inert: unknown = new Proxy(() => inert, {
    get: (_target, key) => (key === "then" ? undefined : inert),
    apply: () => inert,
  });
  return createRoutes(inert as Parameters<typeof createRoutes>[0]);
}

const startOverview = (api: PageApi) => api.send("task.start", { kind: "overview", video: VIDEO });

test("后台唤醒空窗期发出的消息会自动重发", async () => {
  const { fake, api, waits } = client();
  fake.reply("task.list", (_req, attempt) => {
    if (attempt === 1) throw new Error(BROWSER_ERRORS.unreachable);
    return { ok: true, value: { tasks: [] } };
  });

  const reply = await api.send("task.list", {});

  assert.equal(fake.attempts("task.list"), 2);
  assert.deepEqual(reply, { ok: true, value: { tasks: [] } });
  assert.deepEqual(waits, [RETRY_DELAY_MS], "等后台醒过来再发第二次");
});

test("通道中断后写操作不重发，避免重复扣费或多存一条笔记", async () => {
  const { fake, api, waits } = client();
  const writes: [RouteName, unknown][] = [
    ["task.start", { kind: "overview", video: VIDEO }],
    ["task.cancel", { taskId: "t1" }],
    ["imports.add", { video: VIDEO }],
    ["activation.confirm", {}],
  ];
  for (const [type, req] of writes) {
    fake.reply(type, throwing(BROWSER_ERRORS.portClosed));
    const reply = await api.send(type, req as never);
    assert.equal(fake.attempts(type), 1, `${type}：通道断开只说明没收到回复，后台可能已经执行过了`);
    assert.equal(codeOf(reply), "BACKGROUND_DROPPED");
  }
  assert.deepEqual(waits, []);
});

test("通道中断后只读操作仍会重发", async () => {
  const { fake, api } = client();
  for (const type of IDEMPOTENT_ROUTES) {
    fake.reply(type, throwing(BROWSER_ERRORS.portClosed));
    const reply = await api.send(type, {} as never);
    assert.equal(fake.attempts(type), 2, `${type} 重发一次`);
    assert.equal(codeOf(reply), "BACKGROUND_DROPPED");
  }
});

test("业务错误原样抛出，不做无谓重试", async () => {
  const { fake, api } = client();
  // 后台当场拒绝（还没启用）和处理以后回的失败，都原样交出去，幂等的也不重试。
  const refusal = { ok: false, code: "NOT_ENABLED" };
  fake.reply("task.list", { value: refusal });
  assert.deepEqual(await api.send("task.list", {}), refusal);
  assert.equal(fake.attempts("task.list"), 1);

  const gone = { ok: false, code: "TASK_NOT_FOUND", detail: "finished" };
  fake.reply("task.cancel", { value: gone });
  assert.deepEqual(await api.send("task.cancel", { taskId: "t1" }), gone);
  assert.equal(fake.attempts("task.cancel"), 1);

  // 浏览器报的不是断线（比如消息本身发不出去）：不重试，也不把原文给用户看。
  fake.reply("config.check", throwing("这条笔记已经不存在了。"));
  const odd = await api.send("config.check", {});
  assert.equal(fake.attempts("config.check"), 1);
  assert.equal(codeOf(odd), "BACKGROUND_FAILED");
});

test("后台始终不可达时，不再把它伪装成字幕失败", async () => {
  const { fake, api } = client();
  fake.reply("transcript.get", throwing(BROWSER_ERRORS.unreachable));

  const reply = await api.send("transcript.get", { video: VIDEO, mode: "full" });

  assert.equal(fake.attempts("transcript.get"), 2);
  assert.deepEqual(reply, { ok: false, code: "BACKGROUND_UNREACHABLE" }, "浏览器的原文也不夹在结果里");
  const code = codeOf(reply);
  assert.equal(Object.hasOwn(TRANSCRIPT_ERROR_TEXT, code), false, "不是字幕那一类的码，页面不会摆登录、导入这些按钮");
  const { title } = stateCopy(code);
  assert.match(title, /扩展后台没有响应/);
  assert.match(title, /和视频网站的账号、模型服务的密钥和网络都无关/, "用户会照着提示去折腾密钥和网络，先把这条路堵死");
  assertUnreachableText(title);
});

test("后台无响应时先建议停用再启用；提到重装时先说怎么备份", () => {
  const text = describeError("BACKGROUND_UNREACHABLE");
  assert.match(text, /关闭再重新开启/);
  assert.match(text, /不会删除你的笔记和概览/);
  const backupAt = text.indexOf("导出备份");
  assert.ok(backupAt > 0, "要告诉用户怎么备份");
  assert.ok(backupAt < text.indexOf("卸载会清空"), "备份方法放在重装之前");
  assert.ok(text.indexOf("关闭再重新开启") < text.indexOf("卸载"), "先给不丢数据的办法");
});

test("侧边栏：新版 Chrome 的断线报错，只读请求重发，写操作不重发", async () => {
  const { fake, api } = client();
  fake.reply("task.list", throwing(BROWSER_ERRORS.channelClosed));
  assert.equal(codeOf(await api.send("task.list", {})), "BACKGROUND_DROPPED");
  assert.equal(fake.attempts("task.list"), 2);

  fake.reply("task.start", throwing(BROWSER_ERRORS.channelClosed));
  assert.equal(codeOf(await startOverview(api)), "BACKGROUND_DROPPED");
  assert.equal(fake.attempts("task.start"), 1, "生成概览重发一次就多花一次钱");
});

test("侧边栏：生成概览时断线，提示可能已经发给了模型，不显示英文原文", async () => {
  const { fake, api } = client();
  fake.reply("task.start", throwing(BROWSER_ERRORS.channelClosed));
  const code = codeOf(await startOverview(api));
  assertDroppedText(stateCopy(code).title);
});

test("侧边栏：取字幕一直断线时，错误页写中文标题和说明", async () => {
  const { fake, api } = client();
  fake.reply("transcript.get", throwing(BROWSER_ERRORS.channelClosed));
  const reply = await api.send("transcript.get", { video: VIDEO, mode: "full" });
  assert.equal(fake.attempts("transcript.get"), 2);
  assert.deepEqual(reply, { ok: false, code: "BACKGROUND_DROPPED" }, "浏览器的原文也不夹在结果里");
  const code = codeOf(reply);
  const { title } = stateCopy(code);
  assert.match(title, /^扩展后台在处理途中断开了/);
  assertDroppedText(title);
});

test("侧边栏：问答时断线，提示条写中文说明", async () => {
  // 提问、生成、保存这类会花钱或写东西的请求都不在幂等表里：路由表里每一条这样的路由断线都只发一次，提示条写中文。
  const { fake, api } = client();
  const writes = Object.keys(realRouteTable()).filter((name) => !IDEMPOTENT_ROUTES.has(name as RouteName)) as RouteName[];
  assert.ok(writes.length > 0);
  for (const type of writes) {
    fake.reply(type, throwing(BROWSER_ERRORS.channelClosed));
    const code = codeOf(await api.send(type, {} as never));
    assert.equal(fake.attempts(type), 1, type);
    assertDroppedText(describeError(code));
  }
});

test("侧边栏：根本没送到后台的，照旧说「没能发出去」，并给不丢数据的办法", async () => {
  const { fake, api } = client();
  fake.reply("task.start", throwing(BROWSER_ERRORS.unreachable));
  const code = codeOf(await startOverview(api));
  assert.equal(code, "BACKGROUND_UNREACHABLE");
  assert.equal(fake.attempts("task.start"), 1, "不是幂等的就不重试");
  assertUnreachableText(stateCopy(code).title);
});

test("卡片：生成概览时断线，状态行写中文说明，可能已经发给了模型", async () => {
  const { fake, api } = client();
  fake.reply("task.start", throwing(BROWSER_ERRORS.channelClosed));
  const code = codeOf(await startOverview(api));
  assert.equal(fake.attempts("task.start"), 1);
  assertDroppedText(describeError(code));
});

test("卡片：后台一直够不着时，说没能发出去，不显示英文原文", async () => {
  const { fake, api } = client();
  fake.reply("task.start", throwing(BROWSER_ERRORS.unreachable));
  const text = describeError(codeOf(await startOverview(api)));
  assert.match(text, /没能发出去/);
  assert.doesNotMatch(text, /Receiving end/);
});

test("断线时自动重试的路由，和后台路由表里标了幂等的一一对应", () => {
  const flagged = Object.entries(realRouteTable())
    .filter(([, route]) => route.idempotent === true)
    .map(([name]) => name)
    .sort();
  assert.deepEqual([...IDEMPOTENT_ROUTES].sort(), flagged);
});

test("页面已经和扩展断开（扩展重新加载过）：按没送到后台报，不显示英文原文", async () => {
  const { fake, api } = client();
  fake.reply("activation.get", throwing(BROWSER_ERRORS.invalidated));
  assert.equal(codeOf(await api.send("activation.get", {})), "BACKGROUND_UNREACHABLE");
  fake.reply("activation.confirm", throwing(BROWSER_ERRORS.invalidated));
  assert.equal(codeOf(await api.send("activation.confirm", {})), "BACKGROUND_UNREACHABLE");
  assert.equal(fake.attempts("activation.confirm"), 1);
});

test("后台回的不是结果形状、或者拒绝带着认不得的码：按后台出了问题，不重试", async () => {
  const { fake, api } = client();
  for (const raw of [undefined, null, "好", { ok: "yes" }, { ok: false, code: "NO_SUCH_CODE" }, { ok: false }]) {
    fake.reply("config.check", { value: raw });
    const before = fake.attempts("config.check");
    assert.equal(codeOf(await api.send("config.check", {})), "BACKGROUND_FAILED", JSON.stringify(raw));
    assert.equal(fake.attempts("config.check") - before, 1);
  }
  assert.equal(isErrorCode("NO_SUCH_CODE"), false);
});

test("第一次发送在调用当下同步发出，保住用户手势", () => {
  const { fake, api } = client();
  fake.reply("panel.open", { value: { ok: true, value: { opened: true } } });
  void api.send("panel.open", {});
  assert.equal(fake.attempts("panel.open"), 1, "调用返回之前已经发出去了");
});

test("广播只收本扩展后台发的、形状对的；不替后台占着通道，也不理别的页面发给后台的请求", () => {
  const { fake, api } = client();
  const seen: unknown[] = [];
  api.on("activation.changed", (message) => void seen.push(message));

  fake.broadcast({ type: "activation.changed", confirmed: true });
  fake.broadcast({ type: "activation.changed", confirmed: false }, { id: EXTENSION_ID, tab: { id: 7 } });
  fake.broadcast({ type: "activation.changed", confirmed: false }, { id: "someoneelse" });
  fake.broadcast({ type: "activation.changed", confirmed: false }, {});
  fake.broadcast({ type: "activation.changed", confirmed: "yes" });
  fake.broadcast({ type: "activation.get", req: {} });
  fake.broadcast({ type: "toString" });
  fake.broadcast(null);

  assert.deepEqual(seen, [{ type: "activation.changed", confirmed: true }]);
  assert.ok(fake.listenerResults.every((result) => result === undefined), "页面的监听一律不回复");
});

test("广播按任务号、视频键、标签页号过滤；不带视频的笔记变化发给所有按视频订阅的", () => {
  const { fake, api } = client();
  const got: string[] = [];
  const task = (id: string, video: string) => ({
    type: "task.changed",
    task: { id, kind: "overview", origin: "panel", video, state: "running", done: 0, total: 1, phase: "", message: "", createdAt: 0, updatedAt: 0 },
  });
  api.on("task.changed", ({ task: { id } }) => void got.push(`任务号 ${id}`), { taskId: "t1" });
  api.on("task.changed", ({ task: { id } }) => void got.push(`视频 ${id}`), { video: VIDEO });
  api.on("overview.updated", () => void got.push("概览"), { video: VIDEO });
  api.on("notes.changed", ({ video }) => void got.push(`笔记 ${video ?? "全部"}`), { video: VIDEO });
  api.on("session.changed", ({ tabId }) => void got.push(`会话 ${tabId}`), { tabId: 3 });
  api.on("data.cleared", ({ scope }) => void got.push(`清除 ${scope}`));

  fake.broadcast(task("t1", OTHER_VIDEO));
  fake.broadcast(task("t2", VIDEO));
  fake.broadcast(task("t3", OTHER_VIDEO));
  fake.broadcast({ type: "overview.updated", video: OTHER_VIDEO, verdictPending: false });
  fake.broadcast({ type: "overview.updated", video: VIDEO, verdictPending: false });
  fake.broadcast({ type: "overview.updated", verdictPending: false });
  fake.broadcast({ type: "notes.changed", video: OTHER_VIDEO });
  fake.broadcast({ type: "notes.changed" });
  fake.broadcast({ type: "session.changed", tabId: 4, session: {} });
  fake.broadcast({ type: "session.changed", tabId: 3, session: {} });
  fake.broadcast({ type: "data.cleared", scope: "all" });

  assert.deepEqual(got, ["任务号 t1", "视频 t2", "概览", "笔记 全部", "会话 3", "清除 all"]);
});

test("退订和停止以后不再收广播；一个订阅方出错不挡别的订阅方", () => {
  const { fake, api, errors } = client();
  const got: string[] = [];
  const off = api.on("data.cleared", () => void got.push("一"));
  api.on("data.cleared", () => {
    throw new Error("订阅方自己的错");
  });
  api.on("data.cleared", () => void got.push("三"));
  fake.broadcast({ type: "data.cleared", scope: "cache" });
  assert.deepEqual(got, ["一", "三"]);
  assert.equal(errors.length, 1, "错误照样报出来");

  off();
  fake.broadcast({ type: "data.cleared", scope: "cache" });
  assert.deepEqual(got, ["一", "三", "三"]);

  api.stop();
  assert.equal(fake.listeners(), 0);
  fake.broadcast({ type: "data.cleared", scope: "cache" });
  assert.deepEqual(got, ["一", "三", "三"]);
});

test("长连接：收发消息；后台说了原因再断开时带上原因，没说就按中途断开；页面自己关掉不回调", () => {
  const { fake, api } = client();
  const events: unknown[] = [];
  const closed: ErrorCode[] = [];
  const port = api.connect("batch", { onEvent: (event) => void events.push(event), onClose: (code) => void closed.push(code) });
  const [raw] = fake.ports;
  assert.ok(raw);
  assert.equal(raw.name, "batch");

  assert.equal(port.post({ type: "start" } as never), true);
  assert.deepEqual(raw.posted, [{ type: "start" }]);
  raw.push({ type: "progress", done: 1 });
  raw.push({ type: "port.error", code: "NOT_ENABLED" });
  raw.push("不是消息");
  raw.drop("Could not establish connection. Receiving end does not exist.");
  assert.deepEqual(events, [{ type: "progress", done: 1 }, { type: "port.error", code: "NOT_ENABLED" }]);
  assert.deepEqual(closed, ["NOT_ENABLED"]);
  assert.equal(port.isOpen(), false);
  assert.equal(port.post({ type: "start" } as never), false, "断开以后发不出去");

  // 后台被浏览器收掉，没来得及说原因；后台拒收一条以后又照常回了消息的，也不算原因。
  const second = api.connect("translate", { onEvent: () => {}, onClose: (code) => void closed.push(code) });
  const secondRaw = fake.ports[1];
  secondRaw?.push({ type: "port.error", code: "INVALID_REQUEST" });
  secondRaw?.push({ type: "progress" });
  secondRaw?.drop();
  assert.deepEqual(closed, ["NOT_ENABLED", "BACKGROUND_DROPPED"]);
  assert.equal(second.isOpen(), false);

  // 认不得的码按后台出了问题。
  api.connect("batch", { onEvent: (event) => void events.push(event), onClose: (code) => void closed.push(code) });
  fake.ports[2]?.push({ type: "port.error", code: "NO_SUCH_CODE" });
  fake.ports[2]?.drop();
  assert.deepEqual(events.at(-1), { type: "port.error", code: "BACKGROUND_FAILED" });
  assert.deepEqual(closed.at(-1), "BACKGROUND_FAILED");

  const own = api.connect("batch", { onEvent: () => {}, onClose: (code) => void closed.push(code) });
  own.close();
  assert.equal(fake.ports[3]?.closedByPage, true);
  fake.ports[3]?.drop();
  assert.equal(closed.length, 3, "页面自己关的不回调");
});

test("长连接：连不上时按没送到后台回调一次；页面停止时关掉还开着的", async () => {
  const fake = fakeRuntime({ connectThrows: BROWSER_ERRORS.invalidated });
  const api = createPageApi({ runtime: fake.runtime, sleep: async () => {} });
  const closed: ErrorCode[] = [];
  const port = api.connect("batch", { onEvent: () => {}, onClose: (code) => void closed.push(code) });
  assert.equal(port.post({} as never), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(closed, ["BACKGROUND_UNREACHABLE"]);

  const { fake: live, api: liveApi } = client();
  const kept = liveApi.connect("translate", { onEvent: () => {}, onClose: (code) => void closed.push(code) });
  liveApi.stop();
  assert.equal(live.ports[0]?.closedByPage, true);
  assert.equal(kept.isOpen(), false);
  assert.deepEqual(closed, ["BACKGROUND_UNREACHABLE"], "页面自己停的不回调");
});
