// 取字幕服务的测试架子：站点换成替身，缓存和导入字幕用真实仓储加内存驱动，计时器手动推进，清除闸门是真的。
import { createTranscriptService, type TranscriptDeps, type TranscriptService } from "../../src/background/services/transcript/index.ts";
import type { CachedTranscript, TranscriptCache } from "../../src/background/services/transcript/write.ts";
import { createCacheStore, type CacheEntry } from "../../src/background/stores/cache.ts";
import { createImportStore, type ImportRecord } from "../../src/background/stores/imports.ts";
import { createOverviewStore } from "../../src/background/stores/overviews.ts";
import { createClearGuard, type ClearGuard } from "../../src/core/clear-guard.ts";
import type { OverviewRecord } from "../../src/core/notes/records.ts";
import { videoKey, type VideoKey, type VideoRef } from "../../src/core/video-ref.ts";
import type { ObjectStoreDriver } from "../../src/platform/idb.ts";
import type { TranscriptReply, TranscriptView } from "../../src/shared/messages/transcript.ts";
import type { CaptionTrack, SiteCtx } from "../../src/sites/types.ts";
import { EN, fakeSiteService, SAMPLE_ID, sampleCues, sampleInfo, ZH, type FakeSiteService, type SiteScript } from "./fake-site-service.ts";
import { manualTimers, type ManualTimers } from "./manual-timers.ts";
import { createMemoryDriver } from "./memory-driver.ts";

export type Row = CacheEntry<CachedTranscript>;

export const START = 1_800_000_000_000;
export const REF: VideoRef = { platform: "bilibili", videoId: SAMPLE_ID, segment: 1 };
export const KEY: VideoKey = videoKey(REF);
export const OTHER_REF: VideoRef = { platform: "bilibili", videoId: "BV1Sample002", segment: 1 };

/** 缓存里已有的一条：给定语言的字幕，列过的轨默认是中文和英文。 */
export function cachedRow(track: CaptionTrack = ZH, overrides: Partial<CachedTranscript> = {}, ref: VideoRef = REF): Row {
  return {
    videoKey: videoKey(ref),
    timestamp: START,
    info: sampleInfo(ref),
    transcript: {
      ref: { video: videoKey(ref), kind: track.kind, lang: track.lang, fingerprint: "0123456789abcdef" },
      trackId: track.trackId,
      label: track.label,
      cues: [{ start: 0, duration: 1, text: `缓存里的${track.lang}字幕` }],
    },
    tracks: [ZH, EN],
    chapters: [],
    ...overrides,
  };
}

export interface HarnessOptions {
  readonly site?: Partial<SiteScript>;
  readonly seed?: readonly Row[];
  readonly guard?: ClearGuard;
  readonly wrapDriver?: (inner: ObjectStoreDriver<Row>) => ObjectStoreDriver<Row>;
  readonly wrapCache?: (inner: TranscriptCache) => TranscriptCache;
  readonly imports?: readonly ImportRecord[];
  /** 本机已有的概览：轻量读取带回去。 */
  readonly overviews?: readonly OverviewRecord[];
  readonly tabTitles?: Readonly<Record<number, string>>;
  /** 官方总结附带的字幕兜底。生产里关着，用到它的测试才打开。 */
  readonly officialCaptionsFallback?: boolean;
}

export interface Harness {
  readonly site: FakeSiteService;
  readonly timers: ManualTimers;
  readonly guard: ClearGuard;
  readonly driver: ObjectStoreDriver<Row>;
  /** 导入字幕仓库的驱动：测试可以直接放一份进去，绕过导入那一步。 */
  readonly importsDriver: ObjectStoreDriver<ImportRecord>;
  readonly overviewsDriver: ObjectStoreDriver<OverviewRecord>;
  readonly service: TranscriptService;
  /** 服务建过的读取环境，按建的先后。 */
  readonly ctxs: SiteCtx[];
  /** 读过哪些标签页的标题。 */
  readonly titleReads: number[];
  readonly rows: () => Promise<Row[]>;
}

export function harness(options: HarnessOptions = {}): Harness {
  const site = fakeSiteService(options.site);
  const timers = manualTimers(START);
  const guard = options.guard ?? createClearGuard();
  const driver = (options.wrapDriver ?? ((inner) => inner))(createMemoryDriver<Row>("cache", options.seed ?? []));
  const store = createCacheStore<CachedTranscript>({ driver, guard, now: timers.now });
  const cache = options.wrapCache ? options.wrapCache(store) : store;
  const importsDriver = createMemoryDriver<ImportRecord>("imports", options.imports ?? []);
  const overviewsDriver = createMemoryDriver<OverviewRecord>("overviews", options.overviews ?? []);
  const ctxs: SiteCtx[] = [];
  const titleReads: number[] = [];
  const deps: TranscriptDeps = {
    sites: {
      service: (platform) => (platform === site.service.rules.platform ? site.service : undefined),
      ctx(_platform, { signal }) {
        const ctx: SiteCtx = {
          fetch: () => Promise.reject(new Error("替身不发请求")),
          signal,
          backoff: { admit: async () => ({ ok: true }), trip: async () => {}, clear: async () => {} },
        };
        ctxs.push(ctx);
        return ctx;
      },
    },
    cache,
    imports: createImportStore({ driver: importsDriver, guard }),
    overviews: createOverviewStore({ driver: overviewsDriver, guard, now: timers.now }),
    guard,
    async tabTitle(tabId) {
      titleReads.push(tabId);
      return options.tabTitles?.[tabId] ?? null;
    },
    timers,
    log: { warn() {}, error() {} },
    officialCaptionsFallback: options.officialCaptionsFallback ?? false,
  };
  return { site, timers, guard, driver, importsDriver, overviewsDriver, service: createTranscriptService(deps), ctxs, titleReads, rows: () => driver.getAll() };
}

/** 成功的回复。 */
export function view(reply: TranscriptReply): TranscriptView {
  if (!reply.ok) throw new Error(`应该成功：${JSON.stringify(reply)}`);
  return reply.value;
}

export const texts = (reply: TranscriptReply): string => view(reply).transcript.cues.map((cue) => cue.text).join("\n");

export { EN, sampleCues, sampleInfo, ZH };
