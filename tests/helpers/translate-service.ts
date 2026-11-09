// 翻译服务的测试架子：任务运行器、译文仓储、清除闸门和保活是真的，计时器手动推进，提示词用仓库里的原文。
// 字幕默认是能中途换版本的替身，也可以换成真实的取字幕服务；模型服务是按功能回复的替身。页面是记下消息的监听方。
import { readFileSync } from "node:fs";
import { createTranslateService, type TranslateService, type TranslateServiceDeps } from "../../src/background/services/translate.ts";
import type { TranscriptService } from "../../src/background/services/transcript/index.ts";
import { createTranslationStore, type TranslationRecord, type TranslationStore } from "../../src/background/stores/translations.ts";
import { createTaskRunner, type TaskRunner } from "../../src/background/tasks.ts";
import type { CompletionRequest } from "../../src/core/ai/transport/index.ts";
import { createClearGuard, type ClearGuard } from "../../src/core/clear-guard.ts";
import { ok } from "../../src/core/errors.ts";
import { transcriptFingerprint } from "../../src/core/transcript/fingerprint.ts";
import { videoKey, type VideoKey, type VideoRef } from "../../src/core/video-ref.ts";
import type { ObjectStoreDriver } from "../../src/platform/idb.ts";
import { createKeepAlive } from "../../src/platform/keepalive.ts";
import type { Broadcast } from "../../src/shared/messages.ts";
import type { CueView, TranscriptView } from "../../src/shared/messages/transcript.ts";
import type { TranslateOut } from "../../src/shared/messages/translate.ts";
import { createFakeAi, type FakeAi, type FakeReply } from "./fake-ai.ts";
import { SAMPLE_ID } from "./fake-site-service.ts";
import { manualTimers, type ManualTimers } from "./manual-timers.ts";
import { createMemoryDriver } from "./memory-driver.ts";
import { until } from "./wait-until.ts";

export const START = 1_800_000_000_000;
/** 按条件等的轮数上限：一轮翻译要算好几次摘要（在线程池里算），机器忙时一千轮不够，多给一些。 */
export const PATIENT = 20_000;
export const REF: VideoRef = { platform: "bilibili", videoId: SAMPLE_ID, segment: 1 };
export const VIDEO: VideoKey = videoKey(REF);

export const TRANSLATION_PROMPT = readFileSync(new URL("../../prompts/translation.md", import.meta.url), "utf8").replaceAll("\r", "");

export const cue = (start: number, text: string, duration = 10): CueView => ({ start, duration, text });

/** 按字幕条拼一份字幕：分段和字幕条一一对应，编号是 s0、s1……，指纹按正文现算。 */
export async function transcriptView(cues: readonly CueView[], lang = "zh-CN", video: VideoKey = VIDEO): Promise<TranscriptView> {
  return {
    video,
    info: { title: "标题", author: "UP 主", description: "", durationSec: 600 },
    transcript: {
      ref: { video, kind: "human", lang, fingerprint: await transcriptFingerprint(cues) },
      trackId: lang,
      label: lang,
      cues,
      segments: cues.map((item, index) => ({ id: `s${index}`, start: item.start, text: item.text, texts: [item.text] })),
    },
    tracks: [],
    chapters: [],
    fromCache: true,
  };
}

/** 一次请求里要译的段：从用户提示词末尾的输入里读出来。 */
export function batchOf(request: CompletionRequest): { id: string; text: string }[] {
  const user = String((request.messages ?? []).find((message) => message.role === "user")?.content ?? "");
  const input = user.slice(user.lastIndexOf('{"segments":['));
  return (JSON.parse(input) as { segments: { id: string; text: string }[] }).segments;
}

/** 照原样译回：每段前面加个前缀，编号原样返回。 */
export const echo =
  (prefix = "译:") =>
  (request: CompletionRequest): string =>
    JSON.stringify({ segments: batchOf(request).map(({ id, text }) => ({ id, text: `${prefix}${text}` })) });

/** 页面：记下后台推来的每条消息。 */
export interface Page {
  readonly id: string;
  readonly events: TranslateOut[];
  readonly post: (event: TranslateOut) => void;
  /** 推来的译文按分段编号合在一起；给指纹时只认那一版的。 */
  readonly translated: (fingerprint?: string) => Record<string, string>;
  readonly of: <T extends TranslateOut["type"]>(type: T) => Extract<TranslateOut, { type: T }>[];
}

export function page(id: string): Page {
  const events: TranslateOut[] = [];
  const of = <T extends TranslateOut["type"]>(type: T) => events.filter((event): event is Extract<TranslateOut, { type: T }> => event.type === type);
  return {
    id,
    events,
    post: (event) => void events.push(structuredClone(event)),
    of,
    translated: (fingerprint) =>
      Object.assign({}, ...of("translate.segments").filter((event) => fingerprint === undefined || event.fingerprint === fingerprint).map((event) => event.translated)),
  };
}

export interface TranslateHarnessOptions {
  readonly reply?: FakeReply;
  readonly concurrency?: number;
  /** 换成真实的取字幕服务。 */
  readonly transcript?: Pick<TranscriptService, "ensure" | "generation">;
  readonly guard?: ClearGuard;
  readonly seed?: readonly TranslationRecord[];
  readonly wrapDriver?: (inner: ObjectStoreDriver<TranslationRecord>) => ObjectStoreDriver<TranslationRecord>;
}

export interface TranslateHarness {
  readonly service: TranslateService;
  readonly tasks: TaskRunner;
  readonly store: TranslationStore;
  readonly driver: ObjectStoreDriver<TranslationRecord>;
  readonly guard: ClearGuard;
  readonly timers: ManualTimers;
  readonly fake: FakeAi;
  readonly broadcasts: Broadcast[];
  readonly logs: string[];
  /** 替身字幕：换成这一份，字幕代数不变。 */
  show(view: TranscriptView): void;
  /** 替身字幕：换过字幕文件，代数加一。 */
  bumpGeneration(): void;
  /** 发起翻译，等这一轮结束。 */
  translate(listener?: Page, options?: { readonly fromSec?: number; readonly video?: VideoKey }): Promise<void>;
  /** 模型一共被请求了几次。 */
  readonly requests: () => number;
  /** 等到模型被请求了 n 次。 */
  readonly requested: (n: number) => Promise<boolean>;
}

export function translateHarness(view: TranscriptView, options: TranslateHarnessOptions = {}): TranslateHarness {
  const timers = manualTimers(START);
  const fake = createFakeAi({ prompts: { "translation.md": TRANSLATION_PROMPT }, replies: { rewrite: options.reply ?? echo() } });
  const guard = options.guard ?? createClearGuard();
  const broadcasts: Broadcast[] = [];
  const logs: string[] = [];
  const log = { warn: (label: unknown) => void logs.push(String(label)), error: (label: unknown) => void logs.push(String(label)) };
  const keepAlive = createKeepAlive({ ping: () => {}, now: timers.now, setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout });
  let ids = 0;
  const tasks = createTaskRunner({ ai: fake.ai, keepAlive, timers, broadcast: (message) => void broadcasts.push(message), newId: () => `task-${(ids += 1)}` });
  const inner = createMemoryDriver<TranslationRecord>("translations", options.seed ?? []);
  const driver = options.wrapDriver ? options.wrapDriver(inner) : inner;
  const store = createTranslationStore({ driver, guard, now: timers.now });

  let current = view;
  let generation = 0;
  const transcript: Pick<TranscriptService, "ensure" | "generation"> = options.transcript ?? {
    ensure: async () => ok({ view: current, generation }),
    generation: () => generation,
  };
  const deps: TranslateServiceDeps = {
    tasks,
    transcript,
    translations: store,
    freeze: fake.ai.freeze,
    prompt: fake.ai.prompt,
    guard,
    timers,
    ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
    log,
  };
  const service = createTranslateService(deps);
  return {
    service,
    tasks,
    store,
    driver,
    guard,
    timers,
    fake,
    broadcasts,
    logs,
    show(next) {
      current = next;
    },
    bumpGeneration() {
      generation += 1;
    },
    translate(listener = page("panel-1"), { fromSec, video = VIDEO } = {}) {
      return service.start(video, { origin: "user", listener, ...(fromSec === undefined ? {} : { fromSec }) });
    },
    requests: () => fake.count("rewrite"),
    requested: (n) => until(() => fake.count("rewrite") >= n, PATIENT),
  };
}
