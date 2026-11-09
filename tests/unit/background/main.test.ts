// 后台入口：模块加载时不碰存储，全部顶层监听都先过醒来钩子，醒来后第一个事件把本机存储限制成只给扩展页面用。
// 每条测试按新的模块地址加载一遍入口，等于一次新的醒来；浏览器接口全用替身。
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import "../../helpers/prompt-modules.ts";
import { STORAGE_PLAN } from "../../../src/shared/storage-plan.ts";
import { STORAGE_KEYS } from "../../../src/shared/names.ts";
import { createFakeChrome, senders, type FakeChrome, type FakeChromeOptions } from "../../helpers/chrome.ts";
import { until } from "../../helpers/wait-until.ts";

let loads = 0;

/** 装上替身再加载入口，和浏览器启动后台一样：顶层代码跑一遍，注册监听。 */
async function boot(t: TestContext, options: FakeChromeOptions = {}): Promise<FakeChrome> {
  const fake = createFakeChrome(options);
  Object.defineProperty(globalThis, "chrome", { value: fake.chrome, configurable: true });
  t.after(() => {
    Reflect.deleteProperty(globalThis, "chrome");
  });
  loads += 1;
  await import(new URL(`../../../src/background/main.ts?wake=${loads}`, import.meta.url).href);
  return fake;
}

/** 截下这条测试里的警告和报错。 */
function captureConsole(t: TestContext) {
  const lines: string[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    t.mock.method(console, level, (...args: unknown[]) => {
      lines.push(args.map((arg) => (arg instanceof Error ? `${arg.name} ${arg.message} ${String(arg.cause)}` : String(arg))).join(" "));
    });
  }
  return lines;
}

test("service worker 启动时不读存储；笔记、概览和备份只走 IndexedDB，不碰 storage.local 里的旧键", async (t) => {
  // 本机存储里别的键（比如开发时留下的旧数据）原样留着，后台不读也不改。
  const leftovers = { legacy_notes: [{ id: "old", text: "旧笔记" }], legacy_meta: { schemaVersion: 2 } };
  const opened: unknown[] = [];
  Object.defineProperty(globalThis, "indexedDB", { value: { open: (...args: unknown[]) => opened.push(args) }, configurable: true });
  t.after(() => {
    Reflect.deleteProperty(globalThis, "indexedDB");
  });
  const fake = await boot(t, { local: { ...leftovers } });

  assert.deepEqual(fake.calls.storageReads, [], "顶层的异步调用没有保活，后台会被回收打断");
  assert.deepEqual(opened, [], "加载时也不开数据库");

  fake.fireInstalled();
  fake.fireStartup();
  await fake.send({ type: "activation.get", req: {} }, senders.panel());
  await fake.send({ type: "appearance.get", req: {} }, senders.panel());
  await fake.send({ type: "activation.confirm", req: {} }, senders.options());

  const known = new Set<unknown>(STORAGE_KEYS);
  for (const { keys } of fake.calls.storageReads) {
    assert.notEqual(keys, null, "不读整份存储");
    assert.notEqual(keys, undefined, "不读整份存储");
    for (const key of [keys].flat()) assert.ok(known.has(key), `只读登记过的键，读了 ${String(key)}`);
  }
  for (const [key, value] of Object.entries(leftovers)) assert.deepEqual(fake.local.data[key], value, `${key} 原样留着`);
  assert.deepEqual(opened, [], "这几个事件用不到数据库");

  // 进备份的只有数据库里的仓库，本机存储里没有一份笔记、概览或问答。
  const backedUp = Object.entries(STORAGE_PLAN).filter(([, plan]) => plan.backup);
  assert.deepEqual(backedUp.map(([name]) => name).sort(), ["notes", "overviews", "qa"]);
  for (const [name, plan] of backedUp) assert.equal(plan.area, "indexeddb", name);
});

test("存储只对扩展页面开放：worker 醒来后第一个消息就设上，设失败了下个消息再试，设成功后不再重复", async (t) => {
  let failNext = true;
  const fake = await boot(t, {
    async setAccessLevel() {
      if (failNext) {
        failNext = false;
        throw new Error("Access level could not be set");
      }
    },
  });
  const lines = captureConsole(t);

  await fake.send({ type: "appearance.get", req: {} }, senders.panel());
  assert.ok(await until(() => lines.length === 1), "第一次没设上，记了一条");
  await fake.send({ type: "appearance.get", req: {} }, senders.panel());
  assert.ok(await until(() => fake.calls.accessLevels.length === 2), "下一个消息再试了一次");
  await fake.send({ type: "appearance.get", req: {} }, senders.panel());
  await fake.send({ type: "activation.get", req: {} }, senders.options());

  assert.deepEqual(fake.calls.accessLevels, [{ accessLevel: "TRUSTED_CONTEXTS" }, { accessLevel: "TRUSTED_CONTEXTS" }]);
  assert.equal(lines.length, 1);
});

test("醒来后第一个事件是端口连接、浏览器启动、安装、标签页关闭或存储变化时，也照样设上访问限制", async (t) => {
  const firsts: readonly [string, (fake: FakeChrome) => void][] = [
    ["端口连接", (fake) => void fake.connect("translate", senders.panel())],
    ["浏览器启动", (fake) => fake.fireStartup()],
    ["安装", (fake) => fake.fireInstalled()],
    ["标签页关闭", (fake) => fake.fireTabRemoved(9)],
    ["存储变化", (fake) => fake.fireStorageChanged({ other: { newValue: 1 } }, "local")],
  ];
  for (const [label, first] of firsts) {
    const fake = await boot(t);
    first(fake);
    assert.deepEqual(fake.calls.accessLevels, [{ accessLevel: "TRUSTED_CONTEXTS" }], label);
  }
});

test("设访问限制失败记的日志只有哪一步失败和异常类别，说明里夹着的密钥不进日志", async (t) => {
  const secret = "sk-SAMPLE-SECRET-IN-LOG";
  const fake = await boot(t, {
    async setAccessLevel() {
      throw new Error(`refused ${secret}`, { cause: { aiApiKey: secret } });
    },
  });
  const lines = captureConsole(t);

  fake.fireStartup();
  assert.ok(await until(() => lines.length >= 1));
  assert.equal(lines.some((line) => line.includes(secret)), false, lines.join("\n"));
});

test("安装、更新和浏览器启动只设工具栏图标打开侧边栏，不打开设置页", async (t) => {
  const fake = await boot(t, { manifest: { options_page: "pages/options.html" } });

  fake.fireInstalled("install");
  fake.fireInstalled("update");
  fake.fireStartup();

  assert.ok(await until(() => fake.calls.panelBehaviors.length === 3));
  for (const behavior of fake.calls.panelBehaviors) assert.deepEqual(behavior, { openPanelOnActionClick: true });
  assert.equal(fake.calls.optionsOpened, 0);
});

test("端口表里没有的端口、端口不收的发送方，连上就断开，后台不读存储", async (t) => {
  const fake = await boot(t);
  for (const sender of [senders.panel(), senders.triage(), senders.content(), senders.foreign()]) {
    for (const name of ["translate", "batch", "unknown"]) {
      // 翻译端口收侧边栏：它要先过启用闸门，另有测试。
      if (name === "translate" && sender.url === senders.panel().url) continue;
      assert.equal(fake.connect(name, sender).disconnected, true, name);
    }
  }
  assert.deepEqual(fake.calls.storageReads, []);
});
