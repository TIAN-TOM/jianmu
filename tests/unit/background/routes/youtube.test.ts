// YouTube 代开文字稿面板的路由：只转给那个标签页的内容脚本，回的结果按不可信输入核对；同一个标签页隔一会儿才放行下一次。
import assert from "node:assert/strict";
import { test } from "node:test";
import { OPEN_TRANSCRIPT_GAP_MS, youtubeRoutes } from "../../../../src/background/routes/youtube.ts";
import type { SenderCtx } from "../../../../src/background/senders.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";

const VIDEO = videoKey({ platform: "youtube", videoId: "jmSample0001" });
const PANEL: { sender: SenderCtx } = { sender: { kind: "panel" } };

function setup(answer: (tabId: number, message: unknown) => unknown) {
  let clock = 0;
  const asked: { tabId: number; message: unknown }[] = [];
  const routes = youtubeRoutes({
    tabs: {
      async ask(tabId, message) {
        asked.push({ tabId, message });
        return answer(tabId, message);
      },
    },
    now: () => clock,
  });
  const route = routes["youtube.openTranscript"];
  return { route, asked, wait: (ms: number) => void (clock += ms) };
}

test("只收侧边栏；请求要是 YouTube 视频加标签页编号，别的形状不收", () => {
  const { route } = setup(() => ({ outcome: "opened" }));
  assert.deepEqual(route.senders, ["panel"]);
  const ok = { video: VIDEO, tabId: 7 };
  assert.equal(route.validate(ok, PANEL.sender), true);
  for (const bad of [{ video: VIDEO }, { video: VIDEO, tabId: -1 }, { video: VIDEO, tabId: 7, extra: 1 }, { video: "bilibili:BV1Sample001:p1", tabId: 7 }]) {
    assert.equal(route.validate(bad as never, PANEL.sender), false, JSON.stringify(bad));
  }
});

test("转给那个标签页、只带视频编号；回的结果照交，认不出的、送不到的按连不上视频页", async () => {
  const { route, asked, wait } = setup((tabId) => {
    if (tabId === 9) throw new Error("Could not establish connection");
    if (tabId === 8) return { outcome: "click everything" };
    return { outcome: "opened" };
  });
  assert.deepEqual(await route.handler({ video: VIDEO, tabId: 7 }, PANEL), { ok: true, value: { outcome: "opened" } });
  assert.deepEqual(asked[0], { tabId: 7, message: { type: "youtube.openTranscript", req: { videoId: "jmSample0001" } } });
  wait(OPEN_TRANSCRIPT_GAP_MS);
  assert.deepEqual(await route.handler({ video: VIDEO, tabId: 8 }, PANEL), { ok: true, value: { outcome: "no-page" } });
  assert.deepEqual(await route.handler({ video: VIDEO, tabId: 9 }, PANEL), { ok: true, value: { outcome: "no-page" } });
});

test("同一个标签页连着来：隔够了才放行，不连点", async () => {
  const { route, asked, wait } = setup(() => ({ outcome: "not-opened" }));
  await route.handler({ video: VIDEO, tabId: 7 }, PANEL);
  assert.deepEqual(await route.handler({ video: VIDEO, tabId: 7 }, PANEL), { ok: false, code: "RATE_LIMITED", detail: "open-transcript" });
  assert.equal(asked.length, 1);
  wait(OPEN_TRANSCRIPT_GAP_MS);
  await route.handler({ video: VIDEO, tabId: 7 }, PANEL);
  assert.equal(asked.length, 2);
});
