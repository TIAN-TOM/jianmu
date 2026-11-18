// YouTube 的读取服务：不向平台发任何请求，只经内容脚本读观看页上用户自己打开的文字稿面板。
// 开始读时核对页面上是不是这个视频；交回正文之前隔一会儿再问一次，视频、面板内容和语言有一样变了就整份不用。
// 读到的只有面板当前显示的那一条轨，语言和来源按面板语言菜单上的名字认，认不出就照实显示名字。
import type { VideoRef } from "../../core/video-ref.ts";
import type { CaptionTrack, Cue, PageChannel, SiteCtx, SiteFailure, SiteResult, SiteService, VideoInfo } from "../types.ts";
import { panelCurrentOf, panelSnapshotOf, type PanelSnapshot } from "./page/panel-types.ts";
import { youtubeRules } from "./url.ts";

// 等页面回话的上限：面板还在加载时页面那头最多等几秒。
const ASK_TIMEOUT_MS = 10_000;
// 交回正文之前隔这么久再问一次：分批渲染、换语言后晚到的段落这时能看出来。
const RECHECK_DELAY_MS = 300;
// 最后一句没有下一句可比时，按这么长算。
const LAST_CUE_SEC = 5;
const TRACK_PREFIX = "panel:";
const UNNAMED_TRACK = "YouTube 文字稿";

// 菜单名里标着自动生成的几种写法。
const AUTO_MARK = /auto-generated|automatisch|automática|automatique|automatico|automatyczn|автоматическ|自动生成|自動生成|自動產生|자동 생성/i;
// 用菜单名反推语言：先拿整个名字比，再拿去掉括号说明的名字比。认得的界面语言和语言都有限，认不出就不猜。
const UI_LOCALES = ["en", "zh-Hans", "zh-Hant", "ja", "ko", "es", "fr", "de", "pt", "ru", "it"];
const LANGS = ["en", "zh-Hans", "zh-Hant", "zh", "ja", "ko", "es", "fr", "de", "pt", "ru", "it", "ar", "hi", "vi", "th", "id", "tr", "nl", "pl", "uk", "sv", "he", "ms", "fa"];
const UNKNOWN_LANG = "und";

const fail = (code: Exclude<SiteFailure["code"], "MALFORMED">, detail?: string): SiteFailure => (detail ? { ok: false, code, detail } : { ok: false, code });
const malformed = (detail: string): SiteFailure => ({ ok: false, code: "MALFORMED", reach: "item", detail });

let nameTable: Map<string, string> | null = null;
function langNames(): Map<string, string> {
  if (nameTable) return nameTable;
  const table = new Map<string, string>();
  for (const locale of UI_LOCALES) {
    let names: Intl.DisplayNames;
    try {
      names = new Intl.DisplayNames([locale], { type: "language" });
    } catch {
      continue;
    }
    for (const code of LANGS) {
      const name = names.of(code)?.toLowerCase();
      if (name && !table.has(name)) table.set(name, code);
    }
  }
  nameTable = table;
  return table;
}

/** 菜单名对应的语言码，认不出是「未定」。 */
export function langOfLabel(label: string): string {
  const table = langNames();
  const whole = label.trim().toLowerCase();
  const bare = whole.replace(/\s*[(（][^)）]*[)）]\s*/g, " ").trim();
  return table.get(whole) ?? table.get(bare) ?? UNKNOWN_LANG;
}

// 认文字是哪种书写：汉字、假名、谚文，取样的前几千个字里这种字过一定比例才算。
const SCRIPT_SAMPLE = 4000;
const SCRIPT_SHARE = 0.3;
const SCRIPTS: readonly (readonly [RegExp, string])[] = [
  [/[\u3040-\u30ff]/gu, "ja"],
  [/[\uac00-\ud7af]/gu, "ko"],
  [/[\u4e00-\u9fff]/gu, "zh"],
];

/** 面板上没有语言名时，按正文用的文字认中文、日文、韩文；别的认不出，不猜。 */
export function langOfText(texts: readonly string[]): string {
  const sample = texts.join("").replace(/\s+/g, "").slice(0, SCRIPT_SAMPLE);
  if (!sample) return UNKNOWN_LANG;
  for (const [pattern, lang] of SCRIPTS) {
    if ((sample.match(pattern)?.length ?? 0) / sample.length >= SCRIPT_SHARE) return lang;
  }
  return UNKNOWN_LANG;
}

/** 面板语言菜单上的名字认语言和来源；新面板没有语言菜单，名字是空的，语言按正文的文字认。 */
export function trackOfLabel(label: string, texts: readonly string[] = []): CaptionTrack {
  const shown = label.trim() || UNNAMED_TRACK;
  return { trackId: `${TRACK_PREFIX}${shown}`, lang: label.trim() ? langOfLabel(label) : langOfText(texts), label: shown, kind: AUTO_MARK.test(label) ? "auto" : "human" };
}

/** 段落的时长按下一段的开始算，最后一段按视频剩下的时间、最多几秒。 */
export function cuesOf(snapshot: PanelSnapshot): Cue[] {
  const { cues, info } = snapshot;
  return cues.map((cue, index) => {
    const next = cues[index + 1]?.start;
    const end = next ?? (info.durationSec > cue.start ? Math.min(info.durationSec, cue.start + LAST_CUE_SEC) : cue.start + LAST_CUE_SEC);
    return { start: cue.start, duration: Math.max(0, end - cue.start), text: cue.text };
  });
}

type Asked = { readonly ok: true; readonly answer: unknown } | { readonly ok: false; readonly failure: SiteFailure };

/** 问页面一句。超时报超时；送不到、页面没回话（内容脚本还没接上）都按连不上视频页。 */
async function ask(page: PageChannel, message: unknown, signal: AbortSignal, limitMs: number): Promise<Asked> {
  const timeout = AbortSignal.timeout(limitMs);
  try {
    const answer = await page.ask(message, AbortSignal.any([signal, timeout]));
    return answer === undefined || answer === null ? { ok: false, failure: fail("UNAVAILABLE", "no-page") } : { ok: true, answer };
  } catch {
    return { ok: false, failure: timeout.aborted || signal.aborted ? fail("TIMEOUT") : fail("UNAVAILABLE", "no-page") };
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });
}

function failureOfState(snapshot: PanelSnapshot): SiteFailure | null {
  switch (snapshot.state) {
    case "ready":
      return null;
    case "closed":
      return fail("PAGE_ACTION_NEEDED");
    case "reopen":
      return fail("PAGE_ACTION_NEEDED", "reopen");
    case "chapters":
      return fail("PAGE_ACTION_NEEDED", "chapters");
    case "filtered":
      return fail("PAGE_ACTION_NEEDED", "filtered");
    case "stale":
      return fail("UNAVAILABLE", "stale");
    case "no-entry":
      return fail("UNAVAILABLE", "no-entry");
    case "loading":
      return fail("UNAVAILABLE");
  }
}

async function readPanel(ref: VideoRef, ctx: SiteCtx, limitMs: number): Promise<SiteResult<PanelSnapshot>> {
  if (!ctx.page) return fail("UNAVAILABLE", "no-page");
  const asked = await ask(ctx.page, { type: "youtube.panel", req: { videoId: ref.videoId } }, ctx.signal, limitMs);
  if (!asked.ok) return asked.failure;
  const snapshot = panelSnapshotOf(asked.answer);
  if (!snapshot) return malformed("panel-shape");
  // 页面上已经不是这个视频，或者换视频的途中认不出是哪个视频：读到的一律不用。
  if (snapshot.videoId !== ref.videoId) return fail("VIDEO_CHANGED");
  return { ok: true, value: snapshot };
}

/** 交回正文之前再问一次：页面还是这个视频、面板内容没有再变过。 */
async function stillSame(ref: VideoRef, ctx: SiteCtx, snapshot: PanelSnapshot, limitMs: number): Promise<SiteFailure | null> {
  if (!ctx.page) return fail("UNAVAILABLE", "no-page");
  await pause(RECHECK_DELAY_MS, ctx.signal);
  const asked = await ask(ctx.page, { type: "youtube.current", req: { videoId: ref.videoId } }, ctx.signal, limitMs);
  if (!asked.ok) return asked.failure;
  const current = panelCurrentOf(asked.answer);
  if (!current) return malformed("current-shape");
  if (current.videoId !== ref.videoId) return fail("VIDEO_CHANGED");
  return current.stamp === snapshot.stamp && current.label === snapshot.label ? null : fail("UNAVAILABLE", "stale");
}

export function createYoutubeService({ askTimeoutMs = ASK_TIMEOUT_MS }: { readonly askTimeoutMs?: number } = {}): SiteService {
  // 一次读取里问到的那份快照：列轨和读正文共用，不跨读取操作。
  const snapshots = new WeakMap<SiteCtx, PanelSnapshot>();
  return {
    rules: youtubeRules,

    async readVideoInfo(ref, ctx) {
      const read = await readPanel(ref, ctx, askTimeoutMs);
      if (!read.ok) return read;
      snapshots.set(ctx, read.value);
      const { info } = read.value;
      const value: VideoInfo = {
        ref: { platform: "youtube", videoId: ref.videoId },
        title: info.title,
        author: info.author,
        description: info.description,
        durationSec: info.durationSec,
        ...(info.channelId ? { channel: { platform: "youtube", channelId: info.channelId } } : {}),
      };
      return { ok: true, value };
    },

    async listCaptionTracks(info, ctx, options) {
      let snapshot = options?.fresh ? undefined : snapshots.get(ctx);
      if (!snapshot) {
        const read = await readPanel(info.ref, ctx, askTimeoutMs);
        if (!read.ok) return read;
        snapshot = read.value;
        snapshots.set(ctx, snapshot);
      }
      const failure = failureOfState(snapshot);
      return failure ?? { ok: true, value: [trackOfLabel(snapshot.label, snapshot.cues.map((cue) => cue.text))] };
    },

    async readCaptions(info, track, ctx) {
      const snapshot = snapshots.get(ctx);
      if (!snapshot) return fail("UNAVAILABLE", "stale");
      const failure = failureOfState(snapshot);
      if (failure) return failure;
      // 面板上的轨换了（用户在面板里换了语言）：这份不是要的那条。
      if (trackOfLabel(snapshot.label).trackId !== track.trackId) return fail("UNAVAILABLE", "stale");
      const changed = await stillSame(info.ref, ctx, snapshot, askTimeoutMs);
      return changed ?? { ok: true, value: cuesOf(snapshot) };
    },
  };
}
