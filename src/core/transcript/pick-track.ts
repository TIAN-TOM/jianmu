// 选字幕轨，用在拿得到完整轨列表的站。顺序固定在这里：原语言人工字幕、中文人工字幕、原语言自动字幕，其余排后。
import type { CaptionKind } from "./sources.ts";

export interface PickableTrack {
  readonly lang: string;
  readonly kind: CaptionKind;
  readonly isOriginalLang?: boolean | undefined;
}

export interface PickByLangOptions {
  readonly strict?: boolean | undefined;
  readonly audioLang?: string | null | undefined;
}

// 同一档里的先后：具体中文（简体、繁体）在前，地区别名其次，再是英文。
// 其余那一档里人工在自动之前，自动中文排在人工英文之后，避免只有机翻中文的英文视频被固定成中文。
const LANG_PREFERENCE: readonly string[] = Object.freeze([
  "zh-Hans",
  "zh-Hant",
  "zh",
  "zh-CN",
  "en",
  "en-US",
  "ai-zh",
  "ai-en",
]);

function baseLang(lang: string | null | undefined): string {
  const [base = ""] = String(lang || "")
    .replace(/^ai[-_]/i, "")
    .split("-");
  return base.toLowerCase();
}

function langRank(track: PickableTrack): number {
  const index = LANG_PREFERENCE.indexOf(track.lang);
  return index === -1 ? LANG_PREFERENCE.length : index;
}

// 适配层明确标过原语言就听它的；没标时拿语言码和视频的原语言比。
// 两样都没有就没有轨算原语言，只分中文人工和其余两档，同档里人工在前，再按语言表排。
function tierOf(track: PickableTrack, audio: string): number {
  const base = baseLang(track.lang);
  const original = track.isOriginalLang ?? (audio !== "" && base === audio);
  if (track.kind === "human" && original) return 0;
  if (track.kind === "human" && base === "zh") return 1;
  if (track.kind === "auto" && original) return 2;
  return 3;
}

/** audioLang 是视频的原语言，拿不到时不传，不拿轨的多少去猜。 */
export function pickTrack<T extends PickableTrack>(
  tracks: readonly T[] | null | undefined,
  audioLang?: string | null,
): T | null {
  const list: readonly T[] = Array.isArray(tracks) ? tracks : [];
  const audio = baseLang(typeof audioLang === "string" ? audioLang : "");
  const [first] = [...list].sort((a, b) => {
    const byTier = tierOf(a, audio) - tierOf(b, audio);
    if (byTier !== 0) return byTier;
    const byKind = Number(a.kind !== "human") - Number(b.kind !== "human");
    if (byKind !== 0) return byKind;
    return langRank(a) - langRank(b);
  });
  return first ?? null;
}

// 用户点名要哪条就用哪条。strict 时列表里没有就返回 null，避免静默退回中文。
export function pickTrackByLang<T extends PickableTrack>(
  tracks: readonly T[] | null | undefined,
  lang: string | null | undefined,
  options?: PickByLangOptions | null,
): T | null {
  const list: readonly T[] = Array.isArray(tracks) ? tracks : [];
  if (list.length === 0) return null;
  const target = lang ? String(lang) : "";
  if (target) {
    const hit = list.find((track) => track.lang === target);
    if (hit) return hit;
    if (options?.strict) return null;
  }
  return pickTrack(list, options?.audioLang);
}
