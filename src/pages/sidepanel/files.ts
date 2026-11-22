// 导出文件：在页面里拼好文本交给浏览器下载，不需要下载权限。文件名去掉系统不认的字符。
import { learningAsMarkdown, markdownFallbackName, notesAsMarkdown, type LearningInput } from "../../core/notes/markdown.ts";
import type { NoteList } from "../../core/notes/records.ts";
import type { OutputLang } from "../../core/output-lang.ts";
import { sourceLabel, type CaptionKind } from "../../core/transcript/sources.ts";
import { parseVideoKey, type VideoKey, type VideoRef } from "../../core/video-ref.ts";
import { siteRules } from "../../sites/rules.ts";

const BAD_NAME = /[\\/:*?"<>|\u0000-\u001f]+/g;
const MAX_NAME = 80;

/** 文件名：去掉系统不认的字符，太长就截断，空了用后备名字。 */
export function safeFileName(title: string, fallback: string): string {
  const cleaned = title.replace(BAD_NAME, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME).trim();
  return cleaned || fallback;
}

/** 导出里的视频链接：按视频所在站点的地址规则生成，认不出的站或身份不合规则时回空串。 */
export function videoLink(ref: VideoRef, atSec: number): string {
  const rules = siteRules[ref.platform];
  if (!rules) return "";
  try {
    return rules.canonicalUrl(ref, atSec);
  } catch {
    return "";
  }
}

export interface MarkdownExport {
  readonly fileName: string;
  readonly markdown: string;
}

/** 学习稿：固定文字和没标题时的文件名按语言出。没有可导出的内容时回 null。 */
export function learningExport(input: LearningInput, lang: OutputLang): MarkdownExport | null {
  const markdown = learningAsMarkdown(input, videoLink, lang);
  if (!markdown) return null;
  return { fileName: `${safeFileName(input.title ?? "", markdownFallbackName("learning", lang))}.md`, markdown };
}

/** 笔记：grouped 时按视频分组。title 是文件名用的标题，空了按语言用后备名字。没有笔记时回 null。 */
export function notesExport(notes: NoteList, options: { readonly grouped: boolean; readonly title: string }, lang: OutputLang): MarkdownExport | null {
  const markdown = notesAsMarkdown(notes, videoLink, { grouped: options.grouped, lang });
  if (!markdown) return null;
  return { fileName: `${safeFileName(options.title, markdownFallbackName("notes", lang))}.md`, markdown };
}

// 字幕轨列表里的轨自己带来源，读到的字幕把来源记在依据里。
interface ShownTrack {
  readonly trackId: string;
  readonly label: string;
  readonly kind?: CaptionKind;
  readonly ref?: { readonly kind?: CaptionKind };
}

/** 字幕轨显示的名字：简幕起的名字和站点给的名字按界面语言换，换不了的照原样。 */
export function trackLabel(video: VideoKey | null, track: ShownTrack, lang: OutputLang): string {
  const kind = track.kind ?? track.ref?.kind;
  const own = sourceLabel(kind, lang);
  if (own) return own;
  const ref = video ? parseVideoKey(video) : null;
  return (ref && siteRules[ref.platform]?.trackName?.(track.trackId, lang, kind)) ?? track.label;
}

export function downloadText(fileName: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
