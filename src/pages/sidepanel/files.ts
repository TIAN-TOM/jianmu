// 导出文件：在页面里拼好文本交给浏览器下载，不需要下载权限。文件名去掉系统不认的字符。
import { learningAsMarkdown, markdownFallbackName, notesAsMarkdown, type LearningInput } from "../../core/notes/markdown.ts";
import type { NoteList } from "../../core/notes/records.ts";
import type { OutputLang } from "../../core/output-lang.ts";
import { parseVideoKey, type VideoKey } from "../../core/video-ref.ts";
import { siteRules } from "../../sites/rules.ts";

const BAD_NAME = /[\\/:*?"<>|\u0000-\u001f]+/g;
const MAX_NAME = 80;

/** 文件名：去掉系统不认的字符，太长就截断，空了用后备名字。 */
export function safeFileName(title: string, fallback: string): string {
  const cleaned = title.replace(BAD_NAME, " ").replace(/\s+/g, " ").trim().slice(0, MAX_NAME).trim();
  return cleaned || fallback;
}

/** 导出时拼链接用的视频地址前缀，按这个视频所在的站点算。 */
export function videoBaseOf(video: VideoKey | null): string {
  const ref = video ? parseVideoKey(video) : null;
  const rules = ref ? siteRules[ref.platform] : undefined;
  if (!ref || !rules) return "";
  const url = rules.canonicalUrl({ platform: ref.platform, videoId: ref.videoId });
  return url.endsWith(ref.videoId) ? url.slice(0, url.length - ref.videoId.length) : "";
}

export interface MarkdownExport {
  readonly fileName: string;
  readonly markdown: string;
}

/** 学习稿：固定文字和没标题时的文件名按语言出。没有可导出的内容时回 null。 */
export function learningExport(input: LearningInput, lang: OutputLang): MarkdownExport | null {
  const markdown = learningAsMarkdown(input, videoBaseOf(input.videoKey ?? null), lang);
  if (!markdown) return null;
  return { fileName: `${safeFileName(input.title ?? "", markdownFallbackName("learning", lang))}.md`, markdown };
}

/** 笔记：grouped 时按视频分组。title 是文件名用的标题，空了按语言用后备名字。没有笔记时回 null。 */
export function notesExport(notes: NoteList, video: VideoKey | null, options: { readonly grouped: boolean; readonly title: string }, lang: OutputLang): MarkdownExport | null {
  const markdown = notesAsMarkdown(notes, videoBaseOf(video), { grouped: options.grouped, lang });
  if (!markdown) return null;
  return { fileName: `${safeFileName(options.title, markdownFallbackName("notes", lang))}.md`, markdown };
}

/** 字幕轨显示的名字：简幕替站点起的名字按界面语言换，站点页面上写着的名字照原样。 */
export function trackLabel(video: VideoKey | null, track: { readonly trackId: string; readonly label: string }, lang: OutputLang): string {
  const ref = video ? parseVideoKey(video) : null;
  return (ref && siteRules[ref.platform]?.trackName?.(track.trackId, lang)) ?? track.label;
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
