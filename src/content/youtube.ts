/// <reference types="chrome" />
// YouTube 的内容脚本入口，只在构建开关打开时构建，用户在 YouTube 上启用以后由后台动态注册。
// 这里只建 YouTube 的页面对象，给出小窗配置、读页面的工具和授权的钩子；撤旧的一份、卡片和解释当前画面的图标都和 B 站一样，见 boot.ts。
import { INJECTED } from "../shared/names.ts";
import { switchCaptionCatch } from "../sites/youtube/page/caption-ask.ts";
import { createCaptionToggle, createCommentLoader, createPanelOpener } from "../sites/youtube/page/commands.ts";
import { askPlayerTracks } from "../sites/youtube/page/player-tracks.ts";
import { createCommentReader } from "../sites/youtube/page/read-comments.ts";
import { createPanelReader } from "../sites/youtube/page/read-panel.ts";
import { createYoutubePage } from "../sites/youtube/page.ts";
import type { SiteReader } from "./app.ts";
import { bootContent } from "./boot.ts";

type YoutubePage = ReturnType<typeof createYoutubePage>;

const opener = FEATURE_YOUTUBE_OPEN_PANEL ? createPanelOpener : null;
// 页面上没有文字稿时读播放器取回的字幕：关掉开关的构建里这一支连同开关字幕的代码一起裁掉。
const captionToggle = FEATURE_YOUTUBE_CAPTION_CATCH ? createCaptionToggle : null;
const captionSwitch = FEATURE_YOUTUBE_CAPTION_CATCH ? switchCaptionCatch : null;
// 读评论区和替用户滚到评论区（PRD F23）：关掉开关的构建里这两支一起裁掉。
const commentReader = FEATURE_COMMENTS ? createCommentReader : null;
const commentLoader = FEATURE_COMMENTS ? createCommentLoader : null;
function withOpener(page: YoutubePage, reader: SiteReader): SiteReader {
  const open = opener?.({ document, currentRef: () => page.currentRef() });
  const captions = captionToggle?.({ document, currentRef: () => page.currentRef() });
  const comments = commentReader?.({ document, currentRef: () => page.currentRef() });
  const load = commentLoader?.({ document, currentRef: () => page.currentRef() });
  const handle = (message: unknown): Promise<unknown> | null =>
    reader.handle(message) ?? open?.handle(message) ?? captions?.handle(message) ?? comments?.handle(message) ?? load?.handle(message) ?? null;
  // 接上时叫小桥接着字幕；撤下时（用户收回授权、被新的一份顶替）叫它停下、清掉接住的。
  captionSwitch?.(document, true);
  const stop = (): void => {
    captionSwitch?.(document, false);
    reader.stop();
  };
  return open || captions || comments ? { handle, stop } : reader;
}

bootContent(
  () => createYoutubePage({ document, location }),
  (page) => ({
    site: "youtube",
    // 后台读字幕时问这里：只读文字稿面板上已经显示的内容。
    // 构建开关打开时，用户点「读取字幕」的那一次还能替他点开文字稿面板。读到面板时顺带问主世界的小桥要字幕轨列表。
    siteReader: () =>
      withOpener(
        page,
        createPanelReader({ document, currentRef: () => page.currentRef(), channelId: () => page.channelId?.() ?? null, playerTracks: () => askPlayerTracks(document) }),
      ),
    // 小桥在页面一开始加载时就接着字幕，闸门问到没启用（比如清除了全部数据）就叫它停下、清掉，启用以后接上读取时再叫它接。
    onHeld: () => captionSwitch?.(document, false),
    // 撤了授权：叫主世界的小桥整个退场（还回包住的函数、清掉接住的），不只停下接字幕；内容脚本还没问到启用状态时也叫。
    onRevoked: () => void document.dispatchEvent(new CustomEvent(INJECTED.bridgeRetire)),
    // 小窗避让只看播放器本身：YouTube 的页内小窗不在观看页上，那时不挂图标。
    miniPlayer: { container: () => page.hoverIconAnchor(), closeButton: () => null, screenAttribute: "data-screen" },
  }),
);
