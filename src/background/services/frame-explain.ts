// 解释当前画面：只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进包，只从开关分支引用。
// 两个入口共用一条路：先查模型配置和看图能力（不能看图就不截、不发），再读视频信息确认不是付费内容
// （确认是付费的、没登录读不到的都不截，确认不了是否付费的照截），再向那个标签页的内容脚本要当前一帧，核对截图（前缀、大小、尺寸、
// 视频身份），登记任务，连同这一刻前后几句字幕交给画面分析的模型。途中清除了本机数据就停下，不截、不发。
// YouTube 的字幕只在用户点读取时读：解释画面不核对视频信息、不读页面，只用本机已有的字幕，没有就只发画面。
// 截图只在这一次请求里用，不落盘，任务结束就丢；解释的文字按标签页留最近几次，侧边栏来取。解释记在扩展的会话存储里
// （只在内存，不写磁盘），后台被回收后醒来还在；醒来时还标着在跑的，按中途停了收尾。清除本机数据时一起删。
// 模块顶层只放字面量和函数，理由见 content/frame.ts 开头。
import { throwIfTaskCanceled } from "../../core/ai/transport/index.ts";
import { extractPromptSection, localizePrompt } from "../../core/ai/prompt.ts";
import { inLang, outputLangOf } from "../../core/output-lang.ts";
import { TRUNCATED_NOTE_HANT } from "./frame-explain-hant.ts";
import { fail, ok, type ErrorCode, type Failure, type Result } from "../../core/errors.ts";
import { sha256Hex } from "../../core/task-keys.ts";
import type { ClearGuard } from "../../core/clear-guard.ts";
import type { FrozenGen } from "../../core/tasks.ts";
import type { KeepAlive } from "../../platform/keepalive.ts";
import type { Messenger } from "../../platform/messaging.ts";
import type { StorageArea } from "../../platform/storage.ts";
import type { Tabs } from "../../platform/tabs.ts";
import { formatTimestamp } from "../../core/transcript/segment.ts";
import { parseVideoKey, type VideoKey, type VideoRef } from "../../core/video-ref.ts";
import type { Broadcast } from "../../shared/messages.ts";
import type { FrameCapture, FrameRefusal } from "../../shared/messages/content.ts";
import type { FrameEntryView } from "../../shared/messages/frame.ts";
import type { CueView, TranscriptView } from "../../shared/messages/transcript.ts";
import { DATA_CONSENT_ERROR } from "../../core/consent.ts";
import { FRAME_PROMPT_FILE } from "../../shared/frame-slot.ts";
import { aiFailure, type AiWiring } from "../ai.ts";
import { FRAME_RESULTS_KEY } from "../../shared/names.ts";
import { createImageSupport, isImageRejection, requireImage, type ImageSupport } from "../image-support.ts";
import { createRateLimit } from "../limits.ts";
import { errorLabel, type Log } from "../log.ts";
import { createWriteGate } from "../stores/write-gate.ts";
import type { TaskRunner } from "../tasks.ts";
import type { TranscriptService } from "./transcript/index.ts";

/** 截图长边，和内容脚本的初值一致。 */
export const FRAME_MAX_EDGE = 1456;
/** 截图核对：前缀、大小上限、尺寸上限。 */
export const FRAME_PREFIX = "data:image/jpeg;base64,";
export const FRAME_MAX_CHARS = 4_194_304; // 4 MB；写成字面量，算式会让模块留在发行包里
const FRAME_MAX_SIDE = 4096;
/** 登记任务之前那几步最多撑多久：探测、核对视频信息、读字幕各自都有超时，加起来留足。 */
export const PREFLIGHT_KEEPALIVE_MS = 180_000;
/** 每个标签页每分钟最多解释几次。 */
export const FRAME_LIMIT = 6;
export const FRAME_WINDOW_MS = 60_000;
/** 前后字幕取这一刻之前多少秒、之后多少秒，最多几行。 */
const CONTEXT_BEFORE_SEC = 20;
const CONTEXT_AFTER_SEC = 10;
const CONTEXT_MAX_LINES = 12;
const FRAME_MAX_TOKENS = 2048;
/** 每个标签页留最近几次，留多久。 */
const KEEP_PER_TAB = 10;
export const KEEP_MS = 1_800_000; // 半小时
// 截断提示和解释一起交回，跟着解释的语言。
const TRUNCATED_NOTE = {
  zh: "…（模型输出被截断，解释可能不完整。）",
  en: "… (The model's output was cut off, so this explanation may be incomplete.)",
};

// 读字幕时这几种失败只说明没有可用的字幕，照样解释；别的（限流、平台拒绝、没登录、读出错）都停下。
const CONTEXT_OPTIONAL: ReadonlySet<ErrorCode> = new Set<ErrorCode>(["NO_CAPTIONS", "EMPTY_CAPTION_FILE", "SUBTITLE_TRACK_MISSING", "SUBTITLE_MISMATCH"]);

// 内容脚本的拒绝换成给用户看的码。
const REFUSAL_CODES: Readonly<Record<FrameRefusal, ErrorCode>> = {
  NO_VIDEO: "FRAME_NO_VIDEO",
  AD_PLAYING: "FRAME_AD_PLAYING",
  VIDEO_CHANGED: "FRAME_VIDEO_CHANGED",
  FRAME_NOT_READY: "FRAME_NOT_READY",
  PROTECTED: "FRAME_PROTECTED",
  CANVAS_TAINTED: "FRAME_UNREADABLE",
  NOT_FOREGROUND: "FRAME_NOT_FOREGROUND",
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null;
const isSide = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= FRAME_MAX_SIDE;

/** 内容脚本回的截图：形状、前缀、大小、尺寸和视频身份都对上才用，不对就不发给模型。 */
export function checkCapture(reply: unknown, video: VideoKey): Result<FrameCapture> {
  if (!isRecord(reply)) return fail("FRAME_UNREACHABLE");
  if (reply.ok === false) {
    const code = typeof reply.code === "string" && Object.hasOwn(REFUSAL_CODES, reply.code) ? REFUSAL_CODES[reply.code as FrameRefusal] : "FRAME_BAD_CAPTURE";
    return fail(code);
  }
  const value = reply.ok === true && isRecord(reply.value) ? reply.value : null;
  if (!value) return fail("FRAME_BAD_CAPTURE");
  const { dataUrl, width, height, atSec } = value;
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(FRAME_PREFIX) || dataUrl.length <= FRAME_PREFIX.length || dataUrl.length > FRAME_MAX_CHARS) {
    return fail("FRAME_BAD_CAPTURE");
  }
  if (!isSide(width) || !isSide(height) || typeof atSec !== "number" || !Number.isFinite(atSec) || atSec < 0) return fail("FRAME_BAD_CAPTURE");
  if (value.video !== video) return fail("FRAME_VIDEO_CHANGED");
  return ok({ dataUrl, width, height, atSec, video });
}

/** 这一刻前后的字幕，一行一句，开头是分:秒。 */
export function frameContext(cues: readonly Pick<CueView, "start" | "text">[], atSec: number): string {
  const lines = cues
    .filter((cue) => cue.start >= atSec - CONTEXT_BEFORE_SEC && cue.start <= atSec + CONTEXT_AFTER_SEC && cue.text.trim())
    .map((cue) => `${formatTimestamp(cue.start)} ${cue.text.trim()}`);
  if (lines.length <= CONTEXT_MAX_LINES) return lines.join("\n");
  // 太多时以这一刻为中心截，前面多留一些。
  const at = cues.filter((cue) => cue.start >= atSec - CONTEXT_BEFORE_SEC && cue.start <= atSec && cue.text.trim()).length;
  const start = Math.max(0, Math.min(at - Math.ceil((CONTEXT_MAX_LINES * 2) / 3), lines.length - CONTEXT_MAX_LINES));
  return lines.slice(start, start + CONTEXT_MAX_LINES).join("\n");
}

// 配置没好的两种：没同意数据说明、别的设置没填好。在截帧之前就拦下。
export function configFailure(errors: readonly string[]): Failure {
  return errors.includes(DATA_CONSENT_ERROR) ? fail("NO_DATA_CONSENT") : fail("NO_AI_CONFIG", errors.join(" ") || undefined);
}

interface Material {
  readonly videoTitle: string;
  readonly cues: readonly Pick<CueView, "start" | "text">[];
}

export interface FrameExplainDeps {
  readonly tasks: Pick<TaskRunner, "register" | "run">;
  readonly ai: Pick<AiWiring, "freeze" | "configCheck">;
  readonly images: Pick<ImageSupport, "ensure" | "probe">;
  readonly transcript: Pick<TranscriptService, "get" | "verify">;
  /** 本机没记着视频信息时拿标签页的标题当视频标题。 */
  readonly tabTitle: (tabId: number) => Promise<string | null>;
  readonly clearGuard: Pick<ClearGuard, "epoch" | "clearedSince" | "track">;
  /** 扩展的会话存储：只在内存，浏览器关闭就清空。 */
  readonly session: Pick<StorageArea, "get" | "set">;
  /** 登记任务之前的几步（查配置、探测、核对视频信息、读字幕、截帧）也要撑着后台，不然慢的探测会被回收打断。 */
  readonly keepAlive: Pick<KeepAlive, "during">;
  readonly ask: (tabId: number, message: unknown) => Promise<unknown>;
  readonly prompt: (file: string) => string;
  readonly broadcast: (message: Broadcast) => void;
  readonly log: Log;
  readonly now: () => number;
  readonly newId: () => string;
}

export interface FrameExplainService {
  /** 这个标签页额度够就记一次。播放页图标和侧边栏共用一份。 */
  readonly admit: (tabId: number) => boolean;
  /** 开始解释，马上交回这一次的记录；之后每一步变化都广播 frame.changed，侧边栏重读。 */
  readonly start: (tabId: number, video: VideoKey) => Promise<FrameEntryView>;
  /** 这个标签页最近几次，新的在前。 */
  readonly recent: (tabId: number) => Promise<readonly FrameEntryView[]>;
  /** 等这一次跑完，测试用。 */
  readonly settled: (id: string) => Promise<void>;
}

const isEntry = (value: unknown): value is FrameEntryView =>
  isRecord(value) && typeof value.id === "string" && Number.isInteger(value.tabId) && typeof value.video === "string" && typeof value.createdAt === "number";

export function createFrameExplainService(deps: FrameExplainDeps): FrameExplainService {
  let entries = new Map<string, FrameEntryView>();
  let loaded: Promise<void> | null = null;
  let loadedAt = deps.clearGuard.epoch();
  const write = createWriteGate(deps.clearGuard, "cache");
  const running = new Map<string, Promise<void>>();
  const limits = new Map<number, () => boolean>();
  // 同一帧连点接上同一个任务时，等那一次的结果，不另跑。
  const byTask = new Map<string, Promise<Result<{ explanation: string; truncated?: true }>>>();

  /** 删掉过期和超出条数的，回有没有删。 */
  function prune(): boolean {
    const before = entries.size;
    const cutoff = deps.now() - KEEP_MS;
    const byTab = new Map<number, FrameEntryView[]>();
    for (const entry of entries.values()) {
      if (entry.state !== "running" && entry.createdAt < cutoff) {
        entries.delete(entry.id);
        continue;
      }
      byTab.set(entry.tabId, [...(byTab.get(entry.tabId) ?? []), entry]);
    }
    for (const list of byTab.values()) {
      for (const old of list.sort((a, b) => b.createdAt - a.createdAt).slice(KEEP_PER_TAB)) {
        if (old.state !== "running") entries.delete(old.id);
      }
    }
    return entries.size !== before;
  }

  // 第一次用时从会话存储读回来；清除过本机数据就丢掉内存里的，重新读（清除后是空的）。
  // 读回来时还标着在跑的，是后台被回收前没做完的：按中途停了收尾。
  function ensureLoaded(): Promise<void> {
    if (loaded && !deps.clearGuard.clearedSince(loadedAt, "cache")) return loaded;
    loadedAt = deps.clearGuard.epoch();
    entries = new Map();
    loaded = (async () => {
      let stored: unknown;
      try {
        stored = (await deps.session.get(FRAME_RESULTS_KEY))[FRAME_RESULTS_KEY];
      } catch {
        stored = undefined;
      }
      for (const item of Array.isArray(stored) ? stored : []) {
        if (!isEntry(item) || entries.has(item.id)) continue;
        entries.set(item.id, item.state === "running" && !running.has(item.id) ? { ...item, state: "failed", phase: "finished", error: { code: "FRAME_INTERRUPTED" } } : item);
      }
    })();
    return loaded;
  }

  // 按先后写回会话存储；清除过本机数据就不写，免得把刚清掉的写回去。
  function persist(): void {
    const since = loadedAt;
    const snapshot = [...entries.values()];
    void write(since, () => deps.session.set({ [FRAME_RESULTS_KEY]: snapshot })).catch((error: unknown) => deps.log.warn("记下画面解释失败", errorLabel(error)));
  }

  function update(id: string, patch: Partial<FrameEntryView>): void {
    const entry = entries.get(id);
    if (!entry) return;
    entries.set(id, { ...entry, ...patch });
    persist();
    deps.broadcast({ type: "frame.changed", tabId: entry.tabId });
  }

  const failed = (id: string, failure: Failure): void =>
    update(id, { state: "failed", phase: "finished", error: failure.detail === undefined ? { code: failure.code } : { code: failure.code, detail: failure.detail } });

  // 截帧之前每次都向平台重新读一次视频信息：确认已登录、不是付费内容（确认是付费的不截），不看缓存，
  // 导入了字幕文件也一样。读不成就按那个原因拒，不截。字幕只当上下文：这个视频本来就没有字幕、字幕是空的、
  // 对不上这个视频时照样解释，只是不带字幕；被平台限流、拒绝或者读出错就停下，不截、不发，也不接着读。
  async function material(video: VideoKey, tabId: number): Promise<Result<Material>> {
    const ref = parseVideoKey(video);
    if (!ref) return fail("FRAME_VIDEO_CHANGED");
    if (ref.platform === "youtube") return localMaterial(ref, tabId);
    const verified = await deps.transcript.verify(ref);
    if (!verified.ok) return verified;
    let reply: Awaited<ReturnType<FrameExplainDeps["transcript"]["get"]>>;
    try {
      reply = await deps.transcript.get(ref, { mode: "full", tabId });
    } catch (error) {
      deps.log.warn("读字幕出错，不解释画面", errorLabel(error));
      return fail("NETWORK");
    }
    if (!reply.ok && !CONTEXT_OPTIONAL.has(reply.code)) return reply.detail === undefined ? fail(reply.code) : fail(reply.code, reply.detail);
    return ok({ videoTitle: verified.value.title || "未知", cues: reply.ok ? reply.value.transcript.cues : [] });
  }

  // 只看本机：缓存、内存里记着的和导入的字幕，一个请求都不发，也不问页面。读不到就当没有字幕，照样解释。
  async function localMaterial(ref: VideoRef, tabId: number): Promise<Result<Material>> {
    let local: TranscriptView | null = null;
    try {
      const reply = await deps.transcript.get(ref, { mode: "local", tabId });
      local = reply.ok ? reply.value : null;
    } catch (error) {
      deps.log.warn("读本机字幕出错，只发画面", errorLabel(error));
    }
    const videoTitle = local?.info.title || (await deps.tabTitle(tabId)) || "未知";
    return ok({ videoTitle, cues: local?.transcript.cues ?? [] });
  }

  async function explain(gen: FrozenGen, video: VideoKey, capture: FrameCapture, found: Material, id: string): Promise<Result<{ explanation: string; truncated?: true }>> {
    // 画面时间取到 0.5 秒一档，加上截图内容的哈希：同一帧连点接上同一个任务，播放中截到不同的帧各解释各的。
    const input = { at: Math.round(capture.atSec * 2) / 2, image: await sha256Hex(capture.dataUrl) };
    const registered = await deps.tasks.register({ kind: "frame-explain", origin: "user", video, input, gen, stages: [], followsPage: false }, {});
    if (!("task" in registered)) return fail("TASK_ALREADY_RUNNING");
    const taskId = registered.task.id;
    const joined = byTask.get(taskId);
    if (joined) return joined;
    const result = deps.tasks.run(
      registered.task.id,
      async (run) => {
        try {
          const variables = {
            videoTitle: found.videoTitle,
            transcriptContext: frameContext(found.cues, capture.atSec) || "无",
            frameTime: formatTimestamp(capture.atSec),
          };
          throwIfTaskCanceled(run.signal);
          const lang = outputLangOf(gen);
          const markdown = localizePrompt(deps.prompt(FRAME_PROMPT_FILE), lang);
          update(id, { phase: "thinking" });
          const { text, truncated } = await run.ai.requestAiCompletion({
            maxTokens: FRAME_MAX_TOKENS,
            signal: run.signal,
            onRetry: ({ message }) => run.progress({ phase: "generating", message }),
            lang,
            messages: [
              { role: "system", content: extractPromptSection(markdown, "系统提示词", variables) },
              {
                role: "user",
                content: [
                  { type: "image", dataUrl: capture.dataUrl },
                  { type: "text", text: extractPromptSection(markdown, "用户提示词", variables) },
                ],
              },
            ],
          });
          throwIfTaskCanceled(run.signal);
          const explanation = text.trim();
          return ok(truncated ? { explanation: `${explanation}${inLang(lang, TRUNCATED_NOTE.zh, TRUNCATED_NOTE.en, TRUNCATED_NOTE_HANT)}`, truncated: true as const } : { explanation });
        } catch (error) {
          if (run.signal.aborted || (error as { readonly code?: unknown } | null)?.code === "TASK_CANCELED") return fail("TASK_CANCELED");
          // 像是看不了图被拒：拿探测图复核一次，复核也说不能看才这么报（并记下）；能看就是别的原因，照常报失败。
          if (isImageRejection(error)) {
            const probed = await deps.images.probe(gen);
            if (probed.ok && !probed.value.imageInput) return fail("AI_IMAGE_UNSUPPORTED");
          }
          deps.log.error("解释画面失败", errorLabel(error));
          return aiFailure(error, outputLangOf(gen));
        }
      },
      { autoFinish: true },
    );
    byTask.set(taskId, result);
    return result.finally(() => byTask.delete(taskId));
  }

  async function work(id: string, tabId: number, video: VideoKey): Promise<void> {
    // 清除本机数据会停掉所有任务，这时这一次还没登记任务：每过一道等待查一次，清过就不再往下。
    const since = deps.clearGuard.epoch();
    const canceled = (): boolean => deps.clearGuard.clearedSince(since, "cache");
    const config = await deps.ai.configCheck();
    if (!config.ready) return failed(id, configFailure(config.errors));
    const gen = await deps.ai.freeze("frame");
    // 不能看图就不截、不发。说不准时发一张 8×8 的图探一次，结果记在本机。
    const image = requireImage(await deps.images.ensure(gen));
    if (!image.ok) return failed(id, image);
    if (canceled()) return failed(id, fail("TASK_CANCELED"));
    const found = await material(video, tabId);
    if (!found.ok) return failed(id, found);
    if (canceled()) return failed(id, fail("TASK_CANCELED"));
    update(id, { phase: "capturing" });
    let reply: unknown;
    try {
      reply = await deps.ask(tabId, { type: "player.captureFrame", req: { video, maxEdge: FRAME_MAX_EDGE } });
    } catch {
      return failed(id, fail("FRAME_UNREACHABLE"));
    }
    const capture = checkCapture(reply, video);
    if (!capture.ok) return failed(id, capture);
    if (canceled()) return failed(id, fail("TASK_CANCELED"));
    const { atSec, width, height } = capture.value;
    update(id, { atSec, width, height, phase: "thinking" });
    const result = await explain(gen, video, capture.value, found.value, id);
    if (!result.ok) return failed(id, result);
    update(id, { state: "done", phase: "finished", explanation: result.value.explanation, ...(result.value.truncated ? { truncated: true as const } : {}) });
  }

  return {
    admit(tabId) {
      let limit = limits.get(tabId);
      if (!limit) {
        limit = createRateLimit({ limit: FRAME_LIMIT, windowMs: FRAME_WINDOW_MS, now: deps.now });
        limits.set(tabId, limit);
      }
      return limit();
    },
    async start(tabId, video) {
      await ensureLoaded();
      prune();
      const entry: FrameEntryView = { id: deps.newId(), tabId, video, state: "running", phase: "checking", createdAt: deps.now() };
      entries.set(entry.id, entry);
      persist();
      deps.broadcast({ type: "frame.changed", tabId });
      // 登记任务以后由任务自己的保活接手；这一份只管前面几步，到点就撤。
      const done = deps.keepAlive
        .during(PREFLIGHT_KEEPALIVE_MS, () => work(entry.id, tabId, video))
        .catch((error: unknown) => {
          deps.log.error("解释画面出错", errorLabel(error));
          failed(entry.id, fail("AI_REQUEST_FAILED"));
        })
        .finally(() => running.delete(entry.id));
      running.set(entry.id, done);
      return entry;
    },
    async recent(tabId) {
      await ensureLoaded();
      // 过期删掉的也从会话存储里删，不只是不再显示。
      if (prune()) persist();
      return [...entries.values()].filter((entry) => entry.tabId === tabId).sort((a, b) => b.createdAt - a.createdAt);
    },
    settled: (id) => running.get(id) ?? Promise.resolve(),
  };
}

export interface FrameParts {
  readonly service: FrameExplainService;
  readonly images: ImageSupport;
}

/** 后台装配：看图探测和解释画面的服务，只在构建开关打开时建。 */
export function createFrameParts(deps: {
  readonly tasks: FrameExplainDeps["tasks"];
  readonly ai: Pick<AiWiring, "freeze" | "configCheck" | "capabilities" | "forTask" | "prompt">;
  readonly storage: Pick<StorageArea, "get" | "set">;
  readonly session: Pick<StorageArea, "get" | "set">;
  readonly keepAlive: Pick<KeepAlive, "during">;
  readonly clearGuard: ClearGuard;
  readonly transcript: FrameExplainDeps["transcript"];
  readonly tabs: Pick<Tabs, "ask" | "title">;
  readonly messenger: Pick<Messenger, "toPages">;
  readonly log: Log;
  readonly now: () => number;
}): FrameParts {
  const { ai, messenger } = deps;
  const images = createImageSupport({ storage: deps.storage, clearGuard: deps.clearGuard, ai, now: deps.now });
  const service = createFrameExplainService({
    tasks: deps.tasks,
    ai,
    images,
    transcript: deps.transcript,
    tabTitle: deps.tabs.title,
    clearGuard: deps.clearGuard,
    session: deps.session,
    keepAlive: deps.keepAlive,
    ask: deps.tabs.ask,
    prompt: ai.prompt,
    broadcast: (message) => void messenger.toPages(message),
    log: deps.log,
    now: deps.now,
    newId: () => crypto.randomUUID(),
  });
  return { images, service };
}
