// 取字幕和查原视频还在不在。卡片只能用轻量读取，而且只带视频和读取方式；轻量读取不看语言、刷新和标签页，带了也拒。
import { ok } from "../../core/errors.ts";
import { parseVideoKey, type VideoRef } from "../../core/video-ref.ts";
import type { TranscriptGetRequest, VideoCheckRequest } from "../../shared/messages/transcript.ts";
import type { Route } from "../router.ts";
import type { SenderCtx } from "../senders.ts";
import type { TranscriptService } from "../services/transcript/index.ts";
import { isVideoKey } from "./validate.ts";

export interface TranscriptRouteDeps {
  readonly transcript: Pick<TranscriptService, "get" | "light" | "checkAvailable">;
}

type TranscriptRoutes = { readonly [K in "transcript.get" | "video.checkAvailable"]: Route<K> };

const MODES: ReadonlySet<unknown> = new Set(["full", "cache-only", "light"]);
// 语言码只用来在列出的字幕轨里找同名的那条。
const LANG = /^[A-Za-z0-9_-]{1,32}$/;

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const keysWithin = (value: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

const isTabId = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0;

function isGetRequest(req: unknown, ctx: SenderCtx): req is TranscriptGetRequest {
  if (!isPlainObject(req) || !isVideoKey(req.video) || !MODES.has(req.mode)) return false;
  if (req.mode === "light") return keysWithin(req, ["video", "mode"]);
  if (ctx.kind === "card") return false;
  return (
    keysWithin(req, ["video", "mode"], ["lang", "fresh", "tabId"]) &&
    (req.lang === undefined || (typeof req.lang === "string" && LANG.test(req.lang))) &&
    (req.fresh === undefined || typeof req.fresh === "boolean") &&
    (req.tabId === undefined || isTabId(req.tabId))
  );
}

function isCheckRequest(req: unknown): req is VideoCheckRequest {
  return isPlainObject(req) && keysWithin(req, ["video"]) && isVideoKey(req.video);
}

// 形状核对时已经确认解析得出。
const refOf = (video: string): VideoRef => parseVideoKey(video) as VideoRef;

export function transcriptRoutes({ transcript }: TranscriptRouteDeps): TranscriptRoutes {
  return {
    "transcript.get": {
      senders: ["panel", "page", "card"],
      pages: ["options", "triage"],
      idempotent: true,
      validate: isGetRequest,
      handler: ({ video, mode, lang, fresh, tabId }) =>
        mode === "light" ? transcript.light(refOf(video)) : transcript.get(refOf(video), { mode, lang, fresh, tabId }),
    },
    "video.checkAvailable": {
      senders: ["panel", "page"],
      pages: ["options", "triage"],
      idempotent: true,
      validate: isCheckRequest,
      handler: async ({ video }) => ok({ available: await transcript.checkAvailable(refOf(video)) }),
    },
  };
}
