// 粗筛自己那份存储的形状：{ version, list: { fetchedAt, count, items }, official: { [视频键]: 官方总结 } }。
// 只有后台写；结论不在这里，它跟着概览存进长期学习资料。读到的列表存 30 天，过期按没读过。
// 官方总结单独存，不放进字幕缓存：字幕缓存条数有限、按 LRU 淘汰，一份稍后再看动辄几十上百个视频，
// 塞进去会把用户正在看的视频的字幕和翻译挤掉。
import { TRIAGE_STORAGE_KEY } from "../../shared/names.ts";
import { parseVideoKey, type ChannelRef, type VideoKey, type VideoRef } from "../video-ref.ts";

export const STORAGE_KEY = TRIAGE_STORAGE_KEY;
export const SCHEMA_VERSION = 1;
/** 读到的列表和官方总结在本机存多久：过了按没读过处理，用户重新读取。 */
export const TRIAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface TriageItem {
  /** 必须是第 1 P 的键：多 P 视频按第 1 P 粗筛，官方总结和结论都记在这个键上。 */
  readonly videoKey: VideoKey;
  readonly title?: string;
  readonly ownerName?: string;
  readonly channel?: ChannelRef;
  readonly mediaVersion?: string;
  readonly duration?: number;
  readonly progress?: number;
  readonly finished?: boolean;
  readonly pageCount?: number;
  readonly available?: boolean;
  readonly description?: string;
  /** 封面图的地址，粗筛页显示用。 */
  readonly cover?: string;
  /** 列表里确认过付费状态才是真；不是真的条目，读官方总结之前先读一次视频信息。 */
  readonly paidChecked?: boolean;
}

export interface OfficialRecord {
  readonly status?: string;
  readonly summary?: string;
  readonly outline?: readonly unknown[];
  readonly reason?: string;
  /** 有内容时的正文指纹：写结论时据此记下依据的是哪一版官方总结。 */
  readonly fingerprint?: string;
  /** 问到的时间。 */
  readonly fetchedAt?: number;
}

export type OfficialMap = Readonly<Record<string, OfficialRecord | undefined>>;

export interface TriageList {
  readonly fetchedAt: number;
  readonly count: number;
  readonly items: readonly TriageItem[];
}

export interface TriageState {
  version: number;
  list: TriageList | null;
  official: Record<string, OfficialRecord>;
}

export interface ListUpdate {
  readonly items?: readonly TriageItem[];
  readonly count?: number;
  readonly fetchedAt?: number;
}

interface RawState {
  readonly list?: { readonly items?: unknown; readonly fetchedAt?: unknown; readonly count?: unknown };
  readonly official?: unknown;
}

/** 粗筛只认 B 站第 1 P 的视频键：多 P 视频按第 1 P 粗筛，认不出的、别的分 P 一律不收。 */
export function triageRef(key: unknown): VideoRef | null {
  if (typeof key !== "string") return null;
  const ref = parseVideoKey(key);
  return ref?.platform === "bilibili" && ref.segment === 1 ? ref : null;
}

function isItem(item: unknown): item is TriageItem {
  return Boolean(item) && typeof item === "object" && triageRef((item as { videoKey?: unknown }).videoKey) !== null;
}

export function emptyState(): TriageState {
  return { version: SCHEMA_VERSION, list: null, official: {} };
}

export function normalizeState(raw: unknown): TriageState {
  const state = emptyState();
  if (!raw || typeof raw !== "object") return state;
  const { list, official } = raw as RawState;
  if (list && typeof list === "object" && Array.isArray(list.items)) {
    const items = (list.items as readonly unknown[]).filter(isItem);
    state.list = {
      fetchedAt: Number(list.fetchedAt) || 0,
      count: Number(list.count) || items.length,
      items,
    };
  }
  if (official && typeof official === "object") {
    for (const [key, record] of Object.entries(official as OfficialMap)) {
      if (record && typeof record === "object") state.official[key] = record;
    }
  }
  return state;
}

// 换了一份列表：已经不在列表里的视频，连同它们的官方总结一起清掉，存储不会越积越多。
export function withList(
  state: unknown,
  { items = [], count = 0, fetchedAt = Date.now() }: ListUpdate = {},
): TriageState {
  const current = normalizeState(state);
  const keep = new Set<string>(items.map((item) => item.videoKey));
  const official: Record<string, OfficialRecord> = {};
  for (const [key, record] of Object.entries(current.official)) {
    if (keep.has(key)) official[key] = record;
  }
  return {
    ...current,
    list: { fetchedAt, count: Number(count) || items.length, items },
    official,
  };
}

/**
 * 本机现在算数的那份：列表过了期限，或者根本没有列表，都按没读过处理，官方总结一起不算。
 * 读到的时间缺失或读不懂时记成 0，也就算过期。
 */
export function freshState(raw: unknown, now: number): TriageState {
  const state = normalizeState(raw);
  if (!state.list || now - state.list.fetchedAt >= TRIAGE_TTL_MS) return emptyState();
  return state;
}

/** 这个视频看不了（付费、确认不了付费、找不到）：之后两步都跳过它。 */
export function withUnavailable(state: unknown, key: string): TriageState {
  const current = normalizeState(state);
  if (!current.list) return current;
  const items = current.list.items.map((item) => (item.videoKey === key ? { ...item, available: false } : item));
  return { ...current, list: { ...current.list, items } };
}

export function withOfficial(state: unknown, key: string, record: OfficialRecord): TriageState {
  const current = normalizeState(state);
  return { ...current, official: { ...current.official, [key]: record } };
}

export function findItem(state: unknown, key: string): TriageItem | null {
  return normalizeState(state).list?.items.find((item) => item.videoKey === key) || null;
}
