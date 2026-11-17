// 模拟的视频播放页：结构照着内容脚本认的那几处搭（播放器、视频元素、右栏、弹幕列表），文字全部自造。
// 页面先带着服务端渲染的标记，过一会儿才去掉，像页面框架激活那样；另有一层盖住整页、不拦点击的透明层，
// 内容脚本和卡片的点击都要穿过它。视频元素平时没有媒体，停在固定的播放时间上；要真的播放时换成一段静音，静音自动播放。

/** 页面上视频元素停着的播放时间。 */
export const WATCH_PAGE_AT_SEC = 42;
/** 页面框架激活前等多久。 */
const HYDRATE_MS = 300;

/** 真的播放时用的静音：8 kHz、8 位单声道，长过 5 分钟，读到的时长不会被当成短视频。 */
export const QUIET_MEDIA_PATH = "/e2e/quiet.wav";
const QUIET_SECONDS = 400;
const QUIET_RATE = 8000;

/** 一段静音的 WAV 文件。 */
export function quietWav() {
  const samples = QUIET_SECONDS * QUIET_RATE;
  const file = Buffer.alloc(44 + samples, 128);
  file.write("RIFF", 0, "ascii");
  file.writeUInt32LE(36 + samples, 4);
  file.write("WAVEfmt ", 8, "ascii");
  file.writeUInt32LE(16, 16);
  file.writeUInt16LE(1, 20);
  file.writeUInt16LE(1, 22);
  file.writeUInt32LE(QUIET_RATE, 24);
  file.writeUInt32LE(QUIET_RATE, 28);
  file.writeUInt16LE(1, 32);
  file.writeUInt16LE(8, 34);
  file.write("data", 36, "ascii");
  file.writeUInt32LE(samples, 40);
  return file;
}

/** @param {{ title: string, owner: string, mid: number }} video @param {{ playing?: boolean }} [options] */
export function watchPageHtml(video, { playing = false } = {}) {
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
      <div class="up-info-container"><a class="up-name" href="//space.bilibili.com/${video.mid}">${video.owner}</a></div>
      <div id="bilibili-player">
        <div class="bpx-player-container" data-screen="normal">
          <div class="bpx-player-primary-area">
            <div class="bpx-player-video-wrap">${playing ? `<video muted autoplay loop src="${QUIET_MEDIA_PATH}"></video>` : "<video muted></video>"}</div>
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
  ${playing ? "" : `document.querySelector("video").currentTime = ${WATCH_PAGE_AT_SEC};`}
  addEventListener("load", () => setTimeout(() => document.getElementById("app").removeAttribute("data-server-rendered"), ${HYDRATE_MS}));
</script>
</body>
</html>`;
}
