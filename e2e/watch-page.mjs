// 模拟的视频播放页：结构照着内容脚本认的那几处搭（播放器、视频元素、右栏、弹幕列表），文字全部自造。
// 页面先带着服务端渲染的标记，过一会儿才去掉，像页面框架激活那样；另有一层盖住整页、不拦点击的透明层，
// 内容脚本和卡片的点击都要穿过它。视频元素没有媒体，停在固定的播放时间上。

/** 页面上视频元素停着的播放时间。 */
export const WATCH_PAGE_AT_SEC = 42;
/** 页面框架激活前等多久。 */
const HYDRATE_MS = 300;

/** @param {{ title: string }} video */
export function watchPageHtml(video) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${video.title}_样例站点</title>
<style>
  body { margin: 0; font: 14px sans-serif; }
  .video-container { display: flex; gap: 24px; padding: 16px; }
  .left-container { flex: 0 0 640px; }
  #bilibili-player { width: 640px; height: 360px; background: #000; }
  .bpx-player-primary-area, .bpx-player-video-wrap { width: 100%; height: 100%; }
  video { width: 100%; height: 100%; }
  .right-container { flex: 0 0 360px; }
  #danmukuBox { height: 200px; border: 1px solid #ccc; }
  .recommend { height: 600px; }
  .video-note-sidebar-panel { position: fixed; inset: 0; pointer-events: none; z-index: 2000; }
</style>
</head>
<body>
<div id="app" data-server-rendered="true">
  <div class="video-container">
    <div class="left-container">
      <h1 class="video-title" title="${video.title}">${video.title}</h1>
      <div id="bilibili-player">
        <div class="bpx-player-container" data-screen="normal">
          <div class="bpx-player-primary-area">
            <div class="bpx-player-video-wrap"><video muted></video></div>
          </div>
        </div>
      </div>
    </div>
    <div class="right-container"><div class="right-container-inner">
      <div id="danmukuBox">样例弹幕列表</div>
      <div class="recommend">样例推荐列表</div>
    </div></div>
  </div>
</div>
<div class="video-note-sidebar-panel"></div>
<script>
  document.querySelector("video").currentTime = ${WATCH_PAGE_AT_SEC};
  addEventListener("load", () => setTimeout(() => document.getElementById("app").removeAttribute("data-server-rendered"), ${HYDRATE_MS}));
</script>
</body>
</html>`;
}
