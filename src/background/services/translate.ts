// 翻译和整理字幕：侧边栏经端口发起，后台分批请求模型，每批回来就推给页面、并进译文仓储。
// 整理字幕只补标点、改同音错字，本机核对改得太多的段不用，记成原文，照旧显示原文、下次也不再为它花钱。
// 本机已经存着的段直接交回，不再花钱；换了字幕版本时，原文没变的段从同视频、同目标语言的旧版带过来。
// 偶发失败的批次静默补一轮，补轮那一批传输层不再自己重发；全军覆没不补，多半是配置不对。
// 用户点了就在后台做完：关掉侧边栏不停，重开侧边栏能接上进度。点停止、清除本机数据、发起的标签页换了视频或关掉、
// 服务说额度用完或密钥不对时停下，连在途的一起中止。
// 写回前核对清除代数和字幕代数：等模型的工夫清除了全部数据、换过字幕文件，在途的译文照常交给页面、不存，之后的批次不再发。
import { estimateOutputTokens, planTranslationBatches, TRANSLATION_BATCH_MAX_SEGMENTS, type TranslationItem } from "../../core/ai/chunking.ts";
import { parseLooseJson } from "../../core/ai/parse.ts";
import { extractPromptSection, LANG_SECTIONS } from "../../core/ai/prompt.ts";
import { SEGMENT_BATCH } from "../../core/ai/schemas.ts";
import { taskCanceledError, throwIfTaskCanceled } from "../../core/ai/transport/index.ts";
import { alignTranslatedSegments } from "../../core/ai/validate.ts";
import type { ClearEpoch, ClearGuard } from "../../core/clear-guard.ts";
import { mapWithConcurrency, waitOrStop } from "../../core/concurrency.ts";
import { fail, ok, type Result } from "../../core/errors.ts";
import type { Basis, Derived, TextTarget, TranscriptRef } from "../../core/notes/records.ts";
import { outputLangOf, type OutputLang } from "../../core/output-lang.ts";
import type { FrozenGen, TaskOrigin, TaskView } from "../../core/tasks.ts";
import { textFingerprint } from "../../core/transcript/fingerprint.ts";
import type { TranscriptSegment } from "../../core/transcript/segment.ts";
import { parseVideoKey, type VideoKey, type VideoRef } from "../../core/video-ref.ts";
import type { TextPurpose, TranslateFailure, TranslateOut } from "../../shared/messages/translate.ts";
import { AI_CONCURRENCY } from "../../shared/settings-schema.ts";
import { pauseReasonOf } from "./auto-generate.ts";
import { errorLabel, type Log } from "../log.ts";
import { progressText } from "../progress-text.ts";
import { failureOf, fromPlayback, genInfo, parseFailed, targetOf, tidiedOf, toTranslateFailure, videoOfUrl } from "./translate-parts.ts";

export { targetOf };
import { translationId, type TranslationStore } from "../stores/translations.ts";
import { PAGES_LEFT, type TaskRun, type TaskRunner, type Timers } from "../tasks.ts";
import { isTransientChunkFailure, promptMessages } from "./overview/chunks.ts";
import type { TranscriptService } from "./transcript/index.ts";

// 翻译提示词里「译成什么」的写法。
const TARGET_LANG_NAMES: Readonly<Record<OutputLang, string>> = { zh: "简体中文", "zh-Hant": "繁体中文", en: "英文" };

export const TRANSLATE_PROMPT = "study/translation.md";
/** 设置里「翻译」这一项的模型槽，沿用旧名。 */
export const TRANSLATE_FEATURE = "rewrite";
export const TIDY_PROMPT = "study/tidy.md";
/** 设置里「整理字幕」这一项的模型槽。 */
export const TIDY_FEATURE = "tidy";
/** 偶发失败（限流、超时抖动）补一轮之前的等待。太短会撞回同一次限流窗口。 */
export const TRANSLATE_RETRY_DELAY_MS = 1500;
/** 一次请求最多带几段：和分批的条数上限一致，这里再兜一道。 */
const MAX_SEGMENTS_PER_REQUEST = TRANSLATION_BATCH_MAX_SEGMENTS;
/** 一批最多 4000 字，中英互译按两倍估输出，默认 8192 的上限会截断，放到 16384。上限本身不收费，按实际生成计费。 */
const BATCH_OUTPUT_CEILING = 16384;

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
  /** 不写是翻译；tidy 是整理字幕，只由用户点按钮发起。 */
  readonly purpose?: TextPurpose | undefined;
  /** 只交回本机已经存着的，不请求模型；同一份正在后台跑时接上它的进度。 */
  readonly storedOnly?: boolean | undefined;
  /** 发起的视频所在的标签页：它换了视频或关掉就停。 */
  readonly tabId?: number | undefined;
}

export interface TranslateService {
  /** 翻译这个视频现在的字幕：结果经 listener 推回去，一轮结束才返回。 */
  start(video: VideoKey, options: TranslateStart): Promise<void>;
  /** 页面点了停止：停掉它发起或接上的翻译，在途的请求一起中止。 */
  stop(listenerId: string): void;
  /** 页面断开了：退订，在跑的照常做完。 */
  leave(listenerId: string): void;
  /** 标签页换了地址或关掉（url 为 null）：从这个标签页发起、地址上的视频对不上的停下。没给标签页或地址没变（undefined）时什么都不做。 */
  tabChanged(tabId: number | undefined, url: string | null | undefined): void;
}

export interface TranslateServiceDeps {
  readonly tasks: Pick<TaskRunner, "register" | "run" | "cancel" | "unsubscribe">;
  readonly transcript: Pick<TranscriptService, "ensure" | "generation">;
  readonly translations: TranslationStore;
  /** 登记任务时取定「翻译」或「整理字幕」这一项的生成配置。 */
  readonly freeze: (feature: typeof TRANSLATE_FEATURE | typeof TIDY_FEATURE) => Promise<FrozenGen>;
  readonly prompt: (file: string) => string;
  /** 现在设置的语言，定翻译方向用。不给时按中文。 */
  readonly outputLang?: () => Promise<OutputLang>;
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
  /** 在做哪个视频的哪一样，后接上的页面按这个认；登记好才有。 */
  started?: { readonly video: VideoKey; readonly target: TextTarget; readonly event: Extract<TranslateOut, { type: "translate.started" }> };
  /** 发起的标签页。 */
  readonly tabIds: Set<number>;
}

/** 停下的原因：发起的标签页换了视频或关掉了。 */
const VIDEO_LEFT = Object.freeze({ code: "VIDEO_CHANGED" });

/** 一轮翻译要用的：这一版字幕、目标语言、每段原文的指纹，以及写回前的核对。 */
interface Job {
  readonly ref: VideoRef;
  readonly transcript: TranscriptRef;
  readonly target: TextTarget;
  readonly title: string;
  /** 段编号 → 原文：整理字幕改得太多时照旧用原文。 */
  readonly sources: ReadonlyMap<string, string>;
  readonly hashes: ReadonlyMap<string, string>;
  readonly since: ClearEpoch | undefined;
  /** 清除过全部数据、换过字幕文件就不再写。 */
  readonly current: () => boolean;
}

/** 一次还在准备的发起：准备期间点了停止就记下。 */
interface Preparing {
  halted: boolean;
  /** 发起的标签页和视频：准备的工夫它换了视频或关掉，就不登记、不发。 */
  readonly tabId?: number | undefined;
  readonly video?: VideoKey;
  left: boolean;
}

interface BatchOutcome {
  /** 没译完的批次：整批失败的，加上补过一轮还漏着段的。 */
  readonly failed: number;
  /** 整批失败、一段都没译成的批次。 */
  readonly rejected: number;
  readonly total: number;
  readonly first?: unknown;
}

export function createTranslateService(deps: TranslateServiceDeps): TranslateService {
  const { guard, log } = deps;
  const concurrency = deps.concurrency ?? AI_CONCURRENCY;
  const sessions = new Map<string, Session>();
  /** 每个页面发起或接上了哪些翻译；断开以后就不在这里。 */
  const joined = new Map<string, Set<string>>();
  /** 还在准备（读字幕、读本机译文、登记）的发起，按页面记：点停止只停这时已经在准备的那几次，之后再点的翻译不受影响。 */
  const preparing = new Map<string, Set<Preparing>>();
  /** 还在准备的发起，不分页面：标签页换了视频或关掉时要在这里也认一遍。 */
  const preparingTabs = new Set<Preparing>();

  function sessionOf(taskId: string): Session {
    let session = sessions.get(taskId);
    if (!session) {
      session = { taskId, listeners: new Map(), translated: {}, saveFailed: false, tabIds: new Set() };
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
    const tidy = job.target === "tidy";
    const markdown = deps.prompt(tidy ? TIDY_PROMPT : TRANSLATE_PROMPT);
    const segmentsJson = JSON.stringify({ segments: batch.map(({ id, text }) => ({ id, text })) });
    const variables = job.target === "tidy"
      ? { videoTitle: job.title || "未知", segmentsJson }
      : {
          targetLangName: TARGET_LANG_NAMES[job.target],
          langRules: extractPromptSection(markdown, LANG_SECTIONS[job.target]),
          videoTitle: job.title || "未知",
          segmentsJson,
        };
    const { text, sends } = await run.ai.requestAiCompletion({
      // 中英互译字符数会变，按字符估 token 时放宽；整理字幕只多出标点，也留些余量。
      maxTokens: estimateOutputTokens(segmentsJson.length, { ratio: tidy ? 1.5 : 2, floor: 2048, ceiling: BATCH_OUTPUT_CEILING }),
      // 照着原文来，不是创作，温度越低越贴近原意。
      temperature: tidy ? 0.1 : 0.2,
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
    const translated = tidy ? tidiedOf(parsed, batch, job) : alignTranslatedSegments(parsed, batch, { targetLang: job.target }).translated;
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
    const say = progressText(outputLangOf(run.gen));
    const label = (done: number, total: number): string => say.translateBatch(done, total);
    run.progress({ done: 0, total: batches.length, phase: "generating", message: label(0, batches.length) });
    // 额度用完、密钥不对：等多久都不会好，后面的批次不再发，在途的一起中止。
    let fatal: unknown;
    const one = async (batch: readonly TranslationItem[], retryRound: boolean): Promise<TranslationItem[]> => {
      if (fatal !== undefined) throw fatal;
      try {
        return await translateBatch(run, job, session, batch, requests.signal, retryRound);
      } catch (error) {
        if (fatal === undefined && pauseReasonOf(error)) {
          fatal = error;
          requests.abort(error);
        }
        throw error;
      }
    };
    const results = await mapWithConcurrency(batches, concurrency, (batch) => one(batch, false), (done, total) =>
      run.progress({ done, total, phase: "generating", message: label(done, total) }),
    );
    const rejected = (): number => results.filter((result) => result.status === "rejected").length;
    // 传输层已经重发过或特意不重发的不补：补了等于同一批多发几次。全军覆没也不补。
    const retry = results.flatMap((result, index) => (result.status === "rejected" && isTransientChunkFailure(result.reason) ? [index] : []));
    // 译成了一部分的批次，漏的那几段另外凑成批次补。
    const gaps = planTranslationBatches(results.flatMap((result) => (result.status === "fulfilled" ? result.value : [])));
    let unfinished = 0;
    if ((retry.length || gaps.length) && rejected() < batches.length && !run.signal.aborted && fatal === undefined) {
      run.progress({ phase: "retrying", message: say.translateRetry });
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
    const first = fatal !== undefined ? { status: "rejected" as const, reason: fatal } : results.find((result) => result.status === "rejected");
    const outcome: BatchOutcome = {
      failed: Math.min(batches.length, rejected() + unfinished),
      rejected: rejected(),
      total: batches.length,
      ...(first?.status === "rejected" ? { first: first.reason } : {}),
    };
    return ok(outcome);
  }

  async function runJob(job: Job, session: Session, todo: readonly TranscriptSegment[]): Promise<void> {
    const counted: { outcome?: BatchOutcome; lang?: OutputLang } = {};
    const result = await deps.tasks.run(
      session.taskId,
      async (run) => {
        const lang = outputLangOf(run.gen);
        const settled = await translateAll(run, job, session, todo);
        if (!settled.ok) return settled;
        counted.outcome = settled.value;
        counted.lang = lang;
        // 一批都没成：任务按失败收尾。译成了一部分的不算，页面按没译完的批数提示再点一次补齐。
        const { rejected, total, first } = settled.value;
        // 额度用完、密钥不对时按失败收尾，原因说清；只是部分批次没成的，页面按没成的批数提示再点一次补齐。
        if (first !== undefined && pauseReasonOf(first)) return { ok: false as const, ...failureOf(first, lang) };
        return rejected > 0 && rejected === total ? { ok: false as const, ...failureOf(first, lang) } : settled;
      },
      { autoFinish: true },
    );
    const { outcome, lang } = counted;
    const canceled = !result.ok && result.code === "TASK_CANCELED";
    const failure = canceled || result.ok ? undefined : outcome?.first !== undefined && lang ? failureOf(outcome.first, lang) : toTranslateFailure(result);
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

  async function start(video: VideoKey, { origin, fromSec, listener, purpose, storedOnly, tabId }: TranslateStart, mine: Preparing, prepared: () => void): Promise<void> {
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
    if (!snapshot.ok) return refuse(toTranslateFailure(snapshot));
    const { view, generation } = snapshot.value;
    const transcript = view.transcript.ref;
    const segments = view.transcript.segments.filter((segment) => segment.text.trim() !== "");
    const hashes = new Map<string, string>();
    for (const segment of segments) hashes.set(segment.id, await textFingerprint(segment.text));
    const job: Job = {
      ref,
      transcript,
      target: purpose === "tidy" ? "tidy" : targetOf(transcript.lang, deps.outputLang ? await deps.outputLang() : "zh"),
      title: view.info.title,
      sources: new Map(segments.map((segment) => [segment.id, segment.text])),
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
    if (storedOnly) {
      // 同一份正在后台跑（比如关掉侧边栏以前点的）：接上它，之后的批次照常推过来。
      const running = [...sessions.values()].find(
        (item) => item.started?.video === video && item.started.target === job.target && item.started.event.transcript.fingerprint === transcript.fingerprint,
      );
      if (!running?.started) return post({ type: "translate.done", state: "completed", totalBatches: 0, failedBatches: 0 });
      attach(running.taskId, listener);
      post({ ...running.started.event, joined: true });
      if (Object.keys(running.translated).length) post({ type: "translate.segments", taskId: running.taskId, fingerprint: transcript.fingerprint, translated: { ...running.translated } });
      return;
    }
    const todo = fromPlayback(
      segments.filter((segment) => !known[segment.id]),
      fromSec,
    );
    if (!todo.length) return post({ type: "translate.done", state: "completed", totalBatches: 0, failedBatches: 0 });

    let gen: FrozenGen;
    try {
      gen = await deps.freeze(purpose === "tidy" ? TIDY_FEATURE : TRANSLATE_FEATURE);
    } catch (error) {
      log.error("读取翻译或整理字幕的模型配置失败", errorLabel(error));
      return refuse({ code: "BACKGROUND_FAILED" });
    }
    // 准备的工夫页面点了停止，或者发起的标签页换了视频、关掉了：不登记，一个模型请求都不发。
    if (mine.halted || mine.left) return post({ type: "translate.done", state: "canceled", totalBatches: 0, failedBatches: 0 });
    const basis: Basis = { source: "transcript", transcript };
    // 点了就做完：不跟着页面走，关掉侧边栏照常跑。
    const registered = await deps.tasks.register(
      { kind: "translate", origin, video, lang: job.target, basis, gen, followsPage: false },
      listener ? { port: listener.id } : {},
    );
    if ("refused" in registered) return refuse({ code: "TASK_ALREADY_RUNNING" });
    if ("conflict" in registered) return refuse({ code: "TASK_ALREADY_RUNNING" }, registered.conflict);
    const { task } = registered;
    // 登记的工夫页面已经关了：照常做完，只是不再推给它。
    const departed = listener !== undefined && !joined.has(listener.id);
    const session = attach(task.id, departed ? undefined : listener);
    if (tabId !== undefined) session.tabIds.add(tabId);
    // 登记的工夫点了停止：和登记好以后点停止一样，停掉这个任务。
    // 点过停止就停，页面后来关了也一样。
    if (mine.halted) deps.tasks.cancel(task.id);
    else if (mine.left) deps.tasks.cancel(task.id, VIDEO_LEFT);
    prepared();
    const startedEvent = { type: "translate.started" as const, task, joined: registered.joined, transcript, target: job.target, pending: todo.length };
    if (!registered.joined) session.started = { video, target: job.target, event: startedEvent };
    post(startedEvent);
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
      const mine: Preparing = { halted: false, tabId: options.tabId, video, left: false };
      if (id !== undefined) preparing.set(id, (preparing.get(id) ?? new Set()).add(mine));
      preparingTabs.add(mine);
      // 准备阶段一结束（登记好、或者没登记就结束了）就不再算在准备里，之后的停止按任务来。
      const prepared = (): void => {
        preparingTabs.delete(mine);
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
    tabChanged(tabId, url) {
      if (tabId === undefined || url === undefined) return;
      const video = videoOfUrl(url);
      for (const pending of preparingTabs) if (pending.tabId === tabId && pending.video !== video) pending.left = true;
      for (const session of sessions.values()) {
        if (session.tabIds.has(tabId) && session.started?.video !== video) deps.tasks.cancel(session.taskId, VIDEO_LEFT);
      }
    },
  };
}

