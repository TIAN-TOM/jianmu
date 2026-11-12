// 导出文件：在页面里拼好文本交给浏览器下载，不需要下载权限。文件名去掉系统不认的字符。
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
