// 导入和移除字幕文件：只收侧边栏。解析、存储和作废缓存都在取字幕服务里做，这里只核对请求形状。
import { parseVideoKey, type VideoRef } from "../../core/video-ref.ts";
import type { ImportAddRequest, ImportRemoveRequest } from "../../shared/messages/imports.ts";
import type { Route } from "../router.ts";
import type { TranscriptService } from "../services/transcript/index.ts";
import { isVideoKey } from "./validate.ts";

export interface ImportRouteDeps {
  readonly transcript: Pick<TranscriptService, "importFile" | "removeImport">;
}

type ImportRoutes = { readonly [K in "imports.add" | "imports.remove"]: Route<K> };

// 文件名只用来认扩展名和显示，过长的截掉；正文的大小由解析时核对，给出能看懂的原因。
const MAX_FILE_NAME = 1000;

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const hasOnly = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  keys.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => keys.includes(key));

function isAddRequest(req: unknown): req is ImportAddRequest {
  return (
    isPlainObject(req) &&
    hasOnly(req, ["video", "fileName", "text"]) &&
    isVideoKey(req.video) &&
    typeof req.fileName === "string" &&
    req.fileName.length > 0 &&
    req.fileName.length <= MAX_FILE_NAME &&
    typeof req.text === "string"
  );
}

function isRemoveRequest(req: unknown): req is ImportRemoveRequest {
  return isPlainObject(req) && hasOnly(req, ["video"]) && isVideoKey(req.video);
}

// 形状核对时已经确认解析得出。
const refOf = (video: string): VideoRef => parseVideoKey(video) as VideoRef;

export function importRoutes({ transcript }: ImportRouteDeps): ImportRoutes {
  return {
    "imports.add": {
      senders: ["panel"],
      validate: isAddRequest,
      handler: ({ video, fileName, text }) => transcript.importFile(refOf(video), { name: fileName, text }),
    },
    "imports.remove": {
      senders: ["panel"],
      validate: isRemoveRequest,
      handler: ({ video }) => transcript.removeImport(refOf(video)),
    },
  };
}
