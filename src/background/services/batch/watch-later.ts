// 稍后再看这个来源：读列表、逐个取官方总结（不花额度）、给有官方总结的写一句话结论（花额度）。每个条目一次读取、一个读取环境，
// 读不成只看错误码和读取实现标的影响范围。写结论的材料：字幕缓存里有就用缓存的视频信息，官方总结和视频信息缺的从粗筛存的那份补，
// 不为写结论向平台读字幕；观看进度只存在本机，不进写结论的材料。
import type { ClearEpoch, ClearGuard } from "../../../core/clear-guard.ts";
import { fail, ok, type ErrorCode, type Result } from "../../../core/errors.ts";
import type { FrozenGen } from "../../../core/tasks.ts";
import { officialFingerprint } from "../../../core/transcript/fingerprint.ts";
import { hasOfficialContent, isOfficialDone, needsVideoInfo, type PacedOutcome, type ReadFailure, type VerdictRequest } from "../../../core/triage/batch.ts";
import type { TriageVerdict } from "../../../core/triage/groups.ts";
import { findItem, triageRef, withList, withOfficial, withUnavailable, type OfficialRecord, type TriageItem, type TriageState } from "../../../core/triage/state.ts";
import { videoKey, type VideoKey, type VideoRef } from "../../../core/video-ref.ts";
import type { BatchFailure } from "../../../shared/messages/batch.ts";
import type { OfficialSummaryView, OutlineSectionView, TranscriptReply, VideoInfoView } from "../../../shared/messages/transcript.ts";
import type { OfficialSummary, SiteFailure, VideoInfo } from "../../../sites/types.ts";
import type { TriageStore } from "../../stores/triage.ts";
import type { TaskRunner } from "../../tasks.ts";
import type { VerdictService } from "../overview/verdict.ts";
import type { SiteAccess } from "../transcript/read.ts";
import type { TranscriptService } from "../transcript/index.ts";

export interface WatchLaterDeps {
  readonly triage: TriageStore;
  readonly sites: SiteAccess;
  readonly transcript: Pick<TranscriptService, "get">;
  readonly tasks: Pick<TaskRunner, "register" | "cancel">;
  readonly verdict: Pick<VerdictService, "fromOfficial">;
  readonly guard: ClearGuard;
  readonly now: () => number;
}

/** 一个条目做完的样子：交给页面，也交给停止规则。 */
export interface ItemOutcome extends PacedOutcome {
  readonly requested: boolean;
  readonly official?: OfficialRecord;
  readonly verdict?: TriageVerdict;
  readonly unavailable?: true;
  readonly failure?: (ReadFailure & BatchFailure) | null;
  /** 粗筛的列表已经不在了：后面的条目也不用做了。 */
  readonly listGone?: true;
  /** 写结论时同一个视频别处正在写：这一轮结束时再读一次它写好的。 */
  readonly elsewhere?: true;
}

export interface ListRead {
  readonly state: TriageState;
  readonly dropped: number;
}

// 平台说这个视频看不了：付费、确认不了付费、找不到。之后两步都跳过它。
const UNAVAILABLE: ReadonlySet<string> = new Set<ErrorCode>(["UNPLAYABLE", "NOT_FOUND"]);

const PLATFORM = "bilibili";

const failure = (code: ErrorCode): ReadFailure & BatchFailure => ({ code });

const listGone = (requested: boolean): ItemOutcome => ({ requested, listGone: true, failure: failure("TRIAGE_LIST_CLEARED") });

/** 一次读取一个读取环境，不跟用户的停止走：在途的这一个读完为止。 */
const freshCtx = (deps: WatchLaterDeps) => deps.sites.ctx(PLATFORM, { signal: new AbortController().signal });

function infoOfItem(ref: VideoRef, item: TriageItem): VideoInfo {
  return {
    ref,
    title: item.title ?? "",
    author: item.ownerName ?? "",
    ...(item.channel ? { channel: item.channel } : {}),
    description: item.description ?? "",
    durationSec: item.duration ?? 0,
    ...(item.mediaVersion ? { mediaVersion: item.mediaVersion } : {}),
  };
}

function infoViewOf(item: TriageItem): VideoInfoView {
  return {
    title: item.title ?? "",
    author: item.ownerName ?? "",
    ...(item.channel ? { channel: item.channel } : {}),
    description: item.description ?? "",
    durationSec: item.duration ?? 0,
  };
}

async function recordOf({ status, summary, outline }: OfficialSummary, fetchedAt: number): Promise<OfficialRecord> {
  const record = { status, summary, outline, fetchedAt };
  return status === "ok" ? { ...record, fingerprint: await officialFingerprint(record) } : record;
}

/** 读列表：只读一次，存下来，重新打开粗筛页不用再问平台。只收第 1 P 的条目，其余的算丢掉。 */
export async function readList(deps: WatchLaterDeps, since: ClearEpoch | undefined): Promise<Result<ListRead>> {
  const site = deps.sites.service(PLATFORM);
  if (!site?.readWatchLater) return fail("SITE_UNSUPPORTED");
  const read = await site.readWatchLater(freshCtx(deps));
  if (!read.ok) return fail(read.code);
  const items = read.value.items.filter((item) => triageRef(item.videoKey) !== null);
  const fetchedAt = deps.now();
  const state = await deps.triage.update((current) => withList(current, { items, count: read.value.total, fetchedAt }), since);
  if (!state) return fail("LOCAL_DATA_CLEARED");
  return ok({ state, dropped: read.value.dropped + read.value.items.length - items.length });
}

// 只给还在列表里的视频存：读的工夫列表被清除了，就不写回、也不把存储重新建出来。
async function save(deps: WatchLaterDeps, key: VideoKey, record: OfficialRecord, since: ClearEpoch | undefined, requested: boolean, reason?: ReadFailure & BatchFailure): Promise<ItemOutcome> {
  const saved = await deps.triage.update((current) => (findItem(current, key) ? withOfficial(current, key, record) : null), since);
  if (!saved) return listGone(requested);
  return reason ? { requested, official: record, failure: reason } : { requested, official: record };
}

async function settleFailure(deps: WatchLaterDeps, key: VideoKey, read: SiteFailure, since: ClearEpoch | undefined): Promise<ItemOutcome> {
  const reason: ReadFailure & BatchFailure = read.code === "MALFORMED" ? { code: read.code, reach: read.reach } : { code: read.code };
  if (UNAVAILABLE.has(read.code)) {
    const saved = await deps.triage.update((current) => (findItem(current, key) ? withUnavailable(current, key) : null), since);
    return saved ? { requested: true, unavailable: true, failure: reason } : listGone(true);
  }
  const fetchedAt = deps.now();
  const record: OfficialRecord = read.code === "NEED_LOGIN" ? { status: "need-login", fetchedAt } : { status: "failed", reason: read.code, fetchedAt };
  return save(deps, key, record, since, true, reason);
}

// 字幕缓存里已经有定论的官方总结（用户打开过这个视频）：直接用，不发请求。
async function fromCache(deps: WatchLaterDeps, ref: VideoRef): Promise<OfficialRecord | null> {
  const reply = await deps.transcript.get(ref, { mode: "cache-only" });
  const official = reply.ok ? reply.value.official : undefined;
  if (!official || !isOfficialDone(official)) return null;
  const { status, summary, outline, fingerprint } = official;
  return fingerprint === undefined ? { status, summary, outline, fetchedAt: deps.now() } : { status, summary, outline, fingerprint, fetchedAt: deps.now() };
}

/**
 * 第一步的一项：粗筛里存过定论的、字幕缓存里已有定论的都不发请求。列表没确认过付费状态、或者缺媒体版本的，
 * 先读一次视频信息；看不了就记下，不读官方总结。一次消息最多问平台两次，两项之间的间隔由批次的节奏保证。
 */
export async function fetchOfficial(deps: WatchLaterDeps, key: VideoKey, since: ClearEpoch | undefined): Promise<ItemOutcome> {
  const ref = triageRef(key);
  if (!ref) return { requested: false, failure: failure("INVALID_REQUEST") };
  if (deps.guard.clearedSince(since, "cache")) return listGone(false);
  const state = await deps.triage.read();
  const item = findItem(state, key);
  if (!item) return listGone(false);
  const stored = state.official[key];
  if (isOfficialDone(stored)) return { requested: false, official: stored as OfficialRecord };
  const cached = await fromCache(deps, ref);
  if (cached) return save(deps, key, cached, since, false);
  const site = deps.sites.service(PLATFORM);
  if (!site?.readOfficialSummary) return { requested: false, failure: failure("SITE_UNSUPPORTED") };
  const ctx = freshCtx(deps);
  let info = infoOfItem(ref, item);
  if (needsVideoInfo(item)) {
    const read = await site.readVideoInfo(ref, ctx);
    if (!read.ok) return settleFailure(deps, key, read, since);
    info = read.value;
  }
  const summary = await site.readOfficialSummary(info, ctx);
  if (!summary.ok) return settleFailure(deps, key, summary, since);
  return save(deps, key, await recordOf(summary.value, deps.now()), since, true);
}

/** 粗筛存的官方总结，有内容、记着指纹时才拿来写结论。 */
function storedOfficial(record: OfficialRecord | undefined): OfficialSummaryView | null {
  if (record?.status !== "ok" || !hasOfficialContent(record) || typeof record.fingerprint !== "string") return null;
  // 这份是从平台读到时原样存下的提纲，写结论只拿它拼提示词。
  const outline = (record.outline ?? []) as readonly OutlineSectionView[];
  return { status: "ok", summary: record.summary ?? "", outline, fingerprint: record.fingerprint };
}

const usable = (official: OfficialSummaryView | undefined): boolean =>
  official?.status === "ok" && hasOfficialContent(official) && typeof official.fingerprint === "string";

/**
 * 写结论取材料：字幕缓存里有这个视频就用缓存的，缓存里没有能用的官方总结时借粗筛存的那份；
 * 不在缓存里就用粗筛存的列表和官方总结拼出来。都不向平台读，也不往字幕缓存里写。
 */
export function verdictMaterial(deps: WatchLaterDeps): (ref: VideoRef) => Promise<TranscriptReply> {
  return async (ref) => {
    const key = videoKey(ref);
    const state = await deps.triage.read();
    const item = findItem(state, key);
    const stored = item ? storedOfficial(state.official[key]) : null;
    const cached = await deps.transcript.get(ref, { mode: "cache-only" });
    if (cached.ok) return usable(cached.value.official) || !stored ? cached : ok({ ...cached.value, official: stored });
    if (!item || !stored) return fail("NO_OFFICIAL_SUMMARY");
    return { ...fail("NOT_CACHED"), info: infoViewOf(item), official: stored };
  };
}

export interface VerdictRound {
  /** 这一轮的编号：写结论的任务都挂在它名下，页面都走了就一起退订。 */
  readonly id: string;
  readonly gen: FrozenGen;
  readonly since: ClearEpoch | undefined;
  /** 在跑的写结论任务，用户停止时撤。 */
  readonly taskIds: Set<string>;
  /** 这一轮停下了：用户点了停止，或者订阅的页面都走了。 */
  readonly signal: AbortSignal;
}

/**
 * 第二步的一项：登记一个粗筛写结论的任务，跟着这一轮的页面走，交给用官方总结写结论的服务。
 * 同一个视频别处正在写（另一个页面刚停下、还在等模型的那次）时不另发，记下来。
 */
export async function writeVerdict(deps: WatchLaterDeps, { item, ref }: VerdictRequest, round: VerdictRound, material: (ref: VideoRef) => Promise<TranscriptReply>): Promise<ItemOutcome> {
  if (!ref) return { requested: false, failure: failure("INVALID_REQUEST") };
  const video = item.videoKey;
  const stopped: ItemOutcome = { requested: false, failure: failure("TASK_CANCELED") };
  if (round.signal.aborted) return stopped;
  const registered = await deps.tasks.register({ kind: "triage-verdict", origin: "batch", video, gen: round.gen, followsPage: true }, { port: round.id });
  if (!("task" in registered) || registered.joined) return { requested: false, elsewhere: true, failure: failure("TASK_ALREADY_RUNNING") };
  const taskId = registered.task.id;
  // 等登记的工夫这一轮停下了：停止时这个任务还没记进来、撤不到，这里把刚建的撤掉，不再写结论。
  if (round.signal.aborted) {
    deps.tasks.cancel(taskId);
    return stopped;
  }
  round.taskIds.add(taskId);
  try {
    const result = await deps.verdict.fromOfficial(taskId, video, { since: round.since, read: material });
    if (!result.ok) return { requested: true, failure: failure(result.code) };
    const written = result.value.analysis.verdict;
    return written ? { requested: !result.value.fromCache, verdict: verdictView(written) } : { requested: true, failure: failure("EMPTY_VERDICT") };
  } finally {
    round.taskIds.delete(taskId);
  }
}

/** 概览里的结论换成粗筛要显示的那几项。 */
export function verdictView(verdict: { readonly summary?: unknown; readonly value?: unknown; readonly verdict?: unknown; readonly reason?: unknown; readonly source?: unknown }): TriageVerdict {
  const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
  const view: Record<string, string> = {};
  for (const field of ["summary", "value", "verdict", "reason", "source"] as const) {
    const value = text(verdict[field]);
    if (value !== undefined) view[field] = value;
  }
  return view;
}
