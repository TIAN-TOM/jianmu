// 观看会话：每个标签页一份，记这次观看的视频、模式和来源、累计播放秒数、卡片的手动展开收起。
// 存在会话存储里，浏览器重启就清空；同一标签页刷新同一个视频沿用原会话，换视频或关标签页才开新的。
// 会话服务拿不到任务和模型入口：播放上报只能改界面模式，引不出任何付费请求。
import type { ClearGuard } from "../core/clear-guard.ts";
import { fail, ok, type Result } from "../core/errors.ts";
import { decideMode, isMode, openingMode } from "../core/mode/decide.ts";
import type { CardOverride, Mode, ModeSource, SessionView } from "../core/mode/types.ts";
import { channelKey, parseVideoKey, type ChannelRef, type Platform, type VideoKey } from "../core/video-ref.ts";
import type { StorageArea } from "../platform/storage.ts";
import { isRecord } from "../shared/guards.ts";
import type { Broadcast } from "../shared/messages.ts";
import { WATCH_SESSIONS_KEY } from "../shared/names.ts";
import { errorLabel, type Log } from "./log.ts";
import type { ChannelStore } from "./stores/channels.ts";
import { createWriteGate } from "./stores/write-gate.ts";

/** 累计播放秒数最多比会话开始以来真实经过的时间多这么多：采样和消息在路上的误差。 */
export const PLAYED_SLACK_SEC = 2;

export interface WatchSession {
  readonly video: VideoKey;
  readonly mode: Mode;
  readonly modeSource: ModeSource;
  /** 这次观看自动切过，撤销了也算。 */
  readonly autoSwitched: boolean;
  /** 这次观看里主动切换过模式。 */
  readonly manualThisWatch: boolean;
  readonly playedSec: number;
  readonly startedAt: number;
  readonly cardOverride?: CardOverride;
  readonly durationSec?: number;
  readonly channel?: string;
  /** 开会话时读到的频道偏好：只定打开时的模式，看的过程中不再变。 */
  readonly channelMode?: Mode;
  /** 这个视频的时长和频道报过了：每个视频只认第一条。 */
  readonly reported: boolean;
}

export interface PlaybackInfo {
  readonly durationSec?: number;
  readonly channel?: ChannelRef;
}

/** 主动切换可以带上侧边栏读到的频道：播放页还没报频道时，靠它记住这个频道。 */
export type ModeChange = { readonly intent: "manual"; readonly mode: Mode; readonly channel?: ChannelRef } | { readonly intent: "undo-auto" };

export interface ModeOutcome {
  readonly session: SessionView;
  /** 这次切换记住了频道。 */
  readonly remembered: boolean;
}

export interface SessionsDeps {
  readonly storage: Pick<StorageArea, "get" | "set">;
  readonly channels: Pick<ChannelStore, "get" | "put" | "remove">;
  readonly guard: ClearGuard;
  readonly now: () => number;
  readonly broadcast: (message: Broadcast) => void;
  readonly log: Log;
}

export interface Sessions {
  /** 报时长和频道：换了视频开新会话，同一视频沿用原会话，回会话里的累计秒数。panelOpen 是这个标签页所在窗口的侧边栏开着，先不自动切。 */
  readonly onPlaybackInfo: (tabId: number, video: VideoKey, info: PlaybackInfo, panelOpen?: boolean) => Promise<Result<{ playedSec: number; report: boolean }>>;
  /** 报累计播放秒数：只增不减、不超过真实经过的时间，满 1 分钟时可能自动切到精读；所在窗口的侧边栏开着（panelOpen）时先不切。 */
  readonly onMilestone: (tabId: number, video: VideoKey, playedSec: number, panelOpen?: boolean) => Promise<Result<{ report: boolean }>>;
  /** 侧边栏报适配层读到的时长和频道：以它为准，补上或改掉播放页报的；变了就按新信息重新定打开时的模式。侧边栏既然开着，这时不自动切。 */
  readonly describe: (tabId: number, video: VideoKey, info: PlaybackInfo) => Promise<Result<SessionView>>;
  readonly get: (tabId: number) => Promise<SessionView | null>;
  readonly setMode: (tabId: number, video: VideoKey, change: ModeChange) => Promise<Result<ModeOutcome>>;
  readonly setCardOverride: (tabId: number, video: VideoKey, value: CardOverride) => Promise<Result<SessionView>>;
  /** 侧边栏点了「不记」：忘掉这个标签页上视频所在的频道，以后这个频道的视频回到按时长定模式；眼下的模式不变。 */
  readonly forgetChannel: (tabId: number, video: VideoKey) => Promise<Result<{ forgotten: boolean }>>;
  readonly onTabRemoved: (tabId: number) => Promise<void>;
  /** 撤了这个站的授权：它的观看会话都删掉，侧边栏不再按旧会话认出那些标签页上的视频。 */
  readonly forgetPlatform: (platform: Platform) => Promise<void>;
}

const MODE_SOURCES: ReadonlySet<unknown> = new Set<ModeSource>(["manual", "channel", "short", "default", "auto"]);
const CARD_OVERRIDES: ReadonlySet<unknown> = new Set<CardOverride>(["expanded", "collapsed"]);

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const optional = (value: unknown, check: (value: unknown) => boolean): boolean => value === undefined || check(value);

// 会话存储只有扩展自己读写，读出来仍按不可信处理：形状不对的整条不认。
function isSession(value: unknown): value is WatchSession {
  if (!isRecord(value)) return false;
  return (
    typeof value.video === "string" &&
    parseVideoKey(value.video) !== null &&
    isMode(value.mode) &&
    MODE_SOURCES.has(value.modeSource) &&
    typeof value.autoSwitched === "boolean" &&
    typeof value.manualThisWatch === "boolean" &&
    isCount(value.playedSec) &&
    isCount(value.startedAt) &&
    typeof value.reported === "boolean" &&
    optional(value.cardOverride, (item) => CARD_OVERRIDES.has(item)) &&
    optional(value.durationSec, isCount) &&
    optional(value.channel, (item) => typeof item === "string") &&
    optional(value.channelMode, isMode)
  );
}

export function sessionView(session: WatchSession): SessionView {
  const { video, mode, modeSource, autoSwitched, playedSec, cardOverride } = session;
  return { video, mode, modeSource, autoSwitched, playedSec, ...(cardOverride ? { cardOverride } : {}) };
}

// 只有累计秒数变了不算变化，不广播：不然每个在播的标签页每 10 秒广播一次。
function viewChanged(before: WatchSession | undefined, after: WatchSession): boolean {
  if (!before) return true;
  const { playedSec: _before, ...left } = sessionView(before);
  const { playedSec: _after, ...right } = sessionView(after);
  return JSON.stringify(left) !== JSON.stringify(right);
}

/** 自动切过或这次手动选过模式，内容脚本就不用再报进度。 */
const reports = (session: WatchSession): boolean => !session.autoSwitched && !session.manualThisWatch;

// 按会话现有的信息重新定模式。panelOpen 是这个标签页所在窗口的侧边栏开着：先不自动切。
function settle(session: WatchSession, panelOpen = false): WatchSession {
  const decided = decideMode({
    durationSec: session.durationSec,
    channelMode: session.channelMode,
    manualMode: session.manualThisWatch ? session.mode : undefined,
    playedSec: session.playedSec,
    current: { mode: session.mode, source: session.modeSource },
    autoSwitched: session.autoSwitched,
    panelOpen,
  });
  return {
    ...session,
    mode: decided.mode,
    modeSource: decided.source,
    autoSwitched: session.autoSwitched || decided.source === "auto",
  };
}

type Plan = (current: WatchSession | undefined) => Result<WatchSession> | Promise<Result<WatchSession>>;

export function createSessions({ storage, channels, guard, now, broadcast, log }: SessionsDeps): Sessions {
  // 全部会话放在一个键里，读—改—写排进同一个队列；清除全部数据之后不再写回。
  const gate = createWriteGate(guard, "all");

  async function load(): Promise<Record<string, WatchSession>> {
    const stored = (await storage.get(WATCH_SESSIONS_KEY))[WATCH_SESSIONS_KEY];
    if (!isRecord(stored)) return {};
    const kept: Record<string, WatchSession> = {};
    for (const [tab, session] of Object.entries(stored)) if (/^\d+$/.test(tab) && isSession(session)) kept[tab] = session;
    return kept;
  }

  const fresh = (video: VideoKey): WatchSession =>
    settle({ video, mode: "skim", modeSource: "default", autoSwitched: false, manualThisWatch: false, playedSec: 0, startedAt: now(), reported: false });

  // plan 回原来那份会话就不写。清除全部数据会连带清掉启用确认，所以清过以后回 NOT_ENABLED。
  async function mutate(tabId: number, plan: Plan): Promise<Result<WatchSession>> {
    const tab = String(tabId);
    let before: WatchSession | undefined;
    const outcome = await gate(guard.epoch(), async () => {
      const table = await load();
      before = table[tab];
      const planned = await plan(before);
      if (planned.ok && planned.value !== before) await storage.set({ [WATCH_SESSIONS_KEY]: { ...table, [tab]: planned.value } });
      return planned;
    });
    if (outcome === null) return fail("NOT_ENABLED");
    if (outcome.ok && viewChanged(before, outcome.value)) {
      broadcast({ type: "session.changed", tabId, session: sessionView(outcome.value) });
    }
    return outcome;
  }

  // 读不到频道偏好时按没选过算，不挡开会话。
  async function channelModeOf(channel: string): Promise<Mode | undefined> {
    try {
      return await channels.get(channel);
    } catch (error) {
      log.warn("读频道偏好失败，这次按没选过算", errorLabel(error));
      return undefined;
    }
  }

  async function forget(channel: string): Promise<boolean> {
    try {
      return await channels.remove(channel);
    } catch (error) {
      log.warn("忘掉频道的模式失败", errorLabel(error));
      return false;
    }
  }

  async function remember(channel: string, mode: Mode): Promise<boolean> {
    try {
      return await channels.put(channel, mode);
    } catch (error) {
      log.warn("记住频道的模式失败", errorLabel(error));
      return false;
    }
  }

  return {
    async onPlaybackInfo(tabId, video, info, panelOpen = false) {
      const result = await mutate(tabId, async (current) => {
        const base = current?.video === video ? current : fresh(video);
        if (base.reported) return ok(base);
        // 侧边栏已经报过的以侧边栏为准，播放页报的只补空着的。
        const channel = base.channel ?? (info.channel ? channelKey(info.channel) : undefined);
        const channelMode = base.channel !== undefined ? base.channelMode : channel === undefined ? undefined : await channelModeOf(channel);
        const durationSec = base.durationSec ?? info.durationSec;
        return ok(
          settle({
            ...base,
            reported: true,
            ...(durationSec === undefined ? {} : { durationSec }),
            ...(channel === undefined ? {} : { channel }),
            ...(channelMode === undefined ? {} : { channelMode }),
          }, panelOpen),
        );
      });
      return result.ok ? ok({ playedSec: result.value.playedSec, report: reports(result.value) }) : result;
    },

    async onMilestone(tabId, video, playedSec, panelOpen = false) {
      const result = await mutate(tabId, (current) => {
        // 没报过这个视频的时长和频道，先要报那一条。
        if (current?.video !== video) return fail("SESSION_NOT_FOUND");
        const elapsedSec = (now() - current.startedAt) / 1000;
        if (playedSec < current.playedSec || playedSec > elapsedSec + PLAYED_SLACK_SEC) return fail("INVALID_REQUEST");
        return ok(playedSec === current.playedSec ? current : settle({ ...current, playedSec }, panelOpen));
      });
      return result.ok ? ok({ report: reports(result.value) }) : result;
    },

    async describe(tabId, video, info) {
      const result = await mutate(tabId, async (current) => {
        if (current && current.video !== video) return fail("VIDEO_CHANGED");
        const base = current ?? fresh(video);
        const channel = info.channel ? channelKey(info.channel) : base.channel;
        const durationSec = info.durationSec ?? base.durationSec;
        if (channel === base.channel && durationSec === base.durationSec) return ok(base);
        const channelMode = channel === base.channel ? base.channelMode : channel === undefined ? undefined : await channelModeOf(channel);
        const { channelMode: _old, ...rest } = base;
        return ok(
          settle({
            ...rest,
            ...(durationSec === undefined ? {} : { durationSec }),
            ...(channel === undefined ? {} : { channel }),
            ...(channelMode === undefined ? {} : { channelMode }),
          }, true),
        );
      });
      return result.ok ? ok(sessionView(result.value)) : result;
    },

    async get(tabId) {
      const session = (await load())[String(tabId)];
      return session ? sessionView(session) : null;
    },

    async setMode(tabId, video, change) {
      const result = await mutate(tabId, (current) => {
        if (current && current.video !== video) return fail("VIDEO_CHANGED");
        if (change.intent === "undo-auto") {
          if (!current) return fail("SESSION_NOT_FOUND");
          // 已经不在自动切的结果上（比如后来手动选过），没有可撤销的。
          if (current.modeSource !== "auto") return ok(current);
          const opening = openingMode(current);
          return ok({ ...current, mode: opening.mode, modeSource: opening.source });
        }
        const base = current ?? fresh(video);
        // 播放页报的频道在先；还没报时用侧边栏带来的。
        const channel = base.channel ?? (change.channel ? channelKey(change.channel) : undefined);
        return ok({ ...base, mode: change.mode, modeSource: "manual", manualThisWatch: true, ...(channel === undefined ? {} : { channel }) });
      });
      if (!result.ok) return result;
      // 只有主动切换记住频道；撤销自动切换不记。
      const channel = change.intent === "manual" ? result.value.channel : undefined;
      const remembered = change.intent === "manual" && channel !== undefined ? await remember(channel, change.mode) : false;
      return ok({ session: sessionView(result.value), remembered });
    },

    async forgetChannel(tabId, video) {
      // 只读会话找出记的是哪个频道，会话本身不动：这次手动选的模式照旧。
      const session = (await load())[String(tabId)];
      if (!session) return fail("SESSION_NOT_FOUND");
      if (session.video !== video) return fail("VIDEO_CHANGED");
      if (session.channel === undefined) return ok({ forgotten: false });
      return ok({ forgotten: await forget(session.channel) });
    },

    async setCardOverride(tabId, video, value) {
      const result = await mutate(tabId, (current) => {
        if (current && current.video !== video) return fail("VIDEO_CHANGED");
        const base = current ?? fresh(video);
        return ok(base.cardOverride === value ? base : { ...base, cardOverride: value });
      });
      return result.ok ? ok(sessionView(result.value)) : result;
    },

    async forgetPlatform(platform) {
      const prefix = `${platform}:`;
      await gate(guard.epoch(), async () => {
        const table = await load();
        const kept = Object.entries(table).filter(([, session]) => !session.video.startsWith(prefix));
        if (kept.length === Object.keys(table).length) return;
        await storage.set({ [WATCH_SESSIONS_KEY]: Object.fromEntries(kept) });
      });
    },

    async onTabRemoved(tabId) {
      const tab = String(tabId);
      await gate(guard.epoch(), async () => {
        const table = await load();
        if (!Object.hasOwn(table, tab)) return;
        await storage.set({ [WATCH_SESSIONS_KEY]: Object.fromEntries(Object.entries(table).filter(([key]) => key !== tab)) });
      });
    },
  };
}
