// 笔记的请求和回复。侧边栏和扩展页面可以带整理好的正文；播放页的内容脚本只能在所在标签页的视频上记一个时间点。
import type { NoteRecord } from "../../core/notes/records.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { EmptyRequest } from "./core.ts";

/** 给页面看的一条笔记：链接按视频和时间现拼；润色还在跑的带标记，后台重启后就没有这个标记了。 */
export interface NoteItemView extends NoteRecord {
  readonly url: string;
  readonly polishing?: true;
}

export interface NoteSaveRequest {
  readonly video: VideoKey;
  readonly atSec: number;
  /** 已经整理好的正文，不再过模型。 */
  readonly text?: string;
}

/** 播放页记笔记：只有视频和时间点，视频必须是内容脚本所在标签页正在放的那个。 */
export interface NoteAtTimeRequest {
  readonly video: VideoKey;
  readonly atSec: number;
}

export interface NoteSaveView {
  readonly note: NoteItemView;
  /** 同一视频同一秒已经有一条，没有再存。 */
  readonly duplicate?: true;
  /** 润色名额用完了，只存了原文。 */
  readonly polishLimited?: true;
}

export interface NoteListRequest {
  /** 不带时列出全部笔记。 */
  readonly video?: VideoKey;
}

export interface NoteListView {
  readonly notes: readonly NoteItemView[];
}

export interface NoteUpdateRequest {
  readonly id: string;
  readonly text: string;
}

export interface NoteUpdateView {
  readonly note: NoteItemView;
}

export interface NoteDeleteRequest {
  readonly id: string;
}

export interface NotesApi {
  "notes.save": { req: NoteSaveRequest; res: NoteSaveView };
  "notes.saveAtTime": { req: NoteAtTimeRequest; res: NoteSaveView };
  "notes.list": { req: NoteListRequest; res: NoteListView };
  "notes.update": { req: NoteUpdateRequest; res: NoteUpdateView };
  "notes.delete": { req: NoteDeleteRequest; res: EmptyRequest };
}
