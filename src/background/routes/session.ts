// 观看会话：内容脚本报时长、频道和播放进度，侧边栏读会话、报适配层读到的时长和频道、切换模式、刚记住的频道点「不记」忘掉，
// 卡片读自己所在标签页的会话、手动展开收起，设置页看记住了几个频道、全部清除。内容脚本报的视频必须等于它所在标签页地址上的视频，地址过了启用闸门才读。
import { fail, ok } from "../../core/errors.ts";
import { isMode } from "../../core/mode/decide.ts";
import type { CardOverride } from "../../core/mode/types.ts";
import { parseVideoKey, videoKey, type Platform, type VideoKey, type VideoRef } from "../../core/video-ref.ts";
import type {
  CardOverrideRequest,
  ChannelForgetRequest,
  PlaybackInfoRequest,
  SessionDescribeRequest,
  PlaybackMilestoneRequest,
  SessionGetRequest,
  SessionSetModeRequest,
} from "../../shared/messages/session.ts";
import type { PlaybackLimits } from "../limits.ts";
import type { OpenPanels } from "../open-panels.ts";
import type { HandlerCtx, Route } from "../router.ts";
import type { SenderCtx } from "../senders.ts";
import type { Sessions } from "../sessions.ts";
import type { ChannelStore } from "../stores/channels.ts";
import { isEmptyRequest, isPlainObject, isTabId, isVideoKey } from "./validate.ts";

export interface SessionRouteDeps {
  readonly sessions: Sessions;
  readonly channels: Pick<ChannelStore, "clear" | "count">;
  readonly playbackLimits: Pick<PlaybackLimits, "admitMilestone">;
  /** 内容脚本所在窗口的侧边栏开没开：开着时先不自动切到精读。 */
  readonly panels: Pick<OpenPanels, "isOpen">;
}

type SessionRoutes = {
  readonly [K in "playback.info" | "playback.milestone" | "session.get" | "session.describe" | "session.setMode" | "card.setOverride" | "channels.clear" | "channels.forget" | "channels.count"]: Route<K>;
};

// 一周：比任何正常的视频和累计播放都长，挡掉离谱的数。
const MAX_SECONDS = 7 * 24 * 3600;
// 频道编号只用来记偏好，按两站都可能出现的字符收，长度设上限；YouTube 的频道 @ 名开头带 @。
const CHANNEL_ID = /^@?[A-Za-z0-9_.-]{1,64}$/;
const CARD_OVERRIDES: ReadonlySet<unknown> = new Set<CardOverride>(["expanded", "collapsed"]);

/** 必须有 required 里的键，别的键只能是 optional 里的。 */
const keysWithin = (value: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

const isSeconds = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_SECONDS;

function isInfoRequest(req: unknown): req is PlaybackInfoRequest {
  return (
    isPlainObject(req) &&
    keysWithin(req, ["video"], ["durationSec", "channel"]) &&
    isVideoKey(req.video) &&
    (req.durationSec === undefined || (isSeconds(req.durationSec) && req.durationSec > 0)) &&
    (req.channel === undefined || (typeof req.channel === "string" && CHANNEL_ID.test(req.channel)))
  );
}

function isMilestoneRequest(req: unknown): req is PlaybackMilestoneRequest {
  return isPlainObject(req) && keysWithin(req, ["video", "playedSec"]) && isVideoKey(req.video) && isSeconds(req.playedSec);
}

// 卡片只读自己所在的标签页，不带参数；侧边栏点名标签页。
function isGetRequest(req: unknown, ctx: SenderCtx): req is SessionGetRequest {
  if (ctx.kind === "card") return isEmptyRequest(req);
  return isPlainObject(req) && keysWithin(req, ["tabId"]) && isTabId(req.tabId);
}

const isChannelId = (value: unknown): boolean => typeof value === "string" && CHANNEL_ID.test(value);

function isDescribeRequest(req: unknown): req is SessionDescribeRequest {
  return (
    isPlainObject(req) &&
    keysWithin(req, ["tabId", "video"], ["durationSec", "channel"]) &&
    isTabId(req.tabId) &&
    isVideoKey(req.video) &&
    (req.durationSec === undefined || (isSeconds(req.durationSec) && req.durationSec > 0)) &&
    (req.channel === undefined || isChannelId(req.channel))
  );
}

function isSetModeRequest(req: unknown): req is SessionSetModeRequest {
  if (!isPlainObject(req) || !isTabId(req.tabId) || !isVideoKey(req.video)) return false;
  if (req.intent === "manual") {
    return keysWithin(req, ["tabId", "video", "intent", "mode"], ["channel"]) && isMode(req.mode) && (req.channel === undefined || isChannelId(req.channel));
  }
  return req.intent === "undo-auto" && keysWithin(req, ["tabId", "video", "intent"]);
}

function isForgetRequest(req: unknown): req is ChannelForgetRequest {
  return isPlainObject(req) && keysWithin(req, ["tabId", "video"]) && isTabId(req.tabId) && isVideoKey(req.video);
}

function isOverrideRequest(req: unknown): req is CardOverrideRequest {
  return isPlainObject(req) && keysWithin(req, ["video", "value"]) && isVideoKey(req.video) && CARD_OVERRIDES.has(req.value);
}

function keyOf(ref: VideoRef): VideoKey | null {
  try {
    return videoKey(ref);
  } catch {
    return null;
  }
}

interface ContentTab {
  readonly tabId: number;
  readonly site: Platform;
  readonly video: VideoKey;
}

/** 内容脚本所在的标签页和地址上的视频。消息里的视频只作提示，和地址上的对不上就不认。 */
function contentTab({ sender }: HandlerCtx, claimed: VideoKey): ContentTab | "FORBIDDEN" | "VIDEO_CHANGED" {
  if (!("site" in sender) || sender.tabId === undefined) return "FORBIDDEN";
  const actual = keyOf(sender.video);
  return actual === claimed ? { tabId: sender.tabId, site: sender.site, video: actual } : "VIDEO_CHANGED";
}

export function sessionRoutes({ sessions, channels, playbackLimits, panels }: SessionRouteDeps): SessionRoutes {
  // 内容脚本所在窗口的侧边栏开着：人可能正读着速读，先不自动切。不知道窗口时当关着。
  const panelOpen = ({ sender }: HandlerCtx): Promise<boolean> => (sender.windowId === undefined ? Promise.resolve(false) : panels.isOpen(sender.windowId));

  return {
    "playback.info": {
      senders: ["content:bilibili", "content:youtube"],
      video: "from-sender",
      validate: isInfoRequest,
      async handler(req, ctx) {
        const tab = contentTab(ctx, req.video);
        if (typeof tab === "string") return fail(tab);
        return sessions.onPlaybackInfo(
          tab.tabId,
          tab.video,
          {
            ...(req.durationSec === undefined ? {} : { durationSec: req.durationSec }),
            ...(req.channel === undefined ? {} : { channel: { platform: tab.site, channelId: req.channel } }),
          },
          await panelOpen(ctx),
        );
      },
    },
    "playback.milestone": {
      senders: ["content:bilibili", "content:youtube"],
      video: "from-sender",
      validate: isMilestoneRequest,
      async handler(req, ctx) {
        const tab = contentTab(ctx, req.video);
        if (typeof tab === "string") return fail(tab);
        if (!playbackLimits.admitMilestone(tab.tabId)) return fail("PLAYBACK_RATE_LIMITED");
        return sessions.onMilestone(tab.tabId, tab.video, req.playedSec, await panelOpen(ctx));
      },
    },
    "session.get": {
      senders: ["panel", "card"],
      idempotent: true,
      validate: isGetRequest,
      async handler(req, { sender }) {
        const tabId = sender.kind === "card" ? sender.tabId : (req as { tabId: number }).tabId;
        if (tabId === undefined) return fail("FORBIDDEN");
        return ok({ session: await sessions.get(tabId) });
      },
    },
    "session.describe": {
      senders: ["panel"],
      validate: isDescribeRequest,
      async handler(req) {
        const platform = parseVideoKey(req.video)?.platform;
        const result = await sessions.describe(req.tabId, req.video, {
          ...(req.durationSec === undefined ? {} : { durationSec: req.durationSec }),
          ...(req.channel && platform ? { channel: { platform, channelId: req.channel } } : {}),
        });
        return result.ok ? ok({ session: result.value }) : result;
      },
    },
    "session.setMode": {
      senders: ["panel"],
      validate: isSetModeRequest,
      async handler(req) {
        // 侧边栏带来的频道按标签页上视频所在的站算。
        const platform = parseVideoKey(req.video)?.platform;
        const change =
          req.intent === "manual"
            ? { intent: "manual" as const, mode: req.mode, ...(req.channel && platform ? { channel: { platform, channelId: req.channel } } : {}) }
            : { intent: "undo-auto" as const };
        return sessions.setMode(req.tabId, req.video, change);
      },
    },
    "card.setOverride": {
      senders: ["card"],
      validate: isOverrideRequest,
      async handler(req, { sender }) {
        // 只改卡片自己所在的标签页。
        if (sender.tabId === undefined) return fail("FORBIDDEN");
        const result = await sessions.setCardOverride(sender.tabId, req.video, req.value);
        return result.ok ? ok({ session: result.value }) : result;
      },
    },
    "channels.clear": {
      senders: ["page"],
      pages: ["options"],
      validate: isEmptyRequest,
      async handler() {
        return (await channels.clear()) ? ok({}) : fail("NOT_ENABLED");
      },
    },
    "channels.forget": {
      senders: ["panel"],
      validate: isForgetRequest,
      handler: (req) => sessions.forgetChannel(req.tabId, req.video),
    },
    "channels.count": {
      senders: ["page"],
      pages: ["options"],
      idempotent: true,
      validate: isEmptyRequest,
      handler: async () => ok({ count: await channels.count() }),
    },
  };
}
