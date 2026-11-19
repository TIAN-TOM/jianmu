/// <reference types="chrome" />
// YouTube 的内容脚本入口，只在构建开关打开时构建，用户在 YouTube 上启用以后由后台动态注册。
// 同一页面再注入一份时（启用、更新后的补注入），新的一份把旧的整套撤下再接手。YouTube 上不放播放页卡片，
// 也先不挂解释当前画面的图标：YouTube 一侧的截帧还没验证过，后台的路由也不收。
import { INJECTED } from "../shared/names.ts";
import { createPanelOpener } from "../sites/youtube/page/commands.ts";
import { askPlayerTracks } from "../sites/youtube/page/player-tracks.ts";
import { createPanelReader } from "../sites/youtube/page/read-panel.ts";
import { createYoutubePage } from "../sites/youtube/page.ts";
import { createContentApp, type ContentApp, type SiteReader } from "./app.ts";
import { createContentRuntime } from "./runtime.ts";
import { createSurface } from "./surface.ts";

type Registry = { [INJECTED.instance]?: ContentApp };
const registry = globalThis as Registry;
registry[INJECTED.instance]?.stop();

const runtime = createContentRuntime(() => (typeof chrome === "undefined" ? undefined : chrome.runtime));
const page = createYoutubePage({ document, location });
// 小窗避让只看播放器本身：YouTube 的页内小窗不在观看页上，那时不挂图标。
const MINI_PLAYER = { container: () => page.hoverIconAnchor(), closeButton: () => null, screenAttribute: "data-screen" };

const opener = FEATURE_YOUTUBE_OPEN_PANEL ? createPanelOpener : null;
function withOpener(reader: SiteReader): SiteReader {
  const open = opener?.({ document, currentRef: () => page.currentRef() });
  return open ? { handle: (message) => reader.handle(message) ?? open.handle(message), stop: reader.stop } : reader;
}

const app = createContentApp({
  runtime,
  page,
  site: "youtube",
  // 后台读字幕时问这里：只读文字稿面板上已经显示的内容。
  // 构建开关打开时，用户点「读取字幕」的那一次还能替他点开文字稿面板。读到面板时顺带问主世界的小桥要字幕轨列表。
  siteReader: () =>
    withOpener(
      createPanelReader({ document, currentRef: () => page.currentRef(), channelId: () => page.channelId?.() ?? null, playerTracks: () => askPlayerTracks(document) }),
    ),
  createSurface: (env) => createSurface({ ...env, document, page, runtime, miniPlayer: MINI_PLAYER }),
  visibility: {
    hidden: () => document.hidden,
    onChange(run) {
      const onVisibility = (): void => {
        if (!document.hidden) run();
      };
      document.addEventListener("visibilitychange", onVisibility);
      return () => document.removeEventListener("visibilitychange", onVisibility);
    },
  },
  // 媒体事件不冒泡，在捕获阶段听整个文档。
  onMediaLoading(run) {
    document.addEventListener("loadstart", run, true);
    return () => document.removeEventListener("loadstart", run, true);
  },
});
registry[INJECTED.instance] = app;
app.start();
