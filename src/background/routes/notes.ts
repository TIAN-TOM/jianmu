// 笔记：侧边栏和扩展页面存、改、删、列，存的时候可以带整理好的正文。播放页的内容脚本只能在当前视频的当前时间点记一条：
// 字段只收视频和时间，不许夹带正文（带正文的笔记跳过字幕原文直接入库）；视频以发送方标签页地址上的为准，
// 消息里的视频对不上就拒。播放页来的笔记每分钟只润色几条。
import { fail } from "../../core/errors.ts";
import { videoKey, type VideoKey, type VideoRef } from "../../core/video-ref.ts";
import type { NoteAtTimeRequest, NoteDeleteRequest, NoteListRequest, NoteSaveRequest, NoteUpdateRequest } from "../../shared/messages/notes.ts";
import type { Route } from "../router.ts";
import type { NotesService } from "../services/notes.ts";
import { isVideoKey } from "./validate.ts";

export interface NoteRouteDeps {
  readonly notes: NotesService;
  /** 播放页来的笔记这会儿还能不能润色。 */
  readonly playerNotePolish: () => boolean;
}

type NoteRoutes = { readonly [K in "notes.save" | "notes.saveAtTime" | "notes.list" | "notes.update" | "notes.delete"]: Route<K> };

const MAX_ID = 100;
// 一周：比任何正常的视频都长，挡掉离谱的数。
const MAX_SECONDS = 7 * 24 * 3600;
// 正文原样能收多长；超过笔记上限的由服务按太长报。
const RAW_TEXT_MAX = 20_000;
const PAGES = ["options", "triage"] as const;

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

/** 必须有 required 里的键，别的键只能是 optional 里的。 */
const keysWithin = (value: Readonly<Record<string, unknown>>, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));

const isSeconds = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_SECONDS;
const isId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_ID;
const isText = (value: unknown): value is string => typeof value === "string" && value.length <= RAW_TEXT_MAX;

function isSaveRequest(req: unknown): req is NoteSaveRequest {
  return isPlainObject(req) && keysWithin(req, ["video", "atSec"], ["text"]) && isVideoKey(req.video) && isSeconds(req.atSec) && (req.text === undefined || isText(req.text));
}

function isAtTimeRequest(req: unknown): req is NoteAtTimeRequest {
  return isPlainObject(req) && keysWithin(req, ["video", "atSec"]) && isVideoKey(req.video) && isSeconds(req.atSec);
}

const isListRequest = (req: unknown): req is NoteListRequest => isPlainObject(req) && keysWithin(req, [], ["video"]) && (req.video === undefined || isVideoKey(req.video));

const isUpdateRequest = (req: unknown): req is NoteUpdateRequest => isPlainObject(req) && keysWithin(req, ["id", "text"]) && isId(req.id) && isText(req.text);

const isDeleteRequest = (req: unknown): req is NoteDeleteRequest => isPlainObject(req) && keysWithin(req, ["id"]) && isId(req.id);

function keyOf(ref: VideoRef): VideoKey | null {
  try {
    return videoKey(ref);
  } catch {
    return null;
  }
}

export function noteRoutes({ notes, playerNotePolish }: NoteRouteDeps): NoteRoutes {
  return {
    "notes.save": {
      senders: ["panel", "page"],
      pages: PAGES,
      validate: isSaveRequest,
      handler: (req) => notes.save(req),
    },
    "notes.saveAtTime": {
      senders: ["content:bilibili", "content:youtube"],
      video: "from-sender",
      validate: isAtTimeRequest,
      async handler(req, { sender }) {
        // 视频以标签页地址上的为准：页面脚本能伪造消息，改不了标签页正在放的视频。
        const playing = "site" in sender ? keyOf(sender.video) : null;
        if (!playing || playing !== req.video) return fail("FORBIDDEN");
        return notes.save({ video: playing, atSec: req.atSec }, { mayPolish: playerNotePolish });
      },
    },
    "notes.list": {
      senders: ["panel", "page"],
      pages: PAGES,
      idempotent: true,
      validate: isListRequest,
      handler: (req) => notes.list(req.video),
    },
    "notes.update": {
      senders: ["panel", "page"],
      pages: PAGES,
      validate: isUpdateRequest,
      handler: (req) => notes.update(req.id, req.text),
    },
    "notes.delete": {
      senders: ["panel", "page"],
      pages: PAGES,
      validate: isDeleteRequest,
      handler: (req) => notes.remove(req.id),
    },
  };
}
