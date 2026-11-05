// 字幕语种：决定翻译方向。
import type { CaptionEntries, MaybeCaptionEntry } from "./segment.ts";

/**
 * 中文字幕译成英文，外文字幕译成中文。自动字幕的语言码带前缀，脱掉再看主语言；
 * 拿不到语言码时按中文处理：B 站以中文视频为主，这个方向猜错代价更小。
 */
export function isChineseSubtitle(language: string | null | undefined): boolean {
  const code = String(language || "")
    .trim()
    .toLowerCase();
  if (!code) return true;
  return code.replace(/^ai[-_]/, "").startsWith("zh");
}

/**
 * 用户导入的字幕文件不带语言码，按正文猜一个，只用来定翻译方向（见 isChineseSubtitle）。
 * 汉字按字数、拼音文字按词数比：中文字幕里夹几个英文术语、英文字幕里夹一个中文地名都不改判。
 * 假名占汉字和假名的两成以上算日文，韩文音节最多算韩文；一个字都认不出时按中文处理。
 */
export function guessSubtitleLanguage(entries: CaptionEntries): string {
  const list: readonly MaybeCaptionEntry[] = Array.isArray(entries) ? entries : [];
  const text = list.map((entry) => String(entry?.text || "")).join("\n");
  const count = (pattern: RegExp): number => (text.match(pattern) || []).length;
  const han = count(/\p{Script=Han}/gu);
  const kana = count(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  const hangul = count(/\p{Script=Hangul}/gu);
  const latinWords = count(/\p{Script=Latin}+/gu);
  const otherWords = count(/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Latin}\P{L}]+/gu);
  if (kana && kana >= (han + kana) * 0.2) return "ja";
  if (hangul && hangul > han && hangul > latinWords + otherWords) return "ko";
  if (han >= latinWords + otherWords) return "zh-CN";
  return latinWords >= otherWords ? "en" : "und";
}
