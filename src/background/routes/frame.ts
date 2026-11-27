// 解释当前画面的路由：只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进路由表，只从 routes/index.ts 的开关分支引用。
// 侧边栏点「解释当前画面」要带上它跟着的标签页；播放页图标只认真实点击发来的请求，视频以标签页地址上的为准，
// 分发时先打开侧边栏（要在用户手势还有效时），再截帧、调模型。两条共用每标签页每分钟 6 次的额度。
// 设置页选好画面分析的模型后可以探一次能不能看图。
import { fail, ok } from "../../core/errors.ts";
import { videoKeyOrNull } from "../../core/video-ref.ts";
import { CONTENT_SENDERS } from "../../shared/messages.ts";
import type { FrameExplainRequest, FrameHereRequest, FrameRecentRequest } from "../../shared/messages/frame.ts";
import type { Messenger } from "../../platform/messaging.ts";
import type { AiWiring } from "../ai.ts";
import type { ImageSupport } from "../image-support.ts";
import type { Route } from "../router.ts";
import { configFailure, type FrameExplainService } from "../services/frame-explain.ts";
import { hasOnly, isEmptyRequest, isPlainObject, isTabId, isVideoKey } from "./validate.ts";

export interface FrameRouteDeps {
  readonly frame: { readonly service: FrameExplainService; readonly images: ImageSupport } | null;
  readonly ai: Pick<AiWiring, "freeze" | "configCheck">;
  readonly messenger: Messenger;
}

type FrameRoutes = { readonly [K in "frame.explain" | "frame.explainHere" | "frame.recent" | "ai.probeImage"]: Route<K> };

const isExplainRequest = (req: unknown): req is FrameExplainRequest =>
  isPlainObject(req) && hasOnly(req, ["video", "tabId"]) && isVideoKey(req.video) && isTabId(req.tabId);

const isHereRequest = (req: unknown): req is FrameHereRequest => isPlainObject(req) && hasOnly(req, ["video"]) && isVideoKey(req.video);

const isRecentRequest = (req: unknown): req is FrameRecentRequest => isPlainObject(req) && hasOnly(req, ["tabId"]) && isTabId(req.tabId);

export function frameRoutes({ frame, ai, messenger }: FrameRouteDeps): FrameRoutes | Record<string, never> {
  if (!frame) return {};
  const { service, images } = frame;
  return {
    "frame.explain": {
      senders: ["panel"],
      validate: isExplainRequest,
      async handler(req) {
        if (!service.admit(req.tabId)) return fail("FRAME_RATE_LIMITED");
        return ok(await service.start(req.tabId, req.video));
      },
    },
    "frame.explainHere": {
      senders: CONTENT_SENDERS,
      video: "from-sender",
      gesture: "open-panel",
      validate: isHereRequest,
      async handler(req, { sender, panelOpened }) {
        // 视频以标签页地址上的为准：页面脚本能伪造消息，改不了标签页正在放的视频。
        const playing = "site" in sender ? videoKeyOrNull(sender.video) : null;
        if (!playing || playing !== req.video || sender.tabId === undefined) return fail("FORBIDDEN");
        if (!service.admit(sender.tabId)) return fail("FRAME_RATE_LIMITED");
        await service.start(sender.tabId, playing);
        const opened = (await panelOpened) === true;
        // 侧边栏可能本来就开着、停在别的标签页上，让它跟到这个标签页。
        if (opened) await messenger.toPages({ type: "panel.follow", tabId: sender.tabId });
        return ok({ opened });
      },
    },
    "frame.recent": {
      senders: ["panel"],
      idempotent: true,
      validate: isRecentRequest,
      handler: async (req) => ok({ entries: await service.recent(req.tabId) }),
    },
    "ai.probeImage": {
      senders: ["page"],
      pages: ["options"],
      validate: isEmptyRequest,
      async handler() {
        const config = await ai.configCheck();
        if (!config.ready) return configFailure(config.errors);
        const gen = await ai.freeze("frame");
        const probed = await images.probe(gen);
        return probed.ok ? ok({ model: gen.model, imageInput: probed.value.imageInput }) : probed;
      },
    },
  };
}
