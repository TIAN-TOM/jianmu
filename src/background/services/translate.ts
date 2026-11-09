// 翻译：侧边栏经端口发起，后台分批请求模型，每批回来就推给页面、并进译文仓储。
// 本机已经存着的段直接交回，不再花钱；换了字幕版本时，原文没变的段从同视频、同目标语言的旧版带过来。
// 偶发失败的批次静默补一轮，补轮那一批传输层不再自己重发；全军覆没不补，多半是配置不对。
// 订阅的页面都断开了：还没开始的批次不再发，已经发出的照常等它回来、存下，钱已经花了。点停止、清除本机数据则连在途的一起中止。
// 写回前核对清除代数和字幕代数：等模型的工夫清除了全部数据、换过字幕文件，在途的译文照常交给页面、不存，之后的批次不再发。
import { estimateOutputTokens, planTranslationBatches, type TranslationItem } from "../../core/ai/chunking.ts";
import { parseLooseJson } from "../../core/ai/parse.ts";
import { extractPromptSection } from "../../core/ai/prompt.ts";
import { SEGMENT_BATCH } from "../../core/ai/schemas.ts";
import { taskCanceledError, throwIfTaskCanceled, type TransportError } from "../../core/ai/transport/index.ts";
import { alignTranslatedSegments } from "../../core/ai/validate.ts";
import type { ClearEpoch, ClearGuard } from "../../core/clear-guard.ts";
import { mapWithConcurrency } from "../../core/concurrency.ts";
import { fail, ok, type Failure, type Result } from "../../core/errors.ts";
import type { Basis, Derived, TranscriptRef } from "../../core/notes/records.ts";
import type { FrozenGen, TaskOrigin, TaskView } from "../../core/tasks.ts";
import { textFingerprint } from "../../core/transcript/fingerprint.ts";
import { isChineseSubtitle } from "../../core/transcript/language.ts";
import type { TranscriptSegment } from "../../core/transcript/segment.ts";
import { parseVideoKey, type VideoKey, type VideoRef } from "../../core/video-ref.ts";
import type { TranslateFailure, TranslateOut, TranslateTarget } from "../../shared/messages/translate.ts";
import { AI_CONCURRENCY } from "../../shared/settings-schema.ts";
import { aiFailure } from "../ai.ts";
import { errorLabel, type Log } from "../log.ts";
import { translationId, type TranslationStore } from "../stores/translations.ts";
import { PAGES_LEFT, type TaskRun, type TaskRunner, type Timers } from "../tasks.ts";
import { isTransientChunkFailure, promptMessages } from "./overview/chunks.ts";
import type { TranscriptService } from "./transcript/index.ts";

export const TRANSLATE_PROMPT = "translation.md";
/** 设置里「翻译」这一项的模型槽，沿用旧名。 */
export const TRANSLATE_FEATURE = "rewrite";
/** 偶发失败（限流、超时抖动）补一轮之前的等待。太短会撞回同一次限流窗口。 */
export const TRANSLATE_RETRY_DELAY_MS = 1500;
/** 一次请求最多带几段：分批本来就小，这里再兜一道上限。 */
const MAX_SEGMENTS_PER_REQUEST = 12;

/** 收这一轮翻译消息的一方：经端口连着的页面。 */
export interface TranslateListener {
  readonly id: string;
  readonly post: (event: TranslateOut) => void;
}

export interface TranslateStart {
  readonly origin: Extract<TaskOrigin, "user" | "auto">;
  /** 从这一秒往后的先译，前面的随后补齐。 */
  readonly fromSec?: number | undefined;
  /** 经端口发起的页面；自动生成发起的没有，也不跟着页面走。 */
  readonly listener?: TranslateListener | undefined;
}

export interface TranslateService {
  /** 翻译这个视频现在的字幕：结果经 listener 推回去，一轮结束才返回。 */
  start(video: VideoKey, options: TranslateStart): Promise<void>;
  /** 页面点了停止：停掉它发起或接上的翻译，在途的请求一起中止。 */
  stop(listenerId: string): void;
  /** 页面断开了：退订，订阅的页面都走了才停下还没开始的批次。 */
  leave(listenerId: string): void;
}

export interface TranslateServiceDeps {
  readonly tasks: Pick<TaskRunner, "register" | "run" | "cancel" | "unsubscribe">;
  readonly transcript: Pick<TranscriptService, "ensure" | "generation">;
  readonly translations: TranslationStore;
  /** 登记任务时取定「翻译」这一项的生成配置。 */
  readonly freeze: (feature: typeof TRANSLATE_FEATURE) => Promise<FrozenGen>;
  readonly prompt: (file: string) => string;
  readonly guard: ClearGuard;
  readonly timers: Pick<Timers, "setTimeout" | "clearTimeout">;
  readonly concurrency?: number;
  readonly log: Log;
}

/** 一轮翻译：在跑的任务、听它的页面、已经交出去的译文（后接上的页面先补这些）。 */
interface Session {
  readonly taskId: string;
  readonly listeners: Map<string, TranslateListener>;
  readonly translated: Record<string, string>;
  saveFailed: boolean;
}

/** 一轮翻译要用的：这一版字幕、目标语言、每段原文的指纹，以及写回前的核对。 */
interface Job {
  readonly ref: VideoRef;
  readonly transcript: TranscriptRef;
  readonly target: TranslateTarget;
  readonly title: string;
  readonly hashes: ReadonlyMap<string, string>;
  readonly since: ClearEpoch | undefined;
  /** 清除过全部数据、换过字幕文件就不再写。 */
  readonly current: () => boolean;
}

/** 一次还在准备的发起：准备期间点了停止就记下。 */
interface Preparing {
  halted: boolean;
}

interface BatchOutcome {
  /** 没译完的批次：整批失败的，加上补过一轮还漏着段的。 */
  readonly failed: number;
  /** 整批失败、一段都没译成的批次。 */
  readonly rejected: number;
  readonly total: number;
  readonly first?: unknown;
}

/** 中文字幕译成英文，其他语言的字幕译成简体中文。 */
export const targetOf = (lang: string): TranslateTarget => (isChineseSubtitle(lang) ? "en" : "zh");

const genInfo = ({ feature, promptVersion, model, effort }: FrozenGen) => ({ feature, promptVersion, model, effort });

function parseFailed(sends: number): TransportError {
  const error: TransportError = Object.assign(new Error("模型没有按要求返回译文。"), { code: "TRANSLATE_PARSE_FAILED" });
  // 传输层已经为这一批重发过：额度用掉了，补轮不再发。
  if (sends > 1) error.noAutoRetry = true;
  return error;
}

function failureOf(error: unknown): TranslateFailure {
  if ((error as { readonly code?: unknown } | null)?.code === "TRANSLATE_PARSE_FAILED") return { code: "TRANSLATE_PARSE_FAILED" };
  const { code, detail } = aiFailure(error);
  return detail === undefined ? { code } : { code, detail };
}

const bare = ({ code, detail }: Failure): TranslateFailure => (detail === undefined ? { code } : { code, detail });

/** 从这一秒往后的先译：眼前的内容几秒内就有结果，前面的随后补齐，总量和费用不变。 */
function fromPlayback(segments: readonly TranscriptSegment[], fromSec: number | undefined): TranscriptSegment[] {
  if (fromSec === undefined) return [...segments];
  return [...segments.filter((segment) => segment.start >= fromSec), ...segments.filter((segment) => segment.start < fromSec)];
}

function waitOrStop(timers: TranslateServiceDeps["timers"], ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = timers.setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = (): void => {
      timers.clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

export function createTranslateService(deps: TranslateServiceDeps): TranslateService {
  const { guard, log } = deps;
  const concurrency = deps.concurrency ?? AI_CONCURRENCY;
  const sessions = new Map<string, Session>();
  /** 每个页面发起或接上了哪些翻译；断开以后就不在这里。 */
  const joined = new Map<string, Set<string>>();
  /** 还在准备（读字幕、读本机译文、登记）的发起，按页面记：点停止只停这时已经在准备的那几次，之后再点的翻译不受影响。 */
  const preparing = new Map<string, Set<Preparing>>();

  function sessionOf(taskId: string): Session {
    let session = sessions.get(taskId);
    if (!session) {
      session = { taskId, listeners: new Map(), translated: {}, saveFailed: false };
      sessions.set(taskId, session);
    }
    return session;
  }

  function attach(taskId: string, listener: TranslateListener | undefined): Session {
    const session = sessionOf(taskId);
    if (listener) {
      session.listeners.set(listener.id, listener);
      joined.get(listener.id)?.add(taskId);
    }
    return session;
  }

  const broadcast = (session: Session, event: TranslateOut): void => {
    for (const listener of session.listeners.values()) listener.post(event);
  };

  // 本机存着的这一版译文；缺的段再从同视频、同目标语言的别的版本按原文指纹找，找到的先存下。读不出来就当没有。
  async function storedFor(job: Job, wanted: ReadonlySet<string>): Promise<Readonly<Record<string, string>>> {
    try {
      const own = await deps.translations.find(job.transcript, job.target);
      const have = own?.segments ?? {};
      const gaps = new Set([...wanted].filter((hash) => !have[hash]));
      if (!gaps.size) return have;
      const id = translationId(job.transcript, job.target);
      const others = (await deps.translations.byVideo(job.transcript.video)).filter((record) => record.target === job.target && record.id !== id);
      const carried: Record<string, string> = {};
      for (const record of others) for (const [hash, text] of Object.entries(record.segments)) if (gaps.has(hash)) carried[hash] = text;
      const gen = own?.derived.gen ?? others.at(-1)?.derived.gen;
      if (gen && Object.keys(carried).length) {
        const derived: Derived = own?.derived ?? { basis: { source: "transcript", transcript: job.transcript }, gen };
        // 带过来的存不下也照样用：已经在本机的译文，不该因为没存成又付一次钱。
        await deps.translations
          .merge({ transcript: job.transcript, target: job.target, segments: carried, derived }, { since: job.since, still: job.current })
          .catch((error: unknown) => log.warn("带过来的译文没存上", errorLabel(error)));
      }
      return { ...carried, ...have };
    } catch (error) {
      log.warn("读本机译文失败", errorLabel(error));
      return {};
    }
  }

  // 一批：请求模型、按编号对回原位、存下、推给页面。requests 只在点停止、清除本机数据时中止，页面都走了不中止在途的。
  // 交回这一批里没译成的段（模型漏了、编号对不上、原文抄回来）：译成的照常存下、推给页面，漏的另补。
  async function translateBatch(run: TaskRun, job: Job, session: Session, batch: readonly TranslationItem[], requests: AbortSignal, retryRound: boolean): Promise<TranslationItem[]> {
    throwIfTaskCanceled(run.signal);
    // 等着的工夫换过字幕文件或清除了全部数据：这一版的译文存不下，页面也不再显示它，不为它再花钱。
    if (!job.current()) throw taskCanceledError();
    const markdown = deps.prompt(TRANSLATE_PROMPT);
    const toEnglish = job.target === "en";
    const segmentsJson = JSON.stringify({ segments: batch.map(({ id, text }) => ({ id, text })) });
    const variables = {
      targetLangName: toEnglish ? "英文" : "简体中文",
      langRules: extractPromptSection(markdown, toEnglish ? "英文规则" : "中文规则"),
      videoTitle: job.title || "未知",
      segmentsJson,
    };
    const { text, sends } = await run.ai.requestAiCompletion({
      // 中英互译字符数会变，按字符估 token 时放宽。
      maxTokens: estimateOutputTokens(segmentsJson.length, { ratio: 2, floor: 2048 }),
      // 照着原文译，不是创作，温度越低越贴近原意。
      temperature: 0.2,
      responseFormat: SEGMENT_BATCH,
      signal: requests,
      // 限流、过载后的自动重发还没发出去：页面都走了也一并撤掉。
      retrySignal: run.signal,
      selfRetry: !retryRound,
      messages: promptMessages(markdown, variables),
    });
    throwIfTaskCanceled(requests);
    let parsed: unknown;
    try {
      parsed = parseLooseJson(text);
    } catch {
      throw parseFailed(sends);
    }
    const { translated } = alignTranslatedSegments(parsed, batch, { targetLang: job.target });
    // 一条都对不上（漏了、编号改了、原文抄回来）不能算成功，不然这一批悄悄缺着；当作读不出来，偶发的补轮再试一次。
    if (!Object.keys(translated).length) throw parseFailed(sends);
    const byHash: Record<string, string> = {};
    for (const [id, value] of Object.entries(translated)) {
      const hash = job.hashes.get(id);
      if (hash) byHash[hash] = value;
    }
    let saveFailed = false;
    if (job.current()) {
      try {
        const derived: Derived = { basis: { source: "transcript", transcript: job.transcript }, gen: genInfo(run.gen) };
        await deps.translations.merge({ transcript: job.transcript, target: job.target, segments: byHash, derived }, { since: job.since, still: job.current });
      } catch (error) {
        // 译文已经付过费：存不下也照样交给页面，只说明重开以后可能要再译一次。
        log.error("译文保存失败", errorLabel(error));
        saveFailed = true;
      }
    }
    Object.assign(session.translated, translated);
    if (saveFailed) session.saveFailed = true;
    broadcast(session, {
      type: "translate.segments",
      taskId: session.taskId,
      fingerprint: job.transcript.fingerprint,
      translated,
      ...(saveFailed ? { saveFailed: true as const } : {}),
    });
    return batch.filter((item) => !Object.hasOwn(translated, item.id));
  }

  async function translateAll(run: TaskRun, job: Job, session: Session, todo: readonly TranscriptSegment[]): Promise<Result<BatchOutcome>> {
    const batches = planTranslationBatches(todo).map((batch) => batch.slice(0, MAX_SEGMENTS_PER_REQUEST));
    const requests = new AbortController();
    const stopRequests = (): void => {
      if (run.signal.reason !== PAGES_LEFT) requests.abort(run.signal.reason);
    };
    if (run.signal.aborted) stopRequests();
    else run.signal.addEventListener("abort", stopRequests, { once: true });
    const label = (done: number, total: number): string => `正在处理第 ${done}/${total} 批`;
    run.progress({ done: 0, total: batches.length, phase: "generating", message: label(0, batches.length) });
    const one = (batch: readonly TranslationItem[], retryRound: boolean) => translateBatch(run, job, session, batch, requests.signal, retryRound);
    const results = await mapWithConcurrency(batches, concurrency, (batch) => one(batch, false), (done, total) =>
      run.progress({ done, total, phase: "generating", message: label(done, total) }),
    );
    const rejected = (): number => results.filter((result) => result.status === "rejected").length;
    // 传输层已经重发过或特意不重发的不补：补了等于同一批多发几次。全军覆没也不补。
    const retry = results.flatMap((result, index) => (result.status === "rejected" && isTransientChunkFailure(result.reason) ? [index] : []));
    // 译成了一部分的批次，漏的那几段另外凑成批次补。
    const gaps = planTranslationBatches(results.flatMap((result) => (result.status === "fulfilled" ? result.value : [])));
    let unfinished = 0;
    if ((retry.length || gaps.length) && rejected() < batches.length && !run.signal.aborted) {
      run.progress({ phase: "retrying", message: `正在重试 ${retry.length + gaps.length} 批` });
      await waitOrStop(deps.timers, TRANSLATE_RETRY_DELAY_MS, run.signal);
      const again = await mapWithConcurrency([...retry.map((index) => batches[index] ?? []), ...gaps], concurrency, (batch) => one(batch, true));
      retry.forEach((batchIndex, i) => {
        const result = again[i];
        if (result?.status === "fulfilled") results[batchIndex] = result;
      });
      unfinished = again.filter((result) => result.status === "fulfilled" && result.value.length > 0).length + again.slice(retry.length).filter((result) => result.status === "rejected").length;
    } else {
      unfinished = gaps.length;
    }
    if (run.signal.aborted || !job.current()) return fail("TASK_CANCELED");
    const first = results.find((result) => result.status === "rejected");
    const outcome: BatchOutcome = {
      failed: Math.min(batches.length, rejected() + unfinished),
      rejected: rejected(),
      total: batches.length,
      ...(first?.status === "rejected" ? { first: first.reason } : {}),
    };
    return ok(outcome);
  }

  async function runJob(job: Job, session: Session, todo: readonly TranscriptSegment[]): Promise<void> {
    const counted: { outcome?: BatchOutcome } = {};
    const result = await deps.tasks.run(
      session.taskId,
      async (run) => {
        const settled = await translateAll(run, job, session, todo);
        if (!settled.ok) return settled;
        counted.outcome = settled.value;
        // 一批都没成：任务按失败收尾。译成了一部分的不算，页面按没译完的批数提示再点一次补齐。
        const { rejected, total, first } = settled.value;
        return rejected > 0 && rejected === total ? { ok: false as const, ...failureOf(first) } : settled;
      },
      { autoFinish: true },
    );
    const { outcome } = counted;
    const canceled = !result.ok && result.code === "TASK_CANCELED";
    const failure = canceled || result.ok ? undefined : outcome?.first !== undefined ? failureOf(outcome.first) : bare(result);
    broadcast(session, {
      type: "translate.done",
      taskId: session.taskId,
      state: canceled ? "canceled" : result.ok ? "completed" : "failed",
      totalBatches: outcome?.total ?? 0,
      failedBatches: outcome?.failed ?? 0,
      ...(failure ? { failure } : {}),
      ...(session.saveFailed ? { saveFailed: true as const } : {}),
    });
    sessions.delete(session.taskId);
    for (const tasks of joined.values()) tasks.delete(session.taskId);
  }

  async function start(video: VideoKey, { origin, fromSec, listener }: TranslateStart, mine: Preparing, prepared: () => void): Promise<void> {
    // 页面已经断开的不再推：断开的端口收不到，也省得把后来的消息记到别的页面头上。
    const post = (event: TranslateOut): void => {
      if (listener && joined.has(listener.id)) listener.post(event);
    };
    const refuse = (failure: TranslateFailure, task?: TaskView): void =>
      post({ type: "translate.refused", failure, ...(task ? { task } : {}) });
    if (listener && !joined.has(listener.id)) joined.set(listener.id, new Set());
    const ref = parseVideoKey(video);
    if (!ref) return refuse({ code: "INVALID_REQUEST" });
    const since = guard.epoch();
    // 缓存优先：侧边栏已经读过字幕，这里多半不向平台发请求。
    let snapshot = await deps.transcript.ensure(ref);
    // 读的工夫换过字幕文件：快照记的是换之前的代数，再读一次，拿前后一致的那一份。
    if (snapshot.ok && deps.transcript.generation(ref) !== snapshot.value.generation) snapshot = await deps.transcript.ensure(ref);
    if (!snapshot.ok) return refuse(bare(snapshot));
    const { view, generation } = snapshot.value;
    const transcript = view.transcript.ref;
    const segments = view.transcript.segments.filter((segment) => segment.text.trim() !== "");
    const hashes = new Map<string, string>();
    for (const segment of segments) hashes.set(segment.id, await textFingerprint(segment.text));
    const job: Job = {
      ref,
      transcript,
      target: targetOf(transcript.lang),
      title: view.info.title,
      hashes,
      since,
      current: () => !guard.clearedSince(since, "all") && deps.transcript.generation(ref) === generation,
    };
    const stored = await storedFor(job, new Set(hashes.values()));
    const known: Record<string, string> = {};
    for (const segment of segments) {
      const text = stored[hashes.get(segment.id) ?? ""];
      if (text) known[segment.id] = text;
    }
    if (Object.keys(known).length) post({ type: "translate.segments", fingerprint: transcript.fingerprint, translated: known, stored: true });
    const todo = fromPlayback(
      segments.filter((segment) => !known[segment.id]),
      fromSec,
    );
    if (!todo.length) return post({ type: "translate.done", state: "completed", totalBatches: 0, failedBatches: 0 });

    let gen: FrozenGen;
    try {
      gen = await deps.freeze(TRANSLATE_FEATURE);
    } catch (error) {
      log.error("读取翻译的模型配置失败", errorLabel(error));
      return refuse({ code: "BACKGROUND_FAILED" });
    }
    // 准备的工夫页面点了停止：不登记，一个模型请求都不发。
    if (mine.halted) return post({ type: "translate.done", state: "canceled", totalBatches: 0, failedBatches: 0 });
    const basis: Basis = { source: "transcript", transcript };
    const followsPage = listener !== undefined && origin === "user";
    const registered = await deps.tasks.register(
      { kind: "translate", origin, video, lang: job.target, basis, gen, followsPage },
      listener ? { port: listener.id } : {},
    );
    if ("refused" in registered) return refuse({ code: "TASK_ALREADY_RUNNING" });
    if ("conflict" in registered) return refuse({ code: "TASK_ALREADY_RUNNING" }, registered.conflict);
    const { task } = registered;
    // 登记的工夫页面已经关了：退订，订阅的页面都走了这个任务就停下，一批也不发。
    const departed = listener !== undefined && !joined.has(listener.id);
    const session = attach(task.id, departed ? undefined : listener);
    if (departed) deps.tasks.unsubscribe(listener.id);
    // 登记的工夫点了停止：和登记好以后点停止一样，停掉这个任务。
    else if (mine.halted) deps.tasks.cancel(task.id);
    prepared();
    post({ type: "translate.started", task, joined: registered.joined, transcript, target: job.target, pending: todo.length });
    if (registered.joined) {
      if (Object.keys(session.translated).length) {
        post({ type: "translate.segments", taskId: task.id, fingerprint: transcript.fingerprint, translated: { ...session.translated } });
      }
      return;
    }
    await runJob(job, session, todo);
  }

  return {
    async start(video, options) {
      const id = options.listener?.id;
      const mine: Preparing = { halted: false };
      if (id !== undefined) preparing.set(id, (preparing.get(id) ?? new Set()).add(mine));
      // 准备阶段一结束（登记好、或者没登记就结束了）就不再算在准备里，之后的停止按任务来。
      const prepared = (): void => {
        if (id === undefined) return;
        const pending = preparing.get(id);
        pending?.delete(mine);
        if (pending && !pending.size) preparing.delete(id);
      };
      try {
        await start(video, options, mine, prepared);
      } catch (error) {
        log.error("翻译失败", errorLabel(error));
        options.listener?.post({ type: "translate.refused", failure: { code: "BACKGROUND_FAILED" } });
      } finally {
        prepared();
      }
    },
    stop(listenerId) {
      for (const pending of preparing.get(listenerId) ?? []) pending.halted = true;
      for (const taskId of joined.get(listenerId) ?? []) deps.tasks.cancel(taskId);
    },
    leave(listenerId) {
      joined.delete(listenerId);
      for (const session of sessions.values()) session.listeners.delete(listenerId);
      deps.tasks.unsubscribe(listenerId);
    },
  };
}

