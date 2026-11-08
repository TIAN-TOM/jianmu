// 导入和移除字幕文件这两条消息的请求和回复。文件在侧边栏读成文本，解析和存储在后台做。
import type { VideoKey } from "../../core/video-ref.ts";
import type { EmptyRequest } from "./core.ts";

export interface ImportAddRequest {
  readonly video: VideoKey;
  readonly fileName: string;
  /** 文件内容。大小由后台解析时核对，侧边栏读文件前也先拦一道。 */
  readonly text: string;
}

export interface ImportRemoveRequest {
  readonly video: VideoKey;
}

/** 存进去的文件名和读出的字幕条数。 */
export interface ImportReceipt {
  readonly fileName: string;
  readonly entries: number;
}

export interface ImportsApi {
  "imports.add": { req: ImportAddRequest; res: ImportReceipt };
  "imports.remove": { req: ImportRemoveRequest; res: EmptyRequest };
}
