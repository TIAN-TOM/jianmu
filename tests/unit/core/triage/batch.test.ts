import assert from "node:assert/strict";
import { test } from "node:test";
import {
  OFFICIAL_INTERVAL_MS,
  officialTodo,
  runOfficialBatch,
  runPool,
  runSerial,
  runVerdictBatch,
  verdictTodo,
  type OfficialRequest,
  type ReadFailure,
  type VerdictRequest,
} from "../../../../src/core/triage/batch.ts";
import type { TriageVerdict } from "../../../../src/core/triage/groups.ts";
import type { OfficialRecord, TriageItem } from "../../../../src/core/triage/state.ts";
import { videoKey, type VideoKey, type VideoRef } from "../../../../src/core/video-ref.ts";

// 用例里用短名字称呼视频，身份按出现顺序造。
const refs = new Map<string, VideoRef>();

function refOf(name: string): VideoRef {
  let ref = refs.get(name);
  if (!ref) {
    ref = { platform: "bilibili", videoId: `BV1Sample${String(refs.size).padStart(3, "0")}`, segment: 1 };
    refs.set(name, ref);
  }
  return ref;
}

const keyOf = (name: string): VideoKey => videoKey(refOf(name));

const item = (name: string, extra: Partial<TriageItem> = {}): TriageItem => ({
  videoKey: keyOf(name),
  title: `标题 ${name}`,
  ownerName: "UP 主",
  channel: { platform: "bilibili", channelId: "3" },
  mediaVersion: "2",
  duration: 600,
  progress: 0,
  finished: false,
  pageCount: 1,
  available: true,
  ...extra,
});

const OK = (summary = "官方总摘要"): OfficialRecord => ({
  status: "ok",
  summary,
  outline: [{ title: "第一段", timestamp: 0, points: [] }],
});

const verdictOf = (label: string, extra: TriageVerdict = {}): TriageVerdict => ({
  summary: `讲了 ${label}`,
  value: "核心价值",
  verdict: label,
  reason: "判断理由",
  source: "official",
  ...extra,
});

const errorMessage = (outcome: object): string | undefined =>
  "error" in outcome && outcome.error instanceof Error ? outcome.error.message : undefined;

// 假时钟：sleep 推进时钟并记下等了多久，worker 也可以推进时钟模拟请求耗时。
function fakeClock() {
  let time = 0;
  const waits: number[] = [];
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
    waits,
    sleep: async (ms: number, signal?: AbortSignal) => {
      waits.push(ms);
      if (signal?.aborted) return;
      time += ms;
    },
  };
}

// 第一步：串行、限速、停止

test("串行取总结：发了请求的两次之间至少隔 1.5 秒，从上一次回来算起", async () => {
  const clock = fakeClock();
  const calls: { key: VideoKey; start: number }[] = [];
  let inFlight = 0;
  const result = await runSerial(
    [item("A"), item("B"), item("C")],
    async (video) => {
      inFlight += 1;
      assert.equal(inFlight, 1, "同一时间只有一个请求");
      calls.push({ key: video.videoKey, start: clock.now() });
      clock.advance(400); // 请求本身花了 400 毫秒
      inFlight -= 1;
      return { requested: true };
    },
    { now: clock.now, sleep: clock.sleep },
  );
  assert.deepEqual(result, { done: 3, total: 3, stopped: false });
  assert.deepEqual(calls.map((call) => call.key), [keyOf("A"), keyOf("B"), keyOf("C")]);
  assert.equal(OFFICIAL_INTERVAL_MS, 1500);
  for (let i = 1; i < calls.length; i += 1) {
    const previous = calls[i - 1];
    const current = calls[i];
    assert.ok(previous && current);
    const previousEnd = previous.start + 400;
    assert.ok(current.start - previousEnd >= 1500, `第 ${i + 1} 个请求开始得太早`);
  }
  assert.deepEqual(clock.waits, [1500, 1500]);
});

test("没发请求的（后台直接用了存着的结果）不占间隔，下一个也不用多等", async () => {
  const clock = fakeClock();
  const starts: [VideoKey, number][] = [];
  await runSerial(
    [item("A"), item("B"), item("C"), item("D")],
    async (video) => {
      starts.push([video.videoKey, clock.now()]);
      clock.advance(100);
      return { requested: video.videoKey === keyOf("A") || video.videoKey === keyOf("D") };
    },
    { now: clock.now, sleep: clock.sleep },
  );
  // A 发了请求 → B 等满 1.5 秒；B、C 没发请求 → D 只需离 A 回来满 1.5 秒，不再额外等。
  assert.deepEqual(clock.waits, [1500]);
  const last = starts.at(-1);
  assert.ok(last);
  assert.ok(last[1] - 100 >= 1500);
});

test("worker 抛错按可能发过请求算，仍然等满间隔，循环不中断", async () => {
  const clock = fakeClock();
  const outcomes: [VideoKey, string][] = [];
  await runSerial(
    [item("A"), item("B")],
    async (video) => {
      if (video.videoKey === keyOf("A")) throw new Error("后台没有响应");
      return { requested: true };
    },
    {
      now: clock.now,
      sleep: clock.sleep,
      onResult: (video, outcome) => outcomes.push([video.videoKey, errorMessage(outcome) || "ok"]),
    },
  );
  assert.deepEqual(outcomes, [[keyOf("A"), "后台没有响应"], [keyOf("B"), "ok"]]);
  assert.deepEqual(clock.waits, [1500]);
});

test("停止：等间隔时点停止立刻结束，不再开始下一个", async () => {
  const controller = new AbortController();
  const started: VideoKey[] = [];
  const result = await runSerial(
    [item("A"), item("B"), item("C")],
    async (video) => {
      started.push(video.videoKey);
      return { requested: true };
    },
    {
      signal: controller.signal,
      // 用真的 sleep：停止要能打断正在等的那 1.5 秒。
      onResult: () => setTimeout(() => controller.abort(), 10),
    },
  );
  assert.deepEqual(started, [keyOf("A")]);
  assert.deepEqual(result, { done: 1, total: 3, stopped: true });
});

test("停止：请求进行中点停止，等这一个回来就结束", async () => {
  const controller = new AbortController();
  const clock = fakeClock();
  const started: VideoKey[] = [];
  const result = await runSerial(
    [item("A"), item("B")],
    async (video) => {
      started.push(video.videoKey);
      controller.abort();
      return { requested: true };
    },
    { signal: controller.signal, now: clock.now, sleep: clock.sleep },
  );
  assert.deepEqual(started, [keyOf("A")]);
  assert.equal(result.stopped, true);
});

test("第一步：每一项交给注入的步骤，带上条目和视频身份；没发请求的不等间隔", async () => {
  const clock = fakeClock();
  const seen: OfficialRequest[] = [];
  const started: VideoKey[] = [];
  const channel = { platform: "bilibili", channelId: "22" } as const;
  const result = await runOfficialBatch({
    items: [item("A", { mediaVersion: "11", channel }), item("B"), item("C")],
    step: async (request) => {
      seen.push(request);
      return { requested: request.ref?.videoId !== refOf("B").videoId };
    },
    now: clock.now,
    sleep: clock.sleep,
    onStart: (video) => started.push(video.videoKey),
  });
  assert.deepEqual(seen[0], { item: item("A", { mediaVersion: "11", channel }), ref: refOf("A") });
  assert.deepEqual(started, [keyOf("A"), keyOf("B"), keyOf("C")]);
  assert.deepEqual(clock.waits, [1500]);
  assert.equal(result.stop, null);
});

test("第一步的停止规则：被限流马上停；连着两个要登录才停；格式不对只影响这一项时接着做", async () => {
  const run = async (failures: Record<string, ReadFailure | null>) => {
    const clock = fakeClock();
    const done: string[] = [];
    const result = await runOfficialBatch({
      items: Object.keys(failures).map((name) => item(name)),
      step: async ({ item: entry }) => {
        const name = [...refs].find(([, ref]) => videoKey(ref) === entry.videoKey)?.[0] ?? "";
        done.push(name);
        return { requested: true, failure: failures[name] ?? null };
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    return { done, stop: result.stop };
  };
  assert.deepEqual(await run({ R1: null, R2: { code: "RATE_LIMITED" }, R3: null }), { done: ["R1", "R2"], stop: "rate-limited" });
  assert.deepEqual(await run({ L1: { code: "NEED_LOGIN" }, L2: null, L3: { code: "NEED_LOGIN" }, L4: null }), { done: ["L1", "L2", "L3", "L4"], stop: null });
  assert.deepEqual(await run({ N1: { code: "NEED_LOGIN" }, N2: { code: "NEED_LOGIN" }, N3: null }), { done: ["N1", "N2"], stop: "need-login" });
  assert.deepEqual(await run({ M1: { code: "MALFORMED", reach: "item" }, M2: null }), { done: ["M1", "M2"], stop: null });
  assert.deepEqual(await run({ S1: { code: "MALFORMED" }, S2: null }), { done: ["S1"], stop: "source" });
});

// 跳过已完成

test("第一步跳过已有定论的（有、没有、不支持）和已失效的；排队、要登录、失败的重问", () => {
  const items = [
    item("OK"),
    item("NONE"),
    item("UNSUPPORTED"),
    item("QUEUED"),
    item("LOGIN"),
    item("FAILED"),
    item("NEW"),
    item("GONE", { available: false }),
  ];
  const official = {
    [keyOf("OK")]: OK(),
    [keyOf("NONE")]: { status: "none" },
    [keyOf("UNSUPPORTED")]: { status: "unsupported" },
    [keyOf("QUEUED")]: { status: "queued" },
    [keyOf("LOGIN")]: { status: "need-login" },
    [keyOf("FAILED")]: { status: "failed", reason: "TIMEOUT" },
  };
  assert.deepEqual(
    officialTodo(items, official).map((video) => video.videoKey),
    ["QUEUED", "LOGIN", "FAILED", "NEW"].map((name) => keyOf(name)),
  );
});

// 第二步：只对有官方总结的写结论

test("第二步只挑有官方总结内容、还没有结论的视频", () => {
  const items = [
    item("HAS_SUMMARY"),
    item("OUTLINE_ONLY"),
    item("EMPTY_OK"),
    item("NONE"),
    item("NOT_FETCHED"),
    item("HAS_VERDICT"),
    item("BLANK_VERDICT"),
  ];
  const official = {
    [keyOf("HAS_SUMMARY")]: OK(),
    [keyOf("OUTLINE_ONLY")]: { status: "ok", summary: "", outline: [{ title: "只有提纲" }] },
    [keyOf("EMPTY_OK")]: { status: "ok", summary: "", outline: [] },
    [keyOf("NONE")]: { status: "none" },
    [keyOf("HAS_VERDICT")]: OK(),
    [keyOf("BLANK_VERDICT")]: OK(),
  };
  const verdicts = {
    [keyOf("HAS_VERDICT")]: verdictOf("看概览就够"),
    [keyOf("BLANK_VERDICT")]: { summary: "  ", verdict: "可以跳过" },
  };
  assert.deepEqual(
    verdictTodo(items, official, verdicts).map((video) => video.videoKey),
    ["HAS_SUMMARY", "OUTLINE_ONLY", "BLANK_VERDICT"].map((name) => keyOf(name)),
  );
});

test("第二步：只把挑出来的视频交给注入的步骤，带上视频身份", async () => {
  const items = [item("A"), item("B"), item("C")];
  const official = { [keyOf("A")]: OK(), [keyOf("C")]: OK() };
  const seen: VerdictRequest[] = [];
  const results: [VideoKey, boolean][] = [];
  await runVerdictBatch({
    items: verdictTodo(items, official, {}),
    concurrency: 2,
    step: async (request) => {
      seen.push(request);
      return { written: true };
    },
    onResult: (video, outcome) => results.push([video.videoKey, !("error" in outcome) && outcome.written]),
  });
  assert.deepEqual(seen.map((request) => request.ref), [refOf("A"), refOf("C")]);
  assert.deepEqual(results, [[keyOf("A"), true], [keyOf("C"), true]]);
});

test("第二步并发不超过上限；停止后不再开始新的，发出去的照样等回来", async () => {
  const items = ["A", "B", "C", "D", "E", "F"].map((name) => item(name));
  const controller = new AbortController();
  let active = 0;
  let peak = 0;
  const started: VideoKey[] = [];
  const finished: VideoKey[] = [];
  const result = await runPool(
    items,
    async (video) => {
      started.push(video.videoKey);
      active += 1;
      peak = Math.max(peak, active);
      // 第三个开始时用户点了停止：在途的 A、B、C 照样跑完，D 以后不再开始。
      if (started.length === 3) controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      finished.push(video.videoKey);
      return {};
    },
    { concurrency: 3, signal: controller.signal },
  );
  const inFlight = ["A", "B", "C"].map((name) => keyOf(name));
  assert.equal(peak, 3);
  assert.deepEqual(started, inFlight);
  assert.deepEqual(finished.sort(), [...inFlight].sort());
  assert.deepEqual(result, { started: 3, done: 3, total: 6, stopped: true });
});

test("并发数不是有效数字时按 1 跑，单个失败不影响其余", async () => {
  let active = 0;
  let peak = 0;
  const outcomes: string[] = [];
  await runPool(
    [item("A"), item("B")],
    async (video) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      if (video.videoKey === keyOf("A")) throw new Error("限流");
      return { ok: true };
    },
    { concurrency: "坏值", onResult: (_video, outcome) => outcomes.push(errorMessage(outcome) || "ok") },
  );
  assert.equal(peak, 1);
  assert.deepEqual(outcomes, ["限流", "ok"]);
});
