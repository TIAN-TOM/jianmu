// 旧格式备份的读取器：Digest for Bilibili 和简幕以前的版本导出的文件，一律按 B 站视频读，转成现在的记录。
// 坏记录逐条跳过并计数；提示词和设置不读，只记下带没带提示词；能算出来或不再可信的字段（链接、草稿、修订号）丢掉。
// 旧记录不知道当时依据的是什么，也不推断，一律记成依据未知；旧结论标过依据官方总结的，留个提示。
import { fail, ok, type Result } from "../errors.ts";
import type { Derived, NoteRecord, OverviewParts, OverviewRecord, QaRecord } from "../notes/records.ts";
import { videoKey, type VideoKey } from "../video-ref.ts";
import {
  finite,
  isFields,
  isQaId,
  isRecordId,
  keepValid,
  overviewRecord,
  qaRecord,
  snapshotOf,
  UNKNOWN_BASIS,
  type CheckedAnalysis,
  type Fields,
  type ImportedBackup,
} from "./records.ts";

export const LEGACY_BACKUP_KIND = "bilibili-digest-backup";
// 旧格式的版本号最高到 2，更高的是更新的版本写的。
const LEGACY_MAX_VERSION = 2;
const VIDEO_ID = /^BV[0-9A-Za-z]{10}$/;
const LEGACY_KEY = /^(BV[0-9A-Za-z]{10}):p([1-9][0-9]*)$/;
// 顶层名字里带 prompt 的键都是旧版的自定义提示词。
const PROMPT_KEY = /prompt/i;

const OFFICIAL_HINT: Derived = Object.freeze({ basis: Object.freeze({ source: "legacy-unknown", hint: "official-summary" }) });
// 旧记录不是哪个任务写的，记成最早，之后生成的总能换掉它。
const LEGACY_TASK_CREATED_AT = 0;

export function isLegacyBackup(payload: Fields): boolean {
  return payload.kind === LEGACY_BACKUP_KIND;
}

const given = (value: unknown): boolean => value !== undefined && value !== null;
const present = (value: unknown): boolean => given(value) && value !== "";

// 分 P 不合法按第 1 P。
function legacyPage(page: unknown): number {
  const value = Number(page);
  return Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

function legacyVideo(id: unknown, page: unknown): VideoKey | null {
  if (typeof id !== "string") return null;
  const videoId = id.trim();
  return VIDEO_ID.test(videoId) ? videoKey({ platform: "bilibili", videoId, segment: legacyPage(page) }) : null;
}

function keyFromRecordKey(value: unknown): VideoKey | null {
  const match = typeof value === "string" ? LEGACY_KEY.exec(value.trim()) : null;
  if (!match) return null;
  const [, videoId = "", segmentText = ""] = match;
  const segment = Number(segmentText);
  return Number.isSafeInteger(segment) ? videoKey({ platform: "bilibili", videoId, segment }) : null;
}

function hasContent(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  if (isFields(value)) return Object.keys(value).length > 0;
  return present(value);
}

function legacyNote(value: unknown): NoteRecord | null {
  if (!isFields(value) || !isRecordId(value.id)) return null;
  const video = legacyVideo(value.bvid, value.page);
  const atSec = finite(value.timestampSeconds);
  const { text, rawText, updatedAt } = value;
  if (!video || atSec === null || atSec < 0 || typeof text !== "string") return null;
  const createdAt = finite(value.createdAt) ?? finite(updatedAt) ?? 0;
  // 原文和正文一样时（手写的笔记）不另存一份。
  const quote = typeof rawText === "string" && rawText.trim() && rawText.trim() !== text.trim() ? rawText : undefined;
  return {
    id: value.id,
    kind: "note",
    origin: "legacy",
    video,
    snapshot: snapshotOf(value.videoTitle, value.ownerName),
    atSec,
    text,
    ...(quote === undefined ? {} : { quote }),
    derived: UNKNOWN_BASIS,
    createdAt,
    updatedAt: finite(updatedAt) ?? createdAt,
  };
}

/** 概览的视频：先从视频号和分 P 推，再和旧记录键核对；不一致、读不懂或两样都缺就跳过。 */
function legacyOverviewKey(value: Fields): VideoKey | null {
  const { bvid, page, learningId } = value;
  if (!present(bvid) && !present(learningId)) return null;
  const fromId = present(bvid) ? legacyVideo(bvid, page) : undefined;
  const fromKey = present(learningId) ? keyFromRecordKey(learningId) : undefined;
  if (fromId === null || fromKey === null) return null;
  if (fromId && fromKey && fromId !== fromKey) return null;
  return fromId ?? fromKey ?? null;
}

/** 章节和结论的依据都记成未知；结论原本标着依据官方总结的，依据里带上提示。 */
function legacyParts({ verdict }: CheckedAnalysis): OverviewParts {
  const chapters = { derived: UNKNOWN_BASIS, taskCreatedAt: LEGACY_TASK_CREATED_AT };
  if (!verdict) return { chapters };
  const derived = verdict.source === "official" ? OFFICIAL_HINT : UNKNOWN_BASIS;
  return { chapters, verdict: { derived, taskCreatedAt: LEGACY_TASK_CREATED_AT } };
}

function legacyOverview(value: unknown): OverviewRecord | null {
  if (!isFields(value) || !isFields(value.analysis)) return null;
  const key = legacyOverviewKey(value);
  if (!key) return null;
  return overviewRecord(
    key,
    snapshotOf(value.videoTitle, value.ownerName),
    value.analysis,
    value.analysisFailures,
    finite(value.updatedAt) ?? 0,
    legacyParts,
  );
}

function legacyQa(value: unknown): QaRecord | null {
  if (!isFields(value) || !isQaId(value.id)) return null;
  const video = legacyVideo(value.bvid, value.page);
  return video ? qaRecord(value.id, video, value, UNKNOWN_BASIS) : null;
}

/**
 * 读一份旧格式备份。笔记列表必须有，概览和问答可以没有；该是列表的不是列表时整份拒绝，detail 是坏的那一类。
 * 提示词的格式不对也不报错，这部分本来就不读。
 */
export function readLegacyBackup(payload: Fields): Result<ImportedBackup> {
  if (Number(payload.schemaVersion) > LEGACY_MAX_VERSION) return fail("BACKUP_TOO_NEW");
  const { notes, learning, qa } = payload;
  if (!Array.isArray(notes)) return fail("BACKUP_DAMAGED", "notes");
  if (given(learning) && !Array.isArray(learning)) return fail("BACKUP_DAMAGED", "overviews");
  if (given(qa) && !Array.isArray(qa)) return fail("BACKUP_DAMAGED", "qa");
  const readNotes = keepValid(notes, legacyNote);
  const readOverviews = keepValid(Array.isArray(learning) ? learning : [], legacyOverview);
  const readQa = keepValid(Array.isArray(qa) ? qa : [], legacyQa);
  return ok({
    format: "legacy",
    contents: { notes: readNotes.kept, overviews: readOverviews.kept, qa: readQa.kept },
    skipped: { notes: readNotes.skipped, overviews: readOverviews.skipped, qa: readQa.skipped },
    promptsDropped: Object.keys(payload).some((key) => PROMPT_KEY.test(key) && hasContent(payload[key])),
  });
}
