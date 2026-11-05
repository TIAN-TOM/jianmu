// 粗筛自己那份存储的形状：{ version, list: { fetchedAt, count, items }, official: { [视频键]: 官方总结 } }。
// 只有后台写；结论不在这里，它跟着概览存进长期学习资料。
// 官方总结单独存，不放进字幕缓存：字幕缓存条数有限、按 LRU 淘汰，一份稍后再看动辄几十上百个视频，
// 塞进去会把用户正在看的视频的字幕和翻译挤掉。
import { TRIAGE_STORAGE_KEY } from "../../shared/names.ts";
import type { ChannelRef, VideoKey } from "../video-ref.ts";

export const STORAGE_KEY = TRIAGE_STORAGE_KEY;
export const SCHEMA_VERSION = 1;

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
}

export interface OfficialRecord {
  readonly status?: string;
  readonly summary?: string;
  readonly outline?: readonly unknown[];
  readonly reason?: string;
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

function isItem(item: unknown): item is TriageItem {
  return Boolean(item) && typeof item === "object" && typeof (item as { videoKey?: unknown }).videoKey === "string";
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

export function withOfficial(state: unknown, key: string, record: OfficialRecord): TriageState {
  const current = normalizeState(state);
  return { ...current, official: { ...current.official, [key]: record } };
}

export function findItem(state: unknown, key: string): TriageItem | null {
  return normalizeState(state).list?.items.find((item) => item.videoKey === key) || null;
}
