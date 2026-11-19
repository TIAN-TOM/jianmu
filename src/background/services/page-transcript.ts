// 打开就出结论和本窗口全部生成读要经页面读字幕的站（YouTube）：本机有字幕（缓存、内存、导入的文件）就用本机的；没有就让视频页替用户点开文字稿面板，
// 读面板上显示的内容，读完把这次点开的面板关上，用户自己开着的不关。只从构建开关 FEATURE_YOUTUBE_OPEN_PANEL 的分支引用，
// 开关关着时整个模块不进包。页面还没准备好（内容脚本还没接上、在播广告、正在换视频）时回 later，由调用方过一会儿再来。
import type { VideoRef } from "../../core/video-ref.ts";
import type { TranscriptReply } from "../../shared/messages/transcript.ts";
import type { SiteAccess } from "./transcript/index.ts";
import type { TranscriptService } from "./transcript/index.ts";

/** 页面还没准备好，过一会儿再来：在播广告、正在换视频、内容脚本没回话。 */
export interface PageLater {
  readonly later: "ad" | "video-changed" | "no-page";
}

export interface PageTranscriptDeps {
  /** 发给标签页的内容脚本并等它回话；送不到时抛错。 */
  readonly ask: (tabId: number, message: unknown) => Promise<unknown>;
  readonly transcript: Pick<TranscriptService, "get">;
  readonly sites: SiteAccess;
}

export interface PageTranscript {
  /** 页面上视频的时长；不知道是 null。 */
  duration(ref: VideoRef, tabId: number): Promise<number | null | "later">;
  /** 读字幕：本机有就用本机的，没有就经页面读。 */
  read(ref: VideoRef, tabId: number): Promise<TranscriptReply | PageLater>;
}


// 等页面回话的上限：代开面板那头最多等几秒看面板开没开。
const OPEN_TIMEOUT_MS = 10_000;

const outcomeOf = (answer: unknown): unknown => (typeof answer === "object" && answer !== null ? (answer as { readonly outcome?: unknown }).outcome : undefined);

export function createPageTranscript(deps: PageTranscriptDeps): PageTranscript {
  async function ask(tabId: number, message: unknown): Promise<unknown> {
    try {
      return await deps.ask(tabId, message);
    } catch {
      return undefined;
    }
  }

  return {
    async duration(ref, tabId) {
      const site = deps.sites.service(ref.platform);
      if (!site) return null;
      const read = await site.readVideoInfo(ref, deps.sites.ctx(ref.platform, { signal: AbortSignal.timeout(OPEN_TIMEOUT_MS), tabId })).catch(() => null);
      if (!read) return "later";
      if (read.ok) return read.value.durationSec > 0 ? read.value.durationSec : null;
      // 内容脚本还没接上、页面正在换视频：过一会儿再问。
      return read.code === "TIMEOUT" || read.code === "VIDEO_CHANGED" || (read.code === "UNAVAILABLE" && read.detail === "no-page") ? "later" : null;
    },

    async read(ref, tabId) {
      const local = await deps.transcript.get(ref, { mode: "local" });
      if (local.ok) return local;
      const answer = await ask(tabId, { type: "youtube.openTranscript", req: { videoId: ref.videoId } });
      const outcome = outcomeOf(answer);
      // 页面这会儿还不能点：过一会儿再来。
      if (outcome === undefined) return { later: "no-page" };
      if (outcome === "ad" || outcome === "video-changed") return { later: outcome };
      // 点不开、没有入口、搜索框里有字：照常去读，按页面上的实际样子报。
      const reply = await deps.transcript.get(ref, { mode: "full", tabId });
      if (outcome === "opened") await ask(tabId, { type: "youtube.closeTranscript", req: { videoId: ref.videoId } });
      return reply;
    },
  };
}
