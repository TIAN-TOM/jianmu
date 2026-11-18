// 解释当前画面：先查配置和看图能力（不能看图不截、不发），再向标签页要当前一帧并核对，登记任务，
// 图在前、提示词在后发给画面分析的模型。截帧的拒绝各报各的码；结果按标签页记在内存里，每一步都广播。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkCapture,
  createFrameExplainService,
  FRAME_LIMIT,
  FRAME_MAX_CHARS,
  FRAME_WINDOW_MS,
  frameContext,
  KEEP_MS,
  PREFLIGHT_KEEPALIVE_MS,
} from "../../../../src/background/services/frame-explain.ts";
import { createTaskRunner } from "../../../../src/background/tasks.ts";
import { createClearGuard } from "../../../../src/core/clear-guard.ts";
import { DATA_CONSENT_ERROR } from "../../../../src/core/consent.ts";
import { fail, ok, type Result } from "../../../../src/core/errors.ts";
import { createKeepAlive } from "../../../../src/platform/keepalive.ts";
import type { Broadcast } from "../../../../src/shared/messages.ts";
import type { FrameEntryView } from "../../../../src/shared/messages/frame.ts";
import { createFakeAi, type FakeAiOptions } from "../../../helpers/fake-ai.ts";
import { manualTimers } from "../../../helpers/manual-timers.ts";
import { memoryStorage } from "../../../helpers/memory-storage.ts";
import { cue, OTHER, START, transcriptView, VIDEO } from "../../../helpers/study-service.ts";
import { until } from "../../../helpers/wait-until.ts";
import { FRAME_RESULTS_KEY } from "../../../../src/shared/names.ts";

const PROMPT = ["## 系统提示词", "```", "画面/系统", "```", "## 用户提示词", "```", "视频：{videoTitle}", "时间：{frameTime}", "字幕：", "{transcriptContext}", "```", ""].join("\n");
const JPEG = `data:image/jpeg;base64,${"A".repeat(400)}`;
const TAB = 7;

const captured = (extra: Record<string, unknown> = {}) => ({ ok: true, value: { dataUrl: JPEG, width: 1456, height: 819, atSec: 83.4, video: VIDEO, ...extra } });

interface Options {
  readonly ai?: FakeAiOptions;
  readonly image?: Result<{ readonly imageInput: boolean }>;
  readonly reply?: unknown;
  readonly transcript?: "no-captions" | "paid" | "signed-out" | "throws";
  /** 复核探测的结果。 */
  readonly probe?: Result<{ readonly imageInput: boolean }>;
  readonly session?: Record<string, unknown>;
  /** 截帧时同步做一件事：比如清除本机数据。 */
  readonly duringCapture?: () => Promise<void>;
}

function setup(options: Options = {}) {
  const timers = manualTimers(START);
  const fake = createFakeAi({ prompts: { "study/frame-explain.md": PROMPT }, replies: { frame: "幻灯片上写着 F = ma。" }, ...options.ai });
  const keepAlive = createKeepAlive({ ping: () => undefined, now: timers.now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  let ids = 0;
  const broadcasts: Broadcast[] = [];
  const clearGuard = createClearGuard();
  const tasks = createTaskRunner({ ai: fake.ai, keepAlive, timers, broadcast: () => undefined, newId: () => `task-${(ids += 1)}` });
  const asked: unknown[] = [];
  const probed: string[] = [];
  const session = memoryStorage(options.session ?? {});
  let ensured = 0;
  const held: number[] = [];
  let released = 0;
  const service = createFrameExplainService({
    tasks,
    ai: fake.ai,
    images: {
      ensure: async () => {
        ensured += 1;
        return options.image ?? ok({ imageInput: true });
      },
      probe: async (gen) => {
        probed.push(gen.model);
        return options.probe ?? ok({ imageInput: true });
      },
    },
    transcript: {
      // 每次都向平台重新读视频信息：付费、没登录的在这一步拒。
      verify: async () => {
        if (options.transcript === "paid") return fail("UNPLAYABLE", "paid");
        if (options.transcript === "signed-out") return fail("NEED_LOGIN");
        return ok({ title: options.transcript === "no-captions" ? "没有字幕的视频" : "力学入门", author: "", description: "", durationSec: 300 });
      },
      get: async (_ref, { mode }) => {
        assert.equal(mode, "full");
        if (options.transcript === "throws") throw new Error("读不到");
        if (options.transcript === "no-captions") return fail("NO_CAPTIONS");
        return ok(transcriptView(VIDEO, [cue(10, "很早的一句"), cue(70, "先看受力"), cue(80, "牛顿第二定律"), cue(90, "加速度和力成正比"), cue(200, "很晚的一句")], { title: "缓存里的标题" }));
      },
    },
    clearGuard,
    session,
    keepAlive: {
      during: async (budgetMs, work) => {
        held.push(budgetMs);
        try {
          return await work();
        } finally {
          released += 1;
        }
      },
    },
    ask: async (tabId, message) => {
      asked.push({ tabId, message });
      await options.duringCapture?.();
      if (options.reply instanceof Error) throw options.reply;
      return options.reply === undefined ? captured() : options.reply;
    },
    prompt: (file) => fake.ai.prompt(file),
    broadcast: (message) => void broadcasts.push(message),
    log: { warn() {}, error() {} },
    now: timers.now,
    newId: () => `entry-${(ids += 1)}`,
  });
  const run = async (video = VIDEO): Promise<FrameEntryView> => {
    const entry = await service.start(TAB, video);
    await service.settled(entry.id);
    const latest = (await service.recent(TAB)).find((item) => item.id === entry.id);
    assert.ok(latest);
    return latest;
  };
  return { fake, service, asked, broadcasts, probed, timers, run, clearGuard, session, ensured: () => ensured, held, released: () => released };
}

test("能看图：向标签页要一帧，图在前、提示词在后发给画面分析的模型；结果记下，带时间和尺寸", async () => {
  const { fake, asked, broadcasts, run, service } = setup();
  const entry = await run();
  assert.equal(entry.state, "done", JSON.stringify(entry));
  assert.equal(entry.explanation, "幻灯片上写着 F = ma。");
  assert.deepEqual([entry.atSec, entry.width, entry.height], [83.4, 1456, 819]);
  assert.deepEqual(asked, [{ tabId: TAB, message: { type: "player.captureFrame", req: { video: VIDEO, maxEdge: 1456 } } }]);

  assert.equal(fake.calls.length, 1);
  const call = fake.calls[0];
  assert.equal(call?.feature, "frame");
  const [system, user] = call?.request.messages ?? [];
  assert.equal(system?.content, "画面/系统");
  const parts = user?.content as readonly { readonly type: string; readonly dataUrl?: string; readonly text?: string }[];
  assert.deepEqual(parts.map((part) => part.type), ["image", "text"]);
  assert.equal(parts[0]?.dataUrl, JPEG);
  assert.equal(parts[1]?.text, "视频：力学入门\n时间：1:23\n字幕：\n1:10 先看受力\n1:20 牛顿第二定律\n1:30 加速度和力成正比");

  assert.ok(broadcasts.length >= 3 && broadcasts.every((message) => message.type === "frame.changed" && message.tabId === TAB));
  assert.deepEqual(await service.recent(8), [], "别的标签页看不到");
});

test("配置没好、没同意数据说明、模型不能看图：都不截、不发", async () => {
  const unset = setup({ ai: { config: { ready: false, errors: ["请先填写 API 密钥。"] } } });
  const first = await unset.run();
  assert.deepEqual([first.state, first.error?.code], ["failed", "NO_AI_CONFIG"]);
  assert.equal(unset.ensured(), 0);

  const consent = setup({ ai: { config: { ready: false, errors: [DATA_CONSENT_ERROR] } } });
  assert.equal((await consent.run()).error?.code, "NO_DATA_CONSENT");

  const blind = setup({ image: ok({ imageInput: false }) });
  assert.equal((await blind.run()).error?.code, "AI_IMAGE_UNSUPPORTED");

  const offline = setup({ image: fail("AI_NETWORK_ERROR") });
  assert.equal((await offline.run()).error?.code, "AI_NETWORK_ERROR");

  for (const h of [unset, consent, blind, offline]) {
    assert.deepEqual(h.asked, [], "没向页面要画面");
    assert.equal(h.fake.calls.length, 0, "没发请求");
  }
});

test("截帧的拒绝各报各的码，都不发请求；页面没连上按没连上报", async () => {
  const cases: readonly [unknown, string][] = [
    [{ ok: false, code: "NO_VIDEO" }, "FRAME_NO_VIDEO"],
    [{ ok: false, code: "AD_PLAYING" }, "FRAME_AD_PLAYING"],
    [{ ok: false, code: "VIDEO_CHANGED" }, "FRAME_VIDEO_CHANGED"],
    [{ ok: false, code: "FRAME_NOT_READY" }, "FRAME_NOT_READY"],
    [{ ok: false, code: "PROTECTED" }, "FRAME_PROTECTED"],
    [{ ok: false, code: "CANVAS_TAINTED" }, "FRAME_UNREADABLE"],
    [{ ok: false, code: "NOT_FOREGROUND" }, "FRAME_NOT_FOREGROUND"],
    [{ ok: false, code: "SOMETHING" }, "FRAME_BAD_CAPTURE"],
    [undefined, "FRAME_UNREACHABLE"],
    [new Error("Could not establish connection"), "FRAME_UNREACHABLE"],
  ];
  for (const [reply, code] of cases) {
    const h = setup({ reply: reply === undefined ? null : reply });
    const entry = await h.run();
    assert.deepEqual([entry.state, entry.error?.code], ["failed", code], JSON.stringify(reply));
    assert.equal(h.fake.calls.length, 0);
  }
});

test("截图核对：前缀、大小、尺寸、播放时间和视频身份不对都不用", () => {
  assert.ok(checkCapture(captured(), VIDEO).ok);
  const bad: readonly [Record<string, unknown>, string][] = [
    [{ dataUrl: "data:image/png;base64,AAAA" }, "FRAME_BAD_CAPTURE"],
    [{ dataUrl: "data:image/jpeg;base64," }, "FRAME_BAD_CAPTURE"],
    [{ dataUrl: `data:image/jpeg;base64,${"A".repeat(FRAME_MAX_CHARS)}` }, "FRAME_BAD_CAPTURE"],
    [{ width: 0 }, "FRAME_BAD_CAPTURE"],
    [{ height: 5000 }, "FRAME_BAD_CAPTURE"],
    [{ width: 12.5 }, "FRAME_BAD_CAPTURE"],
    [{ atSec: -1 }, "FRAME_BAD_CAPTURE"],
    [{ atSec: Number.NaN }, "FRAME_BAD_CAPTURE"],
    [{ video: OTHER }, "FRAME_VIDEO_CHANGED"],
  ];
  for (const [extra, code] of bad) assert.deepEqual(checkCapture(captured(extra), VIDEO), { ok: false, code }, JSON.stringify(extra).slice(0, 80));
  assert.deepEqual(checkCapture({ ok: true }, VIDEO), { ok: false, code: "FRAME_BAD_CAPTURE" });
  assert.deepEqual(checkCapture("x", VIDEO), { ok: false, code: "FRAME_UNREACHABLE" });
});

test("真实请求像是看不了图被拒：拿探测图复核，复核也说不能看才报专门的码；复核能看就按普通失败报", async () => {
  const error = Object.assign(new Error("image input is not supported by this model"), { status: 400 });
  const blind = setup({ ai: { replies: { frame: error } }, probe: ok({ imageInput: false }) });
  assert.equal((await blind.run()).error?.code, "AI_IMAGE_UNSUPPORTED");
  assert.deepEqual(blind.probed, ["fake-model"]);
  assert.equal(blind.fake.calls.length, 1, "不重试");

  const tooLarge = Object.assign(new Error("image too large"), { status: 400 });
  const sees = setup({ ai: { replies: { frame: tooLarge } } });
  const entry = await sees.run();
  assert.equal(entry.state, "failed");
  assert.notEqual(entry.error?.code, "AI_IMAGE_UNSUPPORTED");
});

test("没有字幕、读字幕出错时照样解释，字幕写「无」，标题用刚核对的视频信息", async () => {
  for (const transcript of ["no-captions", "throws"] as const) {
    const h = setup({ transcript });
    assert.equal((await h.run()).state, "done", transcript);
    const parts = h.fake.calls[0]?.request.messages?.[1]?.content as readonly { readonly text?: string }[];
    assert.match(parts[1]?.text ?? "", /视频：(没有字幕的视频|力学入门)[\s\S]*字幕：\n无$/);
  }
});

test("付费、确认不了是不是付费、没登录读不到视频信息的：按那个原因拒，不截、不发", async () => {
  for (const [transcript, code, detail] of [["paid", "UNPLAYABLE", "paid"], ["signed-out", "NEED_LOGIN", undefined]] as const) {
    const h = setup({ transcript });
    const entry = await h.run();
    assert.deepEqual([entry.state, entry.error?.code, entry.error?.detail], ["failed", code, detail], transcript);
    assert.deepEqual(h.asked, [], "没向页面要画面");
    assert.equal(h.fake.calls.length, 0);
  }
});

test("截帧途中清除了本机数据：停下，不登记任务、不发，之前那条也不再列出", async () => {
  let h: ReturnType<typeof setup> | null = null;
  h = setup({ duringCapture: () => h?.clearGuard.clear("all", () => h?.session.remove(FRAME_RESULTS_KEY)) ?? Promise.resolve() });
  const entry = await h.service.start(TAB, VIDEO);
  await h.service.settled(entry.id);
  assert.equal(h.asked.length, 1);
  assert.equal(h.fake.calls.length, 0, "没发");
  assert.deepEqual(await h.service.recent(TAB), []);
});

test("前后字幕：这一刻之前 20 秒到之后 10 秒，太多时以这一刻为中心截到 12 行", () => {
  assert.equal(frameContext([cue(0, "a"), cue(65, "b"), cue(95, "c"), cue(96, "d")], 85), "1:05 b\n1:35 c");
  const many = Array.from({ length: 40 }, (_, index) => cue(60 + index, `第${index}句`));
  const lines = frameContext(many, 80).split("\n");
  assert.equal(lines.length, 12);
  assert.ok(lines.includes("1:20 第20句"), "包含这一刻");
  assert.equal(frameContext([], 10), "");
});

test("每个标签页每分钟 6 次，标签页之间不共用，过了一分钟恢复", () => {
  const { service, timers } = setup();
  for (let index = 0; index < FRAME_LIMIT; index += 1) assert.equal(service.admit(TAB), true);
  assert.equal(service.admit(TAB), false);
  assert.equal(service.admit(8), true);
  timers.advance(FRAME_WINDOW_MS);
  assert.equal(service.admit(TAB), true);
});

test("最近几次新的在前；收尾半小时后清掉，每个标签页最多留 10 次", async () => {
  const { run, service, timers } = setup();
  const first = await run();
  timers.advance(1000);
  const second = await run();
  assert.deepEqual((await service.recent(TAB)).map(({ id }) => id), [second.id, first.id]);
  timers.advance(KEEP_MS);
  for (let index = 0; index < 12; index += 1) {
    timers.advance(1);
    await run();
  }
  const kept = await service.recent(TAB);
  assert.equal(kept.length, 10);
  assert.ok(!kept.some(({ id }) => id === first.id || id === second.id));
});

test("解释记在会话存储里：后台醒来读得回来；醒来时还标着在跑的按中途停了收尾", async () => {
  const h = setup();
  const done = await h.run();
  await until(() => Array.isArray(h.session.data[FRAME_RESULTS_KEY]) && (h.session.data[FRAME_RESULTS_KEY] as FrameEntryView[]).some((item) => item.state === "done"));
  const stored = h.session.data[FRAME_RESULTS_KEY] as FrameEntryView[];
  assert.ok(stored.every((item) => !JSON.stringify(item).includes("data:image")), "会话存储里没有截图");

  const running = { ...done, id: "left-over", state: "running", phase: "thinking", createdAt: done.createdAt + 1 };
  const woken = setup({ session: { [FRAME_RESULTS_KEY]: [...stored, running] } });
  const listed = await woken.service.recent(TAB);
  assert.deepEqual(listed.map(({ id, state }) => [id, state]), [["left-over", "failed"], [done.id, "done"]]);
  assert.equal(listed[0]?.error?.code, "FRAME_INTERRUPTED");
});

test("清除本机数据以后，之前的解释不再列出，也不写回会话存储", async () => {
  const h = setup();
  await h.run();
  assert.equal((await h.service.recent(TAB)).length, 1);
  await h.clearGuard.clear("all", () => h.session.remove(FRAME_RESULTS_KEY));
  assert.deepEqual(await h.service.recent(TAB), []);
  assert.equal(h.session.data[FRAME_RESULTS_KEY], undefined);
});

test("登记任务之前的几步也撑着后台：整段包在一份有上限的保活里，做完就撤", async () => {
  const h = setup();
  await h.run();
  assert.deepEqual(h.held, [PREFLIGHT_KEEPALIVE_MS]);
  assert.equal(h.released(), 1);
});
