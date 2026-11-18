// 模拟的 YouTube 观看页：结构照着内容脚本认的那几处搭（应用外壳、观看页外壳、播放器和视频元素、标题作者简介、
// 文字稿入口和文字稿面板），文字和编号全部自造。页面自己带几个按钮扮演用户：打开文字稿（面板展开，稍后页面把段落填进去）、
// 关上文字稿（只收起，段落留着），站内跳到另一个视频（改地址和外壳、派发跳转完成的事件，面板留着旧内容）。
import { QUIET_MEDIA_PATH } from "./watch-page.mjs";

export const TUBE_HOST = "www.youtube.com";

/** 自造的两个视频：编号只照字符集和长度写，不对应真实视频。 */
export const TUBE_VIDEOS = Object.freeze({
  jmTube00001: { title: "样例英文讲座", author: "样例频道", channel: "@sample.channel", label: "English (auto-generated)", lines: ["sample line one", "sample line two", "sample line three"] },
  jmTube00002: { title: "样例第二个视频", author: "样例频道", channel: "@sample.channel", label: "English", lines: ["second video line one", "second video line two"] },
});

/** @param {string} id */
export const tubeWatchPage = (id) => `https://${TUBE_HOST}/watch?v=${id}`;

const STEP_SEC = 20;

/** @param {string} id */
export function tubePageHtml(id) {
  const videos = JSON.stringify(TUBE_VIDEOS);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>样例观看页</title>
<style>
  body { margin: 0; font: 14px sans-serif; }
  ytd-app, ytd-watch-flexy, ytd-watch-metadata, ytd-engagement-panel-section-list-renderer { display: block; }
  .html5-video-player { position: relative; width: 640px; height: 360px; background: #000; }
  video { width: 100%; height: 100%; }
  ytd-engagement-panel-section-list-renderer[visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"] { display: none; }
</style>
</head>
<body>
<ytd-app>
  <ytd-watch-flexy video-id="${id}">
    <div class="html5-video-player"><video class="html5-main-video" muted autoplay loop src="${QUIET_MEDIA_PATH}"></video></div>
    <ytd-watch-metadata>
      <h1></h1>
      <ytd-channel-name><a></a></ytd-channel-name>
      <div id="description-inline-expander">样例简介</div>
    </ytd-watch-metadata>
    <ytd-video-description-transcript-section-renderer><button id="e2e-open-transcript">Show transcript</button></ytd-video-description-transcript-section-renderer>
    <button id="e2e-close-transcript">关上文字稿</button>
    <button id="e2e-next">下一个视频</button>
  </ytd-watch-flexy>
  <ytd-engagement-panel-section-list-renderer target-id="engagement-panel-searchable-transcript" visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN">
    <div id="segments"></div>
    <ytd-transcript-footer-renderer><yt-dropdown-menu><span id="label-text"></span></yt-dropdown-menu></ytd-transcript-footer-renderer>
  </ytd-engagement-panel-section-list-renderer>
</ytd-app>
<script>
  const videos = ${videos};
  const shell = document.querySelector("ytd-watch-flexy");
  const panel = document.querySelector("ytd-engagement-panel-section-list-renderer");
  const current = () => new URL(location.href).searchParams.get("v");
  const stamp = (seconds) => Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
  function showMeta() {
    const video = videos[current()];
    document.querySelector("ytd-watch-metadata h1").textContent = video.title;
    const link = document.querySelector("ytd-channel-name a");
    link.textContent = video.author;
    link.setAttribute("href", "/" + video.channel);
  }
  // 用户自己打开文字稿：页面把当前视频的段落填进面板。
  function fill() {
    const video = videos[current()];
    const list = document.getElementById("segments");
    list.replaceChildren(...video.lines.map((line, index) => {
      const segment = document.createElement("ytd-transcript-segment-renderer");
      const time = document.createElement("div");
      time.className = "segment-timestamp";
      time.textContent = stamp(index * ${STEP_SEC});
      const text = document.createElement("yt-formatted-string");
      text.className = "segment-text";
      text.textContent = line;
      segment.append(time, text);
      return segment;
    }));
    document.getElementById("label-text").textContent = video.label;
  }
  document.getElementById("e2e-open-transcript").addEventListener("click", () => {
    panel.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
    // 页面去取文字稿，取回来再填。
    setTimeout(fill, 50);
  });
  document.getElementById("e2e-close-transcript").addEventListener("click", () => {
    panel.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
  });
  // 站内跳到另一个视频：面板不动，留着上一个视频的内容。
  document.getElementById("e2e-next").addEventListener("click", () => {
    const next = Object.keys(videos).find((key) => key !== current());
    history.pushState({}, "", "/watch?v=" + next);
    shell.setAttribute("video-id", next);
    showMeta();
    document.dispatchEvent(new Event("yt-navigate-finish"));
  });
  showMeta();
</script>
</body>
</html>`;
}
