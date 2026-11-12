// 侧边栏的本窗口全部生成：确认提示的说法、进度那一行，以及启用后接上这个窗口的一批、清点、确认、停止、重试、收起发出的消息。
import assert from "node:assert/strict";
import { test } from "node:test";
import { confirmText, createWindowBatch, progressText } from "../../../../src/pages/sidepanel/batch.ts";
import type { PortHandlers } from "../../../../src/pages/shared/api.ts";
import type { VideoKey } from "../../../../src/core/video-ref.ts";
import type { BatchIn, WindowCountItem, WindowRunView } from "../../../../src/shared/messages/batch.ts";
import { until } from "../../../helpers/wait-until.ts";

const video = (n: number) => `bilibili:BV1Sample00${n}:p1` as VideoKey;
const item = (n: number, state: WindowCountItem["state"]): WindowCountItem => ({ video: video(n), title: `视频 ${n}`, state });

test("确认提示写清本窗口几个视频、跳过几个、要新生成几个", () => {
  assert.equal(confirmText([]), "本窗口没有打开的 B 站视频。");
  assert.equal(confirmText([item(1, "to-generate"), item(2, "to-generate")]), "本窗口有 2 个视频，要新生成 2 个。");
  assert.equal(confirmText([item(1, "existing"), item(2, "to-generate")]), "本窗口有 2 个视频，跳过 1 个已有概览的，要新生成 1 个。");
  assert.equal(
    confirmText([item(1, "existing"), item(2, "running"), item(3, "to-generate")]),
    "本窗口有 3 个视频，跳过 2 个（1 个已有概览、1 个正在生成），要新生成 1 个。",
  );
  assert.equal(confirmText([item(1, "existing")]), "本窗口有 1 个视频，1 个已有概览，没有要新生成的。");
});

test("进度那一行：完成数、失败、停掉、跳过，整批提前停下时说原因", () => {
  const run: WindowRunView = {
    stopping: false,
    entries: [
      { video: video(1), title: "一", status: "completed" },
      { video: video(2), title: "二", status: "failed", failure: { code: "NO_CAPTIONS" } },
      { video: video(3), title: "三", status: "canceled" },
      { video: video(4), title: "四", status: "skipped" },
    ],
  };
  assert.equal(progressText(run), "本窗口：已完成 1 / 3，失败 1，已停止 1，跳过 1");
  assert.match(progressText({ ...run, stop: "rate-limited" }), /被 B 站限流/);
});

/** 读现在的阶段；不让断言把类型收窄，后面还要再读。 */
const phaseOf = (store: ReturnType<typeof createWindowBatch>): string => store.state.value.phase;

function fakeApi() {
  const posted: BatchIn[] = [];
  let handlers: PortHandlers<"batch"> | null = null;
  let open = false;
  const api = {
    connect(_name: "batch", next: PortHandlers<"batch">) {
      handlers = next;
      open = true;
      return {
        post: (message: BatchIn) => (open ? (posted.push(message), true) : false),
        close: () => void (open = false),
        isOpen: () => open,
      };
    },
  };
  return { api, posted, emit: (event: Parameters<PortHandlers<"batch">["onEvent"]>[0]) => handlers?.onEvent(event), drop: () => ((open = false), handlers?.onClose?.("BACKGROUND_DROPPED")) };
}

test("启用以后接上这个窗口的一批；清点、确认、全部停止、重试、收起都带窗口号", async () => {
  const fake = fakeApi();
  const store = createWindowBatch({ api: fake.api as never, windowId: async () => 7 });
  store.count();
  assert.equal(fake.posted.length, 0, "没启用时什么都不发");

  store.setEnabled(true);
  assert.ok(await until(() => fake.posted.length === 1));
  assert.deepEqual(fake.posted[0], { type: "window.watch", windowId: 7 });
  fake.emit({ type: "window.state", windowId: 7, run: null });
  assert.equal(phaseOf(store), "idle");

  store.count();
  assert.equal(phaseOf(store), "counting");
  fake.emit({ type: "window.counted", windowId: 8, items: [item(1, "to-generate")] });
  assert.equal(phaseOf(store), "counting", "别的窗口的清点不收");
  fake.emit({ type: "window.counted", windowId: 7, items: [item(1, "to-generate")] });
  assert.equal(phaseOf(store), "confirm");

  store.confirm();
  const running: WindowRunView = { stopping: false, entries: [{ video: video(1), title: "一", status: "running", taskId: "t1" }] };
  fake.emit({ type: "window.state", windowId: 7, run: running });
  assert.equal(phaseOf(store), "active");
  store.dismiss();
  assert.equal(phaseOf(store), "active", "还在生成时收不起来");
  store.stopAll();
  fake.emit({ type: "window.state", windowId: 7, run: { stopping: false, entries: [{ video: video(1), title: "一", status: "canceled" }] } });
  store.retry(video(1));
  store.dismiss();
  assert.equal(phaseOf(store), "idle");
  assert.deepEqual(
    fake.posted.map((message) => message.type),
    ["window.watch", "window.count", "window.start", "window.stop", "window.retry", "window.dismiss"],
  );
  assert.ok(fake.posted.every((message) => "windowId" in message && message.windowId === 7));
});

test("后台拒了确认时回到空闲并说原因；连接断了时说一句，回到能重新开始的样子", async () => {
  const fake = fakeApi();
  const store = createWindowBatch({ api: fake.api as never, windowId: async () => 7 });
  store.setEnabled(true);
  assert.ok(await until(() => fake.posted.length === 1));
  store.count();
  fake.emit({ type: "window.counted", windowId: 7, items: [item(1, "to-generate")] });
  store.confirm();
  fake.emit({ type: "window.refused", windowId: 7, failure: { code: "NO_AI_CONFIG" } });
  assert.equal(phaseOf(store), "idle");
  assert.match(store.error.value, /AI 服务/);

  fake.emit({ type: "window.state", windowId: 7, run: { stopping: false, entries: [{ video: video(1), title: "一", status: "running" }] } });
  fake.drop();
  assert.equal(phaseOf(store), "idle");
  assert.match(store.error.value, /连接断了/);
});
