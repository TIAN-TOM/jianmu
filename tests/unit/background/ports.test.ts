// 端口：连接走同一套发送方核对和启用闸门；连上以后两道机制各管一半，启用失效时断开已连的业务端口，
// 会发起读取或模型请求的消息每条再查一次启用。用一个造好的端口测，它的处理会调站点替身和模型替身。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../../src/background/app.ts";
import type { AnyPortSpec } from "../../../src/background/router.ts";
import type { MessageSender } from "../../../src/background/senders.ts";
import { SETTINGS_STORAGE_KEY } from "../../../src/shared/names.ts";
import {
  CONFIRMED,
  createFakeChrome,
  EXTENSION_ORIGIN,
  senders,
  STALE_CONFIRMATION,
  tubeUrl,
  watchedSender,
  type FakeChromeOptions,
  type FakePort,
} from "../../helpers/chrome.ts";
import { nextTurn } from "../../helpers/deferred.ts";
import { until } from "../../helpers/wait-until.ts";

interface Probe {
  connected: number;
  disconnected: number;
  readonly received: string[];
  /** 处理函数发起的站点读取和模型请求。 */
  site: number;
  model: number;
}

const isMessage = (value: unknown): value is { type: "go" | "ping" } =>
  typeof value === "object" && value !== null && ["go", "ping"].includes((value as { type?: unknown }).type as string);

function probePort(probe: Probe, senderKinds: AnyPortSpec["senders"] = ["panel"]): AnyPortSpec {
  return {
    senders: senderKinds,
    pages: ["options", "triage"],
    validate: isMessage,
    starts: (message: { type: string }) => message.type === "go",
    onConnect(port) {
      probe.connected += 1;
      return {
        onMessage(message: { type: string }) {
          probe.received.push(message.type);
          if (message.type === "go") {
            probe.site += 1;
            probe.model += 1;
          }
          port.post({ type: "ack", of: message.type } as never);
        },
        onDisconnect() {
          probe.disconnected += 1;
        },
      };
    },
  };
}

function setup(options: FakeChromeOptions = {}, senderKinds?: AnyPortSpec["senders"]) {
  const probe: Probe = { connected: 0, disconnected: 0, received: [], site: 0, model: 0 };
  const fake = createFakeChrome({ ports: { probe: probePort(probe, senderKinds) }, ...options });
  const app = createApp(fake.deps({ warn() {}, error() {} }));
  fake.chrome.runtime.onConnect.addListener(((port: FakePort) => app.connect(port as never)) as never);
  fake.chrome.storage.onChanged.addListener(((changes: never, area: string) => void app.onStorageChanged(changes, area)) as never);
  return { fake, app, probe };
}

const confirmed = () => ({ local: { [SETTINGS_STORAGE_KEY]: CONFIRMED } });

async function opened(fake: ReturnType<typeof setup>["fake"], probe: Probe, sender: MessageSender = senders.panel()): Promise<FakePort> {
  const port = fake.connect("probe", sender);
  assert.ok(await until(() => probe.connected === 1), "连上了");
  return port;
}

for (const [state, local] of [
  ["从没确认", {}],
  ["确认过期（存着旧指纹）", { [SETTINGS_STORAGE_KEY]: STALE_CONFIRMATION }],
] as const) {
  test(`${state}：侧边栏连业务端口，回一条还没启用再断开，处理一次都没被调`, async () => {
    const { fake, probe } = setup({ local: structuredClone(local) });
    const port = fake.connect("probe", senders.panel());
    assert.equal(port.send({ type: "go" }), true, "连上的那一刻页面就发了消息");
    assert.ok(await until(() => port.disconnected));
    assert.deepEqual(port.posted, [{ type: "port.error", code: "NOT_ENABLED" }]);
    assert.deepEqual(probe, { connected: 0, disconnected: 0, received: [], site: 0, model: 0 });
  });

  test(`${state}：遍历发送方连端口、发消息，不读标签页地址和标题、不读内容脚本的地址、不查标签页、不解析地址`, async () => {
    const all: [string, () => MessageSender][] = [
      ["侧边栏", senders.panel],
      ["设置页", () => senders.options()],
      ["粗筛页", () => senders.triage()],
      ["其他扩展页面", () => senders.otherPage()],
      ["卡片", () => senders.card()],
      ["一个站的内容脚本", () => senders.content()],
      ["另一个站的内容脚本", () => senders.content(tubeUrl())],
      ["别的扩展", senders.foreign],
    ];
    for (const [label, make] of all) {
      for (const name of ["probe", "translate", "unknown"]) {
        const { fake, probe } = setup({ local: structuredClone(local) }, ["panel", "page", "card", "content:bilibili", "content:youtube"]);
        const reads: string[] = [];
        const sender = make();
        const port = fake.connect(name, watchedSender(sender, reads, fake.confirmedNow));
        port.send({ type: "go" });
        port.send({ type: "ping" });
        await until(() => port.disconnected);
        await nextTurn();

        const where = `${label} → ${name}`;
        assert.equal(port.disconnected, true, where);
        assert.deepEqual(reads.filter((read) => ["tab.url", "tab.pendingUrl", "tab.title"].includes(read)), [], where);
        if (sender.origin !== EXTENSION_ORIGIN) assert.equal(reads.includes("sender.url"), false, `${where}：内容脚本的地址`);
        assert.deepEqual(fake.calls.tabQueries, [], where);
        assert.deepEqual(fake.calls.tabGets, [], where);
        assert.deepEqual(fake.calls.siteParses, [], where);
        assert.equal(probe.site + probe.model, 0, where);
      }
    }
  });
}

test("不在端口表里的端口名、端口不收的发送方、认不出的发送方：当场断开，不回通知、不读存储", () => {
  const { fake, probe } = setup(confirmed());
  for (const [name, sender] of [
    ["unknown", senders.panel()],
    ["toString", senders.panel()],
    ["probe", senders.options()],
    ["probe", senders.card()],
    ["probe", senders.content()],
    ["probe", senders.foreign()],
    ["probe", senders.stray()],
  ] as const) {
    const port = fake.connect(name, sender);
    assert.equal(port.disconnected, true, `${name}：同步断开`);
    assert.deepEqual(port.posted, [], name);
  }
  assert.deepEqual(fake.calls.storageReads, []);
  assert.equal(probe.connected, 0);
});

test("确认以后连上：每条消息先核对形状，不对的回请求不对、不交给处理；对的按到达顺序交给处理", async () => {
  const { fake, probe } = setup(confirmed());
  const port = fake.connect("probe", senders.panel());
  port.send({ type: "ping" });
  port.send({ type: "nope" });
  port.send("go");
  port.send({ type: "go" });
  assert.ok(await until(() => probe.received.length === 2));
  assert.deepEqual(probe.received, ["ping", "go"]);
  assert.deepEqual(port.posted, [
    { type: "ack", of: "ping" },
    { type: "port.error", code: "INVALID_REQUEST" },
    { type: "port.error", code: "INVALID_REQUEST" },
    { type: "ack", of: "go" },
  ]);
  assert.equal(port.disconnected, false);
});

test("已确认连着的端口，启用失效（清除全部删掉了启用确认）：页面收到还没启用、端口被断开；再发命令，站点和模型零新增请求", async () => {
  const { fake, probe } = setup(confirmed());
  const port = await opened(fake, probe);
  port.send({ type: "go" });
  assert.ok(await until(() => probe.site === 1));
  const before = { site: probe.site, model: probe.model };

  await fake.local.remove(SETTINGS_STORAGE_KEY);
  assert.ok(await until(() => port.disconnected), "页面什么都没发，存储一变就断开了");
  assert.deepEqual(port.posted.at(-1), { type: "port.error", code: "NOT_ENABLED" });
  assert.ok(await until(() => probe.disconnected === 1), "处理方也收了尾");

  assert.equal(port.send({ type: "go" }), false, "断开的端口发不出去");
  await nextTurn();
  assert.deepEqual({ site: probe.site, model: probe.model }, before);
});

test("存储已经变了、断开还没执行时到的发起工作的消息：逐条重查启用，拦下并断开，站点和模型零请求", async () => {
  const { fake, probe } = setup(confirmed());
  const port = await opened(fake, probe);

  // 只改存储、先不派发存储变化：这一轮里只有逐条重查拦得住。
  delete fake.local.data[SETTINGS_STORAGE_KEY];
  port.send({ type: "go" });
  assert.ok(await until(() => port.disconnected));
  assert.deepEqual(port.posted, [{ type: "port.error", code: "NOT_ENABLED" }]);
  assert.equal(probe.site + probe.model, 0);
  assert.deepEqual(probe.received, []);
});

test("页面断开：处理方收到断开，之后到的消息不再处理；启用失效时也不再给它发通知", async () => {
  const { fake, probe } = setup(confirmed());
  const port = await opened(fake, probe);
  port.close();
  assert.ok(await until(() => probe.disconnected === 1));
  await fake.local.remove(SETTINGS_STORAGE_KEY);
  await nextTurn();
  assert.deepEqual(port.posted, []);
  assert.deepEqual(probe.received, []);
});

test("启用状态读不出来：按后台出错断开，不当成没确认，也不交给处理", async () => {
  const fake = createFakeChrome(confirmed());
  const probe: Probe = { connected: 0, disconnected: 0, received: [], site: 0, model: 0 };
  const deps = fake.deps({ warn() {}, error() {} });
  const app = createApp({
    ...deps,
    ports: { probe: probePort(probe) },
    storage: { ...deps.storage, local: { ...deps.storage.local, get: async () => Promise.reject(new Error("存储读不出来")) } },
  });
  const port = fake.connect("probe", senders.panel());
  app.connect(port as never);
  assert.ok(await until(() => port.disconnected));
  assert.deepEqual(port.posted, [{ type: "port.error", code: "BACKGROUND_FAILED" }]);
  assert.equal(probe.connected, 0);
});
