// YouTube 代开文字稿面板的路由：只在构建开关 FEATURE_YOUTUBE_OPEN_PANEL 打开时进路由表，只从 routes/index.ts 的开关分支引用。
// 只收侧边栏，侧边栏只在用户点「读取字幕」时发。转给那个标签页的内容脚本，由它核对页面上的视频、点一下、等结果；
// 后台的取字幕服务、自动生成和批次都拿不到这条。同一个标签页隔一会儿才放行下一次，免得连点。
import { fail, ok } from "../../core/errors.ts";
import { parseVideoKey } from "../../core/video-ref.ts";
import type { Tabs } from "../../platform/tabs.ts";
import type { OpenTranscriptRequest, OpenTranscriptResult } from "../../shared/messages/youtube.ts";
import type { Route } from "../router.ts";
import { isPlainObject, isVideoKey } from "./validate.ts";

/** 同一个标签页两次代开之间至少隔这么久。 */
export const OPEN_TRANSCRIPT_GAP_MS = 3000;

export interface YoutubeRouteDeps {
  readonly tabs: Pick<Tabs, "ask">;
  readonly now: () => number;
}

type YoutubeRoutes = { readonly [K in "youtube.openTranscript"]: Route<K> };

const isOpenRequest = (req: unknown): req is OpenTranscriptRequest =>
  isPlainObject(req) &&
  Object.keys(req).length === 2 &&
  isVideoKey(req.video) &&
  parseVideoKey(req.video)?.platform === "youtube" &&
  Number.isInteger(req.tabId) &&
  Number(req.tabId) >= 0;

// 页面回的结果按不可信输入核对，认不出的按连不上视频页。
const OUTCOMES: readonly string[] = ["already-open", "opened", "not-opened", "no-entry", "ad", "video-changed", "searching"];
function outcomeOf(value: unknown): OpenTranscriptResult {
  const outcome = isPlainObject(value) ? value.outcome : undefined;
  return typeof outcome === "string" && OUTCOMES.includes(outcome) ? (outcome as OpenTranscriptResult) : "no-page";
}

export function youtubeRoutes({ tabs, now }: YoutubeRouteDeps): YoutubeRoutes {
  const lastAsked = new Map<number, number>();
  return {
    "youtube.openTranscript": {
      senders: ["panel"],
      validate: isOpenRequest,
      async handler({ video, tabId }) {
        const at = now();
        if (at - (lastAsked.get(tabId) ?? Number.NEGATIVE_INFINITY) < OPEN_TRANSCRIPT_GAP_MS) return fail("RATE_LIMITED", "open-transcript");
        lastAsked.set(tabId, at);
        const ref = parseVideoKey(video);
        if (!ref) return fail("INVALID_REQUEST");
        let answer: unknown;
        try {
          answer = await tabs.ask(tabId, { type: "youtube.openTranscript", req: { videoId: ref.videoId } });
        } catch {
          return ok({ outcome: "no-page" });
        }
        return ok({ outcome: outcomeOf(answer) });
      },
    },
  };
}
