// 概览服务和用官方总结写结论的测试架子：任务运行器、概览仓储、清除闸门和并发闸门都是真的，两个服务共用，计时器手动推进；
// 字幕默认是按给定分段交快照的替身，带一份有内容的官方总结（可以换成真实的取字幕服务），模型服务是按请求回复的替身：
// 默认按本块起点产出一章，结论默认读不出有效内容。
import { createOverviewService, type OverviewService, type OverviewServiceDeps } from "../../src/background/services/overview/index.ts";
import { createVerdictService, type VerdictService } from "../../src/background/services/overview/verdict.ts";
import type { TranscriptService } from "../../src/background/services/transcript/index.ts";
import { createOverviewStore, type OverviewStore } from "../../src/background/stores/overviews.ts";
import { createTaskRunner, type TaskRunner } from "../../src/background/tasks.ts";
import type { ChunkPlanOptions } from "../../src/core/ai/chunking.ts";
import { taskCanceledError, type CompletionRequest, type CompletionResult, type RetryNotice } from "../../src/core/ai/transport/index.ts";
import { createClearGuard, type ClearGuard } from "../../src/core/clear-guard.ts";
import { createLimiter, type Limiter } from "../../src/core/concurrency.ts";
import { ok, type ErrorCode, type Failure, type Result } from "../../src/core/errors.ts";
import type { ClearEpoch } from "../../src/core/clear-guard.ts";
import type { OverviewRecord } from "../../src/core/notes/records.ts";
import type { FrozenGen, TaskKind, TaskOrigin, TaskView } from "../../src/core/tasks.ts";
import type { TranscriptSegment } from "../../src/core/transcript/segment.ts";
import { videoKey, type VideoKey, type VideoRef } from "../../src/core/video-ref.ts";
import { createKeepAlive, type KeepAlive } from "../../src/platform/keepalive.ts";
import type { ObjectStoreDriver } from "../../src/platform/idb.ts";
import type { Broadcast } from "../../src/shared/messages.ts";
import type { OverviewResultView } from "../../src/shared/messages/overview.ts";
import type { OfficialSummaryView, TranscriptReply, TranscriptView } from "../../src/shared/messages/transcript.ts";
import { normalize } from "../../src/shared/settings-schema.ts";
import { SAMPLE_ID } from "./fake-site-service.ts";
import { manualTimers, type ManualTimers } from "./manual-timers.ts";
import { createMemoryDriver } from "./memory-driver.ts";

export const START = 1_800_000_000_000;
export const REF: VideoRef = { platform: "bilibili", videoId: SAMPLE_ID, segment: 1 };
export const VIDEO: VideoKey = videoKey(REF);
export const OTHER: VideoKey = videoKey({ platform: "bilibili", videoId: "BV1Sample002", segment: 1 });
export const SHORT: ChunkPlanOptions = { maxChars: 3500, singleChars: 3500 };

export const ANALYSIS_GEN: FrozenGen = { feature: "analysis", baseUrl: "https://ai.example.test/v1", model: "chunk-model", effort: "off", promptVersion: "analysis-v1" };
export const VERDICT_GEN: FrozenGen = { feature: "verdict", baseUrl: "https://ai.example.test/v1", model: "verdict-model", effort: "off", promptVersion: "verdict-v1" };

// 提示词替身：用户提示词里写着本块起点、覆盖情况和正文，替身按它们回复、测试按它们定向。
export const PROMPTS: Readonly<Record<string, string>> = {
  "analysis.md": [
    "## 系统提示词",
    "```",
    "概览/系统",
    "```",
    "## 用户提示词",
    "```",
    "概览/用户",
    "minTimestampSeconds={minTimestampSeconds}",
    "{rangeNote}",
    "{transcriptText}",
    "```",
    "",
  ].join("\n"),
  "verdict.md": [
    "## 系统提示词",
    "```",
    "结论/系统",
    "```",
    "## 用户提示词",
    "```",
    "结论/用户",
    "标题：{videoTitle}",
    "时长：{durationFormatted}",
    "覆盖：{coverageNote}",
    "{chaptersText}",
    "金句：{quotesText}",
    "```",
    "",
  ].join("\n"),
};

const segment = (id: string, start: number, text: string): TranscriptSegment => ({ id, start, text, texts: [text] });

/** 两个长分段：较短的分块下必然切成两块。第二段带失败标记，按内容定向失败的用例用它。 */
export function twoSegments(): TranscriptSegment[] {
  return [segment("s0", 0, `正常内容。${"字".repeat(1800)}`), segment("s1", 150, `FAIL标记。${"字".repeat(1800)}`)];
}

/** 三个分段，各成一块；后两块带失败标记。 */
export function threeSegments(): TranscriptSegment[] {
  return [
    segment("s0", 0, `正常内容。${"字".repeat(1800)}`),
    segment("s1", 150, `FAIL标记一。${"字".repeat(1800)}`),
    segment("s2", 300, `FAIL标记二。${"字".repeat(1800)}`),
  ];
}

/** 一次模型请求，测试按它决定怎么回。 */
export interface Ask {
  readonly feature: string;
  readonly user: string;
  readonly isVerdict: boolean;
  readonly request: CompletionRequest;
}

/** 替身的回复：正文，可以标成被截断、或者传输层发过几次。 */
export interface Reply {
  readonly text: string;
  readonly truncated?: true;
  readonly sends?: number;
}

/** 交回 undefined 走默认回复；可以挂住、抛错。 */
export type Respond = (ask: Ask) => Reply | undefined | Promise<Reply | undefined>;

/** 自造的官方总结：一段带时间的提纲、一段没有时间的。 */
export const OFFICIAL: OfficialSummaryView = {
  status: "ok",
  summary: "官方总摘要",
  outline: [
    { title: "第一段", timestamp: 65, points: [{ timestamp: 65, content: "要点一" }, { timestamp: 70, content: "要点二" }] },
    { title: "没有时间", timestamp: null, points: [] },
  ],
  fingerprint: "official-fingerprint",
};

export const verdictReply = (summary = "讲了两段", verdict = "看概览就够"): Reply => ({
  text: JSON.stringify({ summary, value: "有方法", verdict, reason: "要点都在" }),
});

export const chapterReply = (title: string, seconds: number): Reply => ({
  text: JSON.stringify({ chapters: [{ title, timestampSeconds: seconds, summary: "摘要" }], keyQuotes: [] }),
});

/** 像真实传输层一样认取消信号：用户点停止后，在途请求按取消结束。 */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => reject(taskCanceledError());
    if (signal?.aborted) return cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    promise.then(resolve, reject);
  });
}

export const hang = (signal: AbortSignal | undefined): Promise<Reply> => abortable(new Promise<Reply>(() => {}), signal);

export interface OverviewHarnessOptions {
  readonly segments?: TranscriptSegment[];
  readonly durationSec?: number;
  readonly respond?: Respond;
  readonly concurrency?: number;
  readonly gate?: Limiter;
  /** 本机已有的概览。 */
  readonly records?: readonly OverviewRecord[];
  /** 换成别的取字幕来源，比如真实的取字幕服务。 */
  readonly transcript?: Pick<TranscriptService, "ensure" | "get">;
  /** 替身字幕带的官方总结，null 是不带。 */
  readonly official?: OfficialSummaryView | null;
  /** 替身读不成字幕，带着视频信息和官方总结报这个错。 */
  readonly captionsFail?: Failure;
  readonly guard?: ClearGuard;
  readonly wrapStore?: (inner: OverviewStore) => OverviewServiceDeps["overviews"];
  readonly wrapDriver?: (inner: ObjectStoreDriver<OverviewRecord>) => ObjectStoreDriver<OverviewRecord>;
  readonly keepAlive?: KeepAlive;
  readonly timers?: ManualTimers;
}

export interface Logged {
  readonly level: "warn" | "error";
  readonly text: string;
}

export interface OverviewHarness {
  readonly service: OverviewService;
  /** 用官方总结写结论的服务：和概览服务共用任务、仓储、清除闸门和并发闸门。 */
  readonly verdict: VerdictService;
  readonly tasks: TaskRunner;
  readonly store: OverviewStore;
  readonly driver: ObjectStoreDriver<OverviewRecord>;
  readonly guard: ClearGuard;
  readonly timers: ManualTimers;
  readonly broadcasts: Broadcast[];
  readonly asks: Ask[];
  readonly logs: Logged[];
  /** 取过几次字幕快照。 */
  readonly ensures: () => number;
  /** 写结论取过几次字幕（连官方总结）。 */
  readonly reads: () => number;
  setRespond(respond: Respond | undefined): void;
  /** marker：带失败标记的块偶发失败；all：每个请求都报配置错误。 */
  setFailMode(mode: "marker" | "all" | null): void;
  /** 登记一个概览任务，交回任务号。 */
  register(video?: VideoKey): Promise<string>;
  /** 登记并开始生成。 */
  generate(options?: { readonly fresh?: boolean; readonly video?: VideoKey }): { readonly taskId: Promise<string>; readonly result: Promise<Result<OverviewResultView>> };
  /** 登记并补失败块。 */
  retry(): { readonly taskId: Promise<string>; readonly result: Promise<Result<OverviewResultView>> };
  /** 登记一个结论任务（侧边栏的，或粗筛的），交回任务号。 */
  registerVerdict(options?: { readonly kind?: TaskKind; readonly origin?: TaskOrigin; readonly video?: VideoKey }): Promise<string>;
  /** 登记并用官方总结写结论。 */
  officialVerdict(options?: { readonly kind?: TaskKind; readonly origin?: TaskOrigin; readonly since?: ClearEpoch }): { readonly taskId: Promise<string>; readonly result: Promise<Result<OverviewResultView>> };
  record(video?: VideoKey): Promise<OverviewRecord | null>;
  previews(): Extract<Broadcast, { type: "overview.preview" }>[];
  updates(): Extract<Broadcast, { type: "overview.updated" }>[];
  progress(): TaskView[];
  chunkAsks(): Ask[];
  verdictAsks(): Ask[];
}

/** 成功的结果。 */
export function value(result: Result<OverviewResultView>): OverviewResultView {
  if (!result.ok) throw new Error(`应该成功：${JSON.stringify(result)}`);
  return result.value;
}

/** 失败的码。 */
export function codeOf(result: Result<unknown>): ErrorCode | null {
  return result.ok ? null : result.code;
}

const titles = (record: { readonly analysis: { readonly chapters?: readonly { readonly title?: unknown }[] | null } } | null | undefined): unknown[] =>
  (record?.analysis.chapters ?? []).map((chapter) => chapter.title);

export { titles };

export function overviewHarness(options: OverviewHarnessOptions = {}): OverviewHarness {
  const timers = options.timers ?? manualTimers(START);
  const guard = options.guard ?? createClearGuard();
  const driver = (options.wrapDriver ?? ((inner) => inner))(createMemoryDriver<OverviewRecord>("overviews", options.records ?? []));
  const store = createOverviewStore({ driver, guard, now: timers.now });
  const broadcasts: Broadcast[] = [];
  const asks: Ask[] = [];
  const logs: Logged[] = [];
  let respond = options.respond;
  let failMode: "marker" | "all" | null = null;
  let ensures = 0;
  let reads = 0;
  let ids = 0;
  const settings = normalize({ presetId: "custom", aiBaseUrl: "https://ai.example.test/v1", aiModel: "chunk-model" });

  async function complete(request: CompletionRequest): Promise<CompletionResult> {
    const feature = request.feature ?? "";
    const user = request.messages?.find((message) => message.role === "user")?.content;
    const ask: Ask = { feature, user: typeof user === "string" ? user : "", isVerdict: feature === "verdict", request };
    asks.push(ask);
    if (request.signal?.aborted) throw taskCanceledError();
    if (failMode === "all") throw Object.assign(new Error("密钥坏了"), { code: "NO_AI_CONFIG" });
    const custom = respond ? await respond(ask) : undefined;
    const reply = custom ?? defaultReply(ask);
    return { text: reply.text, settings, sends: reply.sends ?? 1, ...(reply.truncated ? { truncated: true as const } : {}) };
  }

  function defaultReply(ask: Ask): Reply {
    if (failMode === "marker" && !ask.isVerdict && ask.user.includes("FAIL标记")) throw new Error("偶发超时");
    // 几块并发时不能拿最后一次的提示词去猜，按本块起点产出一章，章节就放在起点那一秒。
    const seconds = Number(/minTimestampSeconds=(\d+)/.exec(ask.user)?.[1] ?? 0);
    return chapterReply(`章@${seconds}`, seconds);
  }

  const keepAlive = options.keepAlive ?? createKeepAlive({ ping: () => {}, now: timers.now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  const tasks = createTaskRunner({
    ai: { forTask: (frozen) => ({ requestAiCompletion: (request) => complete({ ...request, feature: frozen.feature }) }) },
    keepAlive,
    timers,
    broadcast: (message) => void broadcasts.push(message),
    newId: () => `task-${(ids += 1)}`,
  });

  const segments = options.segments ?? twoSegments();
  const official = options.official === undefined ? OFFICIAL : options.official;
  const info = { title: "测试视频", author: "UP 主", description: "简介", durationSec: options.durationSec ?? 600 };
  const view = (ref: VideoRef): TranscriptView => ({
    video: videoKey(ref),
    info,
    transcript: {
      ref: { video: videoKey(ref), kind: "human", lang: "zh-CN", fingerprint: "fingerprint-zh" },
      trackId: "zh-CN",
      label: "中文",
      cues: [],
      segments,
    },
    tracks: [],
    chapters: [],
    ...(official ? { official } : {}),
    fromCache: true,
  });
  const reply = (ref: VideoRef): TranscriptReply =>
    options.captionsFail ? { ...options.captionsFail, info, ...(official ? { official } : {}) } : { ok: true, value: view(ref) };
  const transcript: Pick<TranscriptService, "ensure" | "get"> = options.transcript ?? {
    async ensure(ref) {
      const read = reply(ref);
      return read.ok ? ok({ view: read.value, generation: 0 }) : read;
    },
    get: async (ref) => reply(ref),
  };
  const counted: Pick<TranscriptService, "ensure" | "get"> = {
    ensure: (ref) => {
      ensures += 1;
      return transcript.ensure(ref);
    },
    get: (ref, opts) => {
      reads += 1;
      return transcript.get(ref, opts);
    },
  };
  const gate = options.gate ?? createLimiter();
  const log = {
    warn: (...args: unknown[]) => void logs.push({ level: "warn", text: args.map(String).join(" ") }),
    error: (...args: unknown[]) => void logs.push({ level: "error", text: args.map(String).join(" ") }),
  };
  const prompt = (file: string): string => {
    const text = PROMPTS[file];
    if (text === undefined) throw new Error(`没有这份提示词：${file}`);
    return text;
  };
  const overviews = options.wrapStore ? options.wrapStore(store) : store;

  const service = createOverviewService({
    tasks,
    transcript: counted,
    overviews,
    guard,
    prompt,
    chunkOptions: async () => SHORT,
    gate,
    concurrency: options.concurrency ?? 2,
    broadcast: (message) => void broadcasts.push(message),
    log,
    now: timers.now,
  });
  const verdict = createVerdictService({
    tasks,
    transcript: counted,
    overviews,
    guard,
    prompt,
    gate,
    concurrency: options.concurrency ?? 2,
    broadcast: (message) => void broadcasts.push(message),
    log,
    now: timers.now,
  });

  const register = async (video: VideoKey = VIDEO): Promise<string> => {
    const registered = await tasks.register({ kind: "overview", origin: "user", video, gen: ANALYSIS_GEN, stages: [VERDICT_GEN], followsPage: false }, {});
    if (!("task" in registered)) throw new Error(`登记失败：${JSON.stringify(registered)}`);
    return registered.task.id;
  };

  const registerVerdict = async ({ kind = "verdict", origin = "user", video = VIDEO }: { readonly kind?: TaskKind; readonly origin?: TaskOrigin; readonly video?: VideoKey } = {}): Promise<string> => {
    const registered = await tasks.register({ kind, origin, video, gen: VERDICT_GEN, followsPage: false }, {});
    if (!("task" in registered)) throw new Error(`登记失败：${JSON.stringify(registered)}`);
    return registered.task.id;
  };

  return {
    service,
    verdict,
    tasks,
    store,
    driver,
    guard,
    timers,
    broadcasts,
    asks,
    logs,
    ensures: () => ensures,
    reads: () => reads,
    setRespond(next) {
      respond = next;
    },
    setFailMode(mode) {
      failMode = mode;
    },
    register,
    generate({ fresh = false, video = VIDEO } = {}) {
      const taskId = register(video);
      return { taskId, result: taskId.then((id) => service.generate(id, video, { fresh })) };
    },
    retry() {
      const taskId = register();
      return { taskId, result: taskId.then((id) => service.retryFailed(id, VIDEO)) };
    },
    registerVerdict,
    officialVerdict({ kind, origin, since } = {}) {
      const taskId = registerVerdict({ ...(kind ? { kind } : {}), ...(origin ? { origin } : {}) });
      return { taskId, result: taskId.then((id) => verdict.fromOfficial(id, VIDEO, since ? { since } : {})) };
    },
    record: (video = VIDEO) => store.find(video),
    previews: () => broadcasts.filter((message): message is Extract<Broadcast, { type: "overview.preview" }> => message.type === "overview.preview"),
    updates: () => broadcasts.filter((message): message is Extract<Broadcast, { type: "overview.updated" }> => message.type === "overview.updated"),
    progress: () => broadcasts.flatMap((message) => (message.type === "task.changed" ? [message.task] : [])),
    chunkAsks: () => asks.filter((ask) => !ask.isVerdict),
    verdictAsks: () => asks.filter((ask) => ask.isVerdict),
  };
}

export type { RetryNotice };
