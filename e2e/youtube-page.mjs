// 模拟的 YouTube 观看页：结构照着内容脚本认的那几处搭（应用外壳、观看页外壳、播放器和视频元素、标题作者简介、
// 文字稿入口和文字稿面板），文字和编号全部自造。页面自己带几个按钮扮演用户：打开文字稿（面板展开，稍后页面把段落填进去）、
// 关上文字稿（只收起，段落留着），站内跳到另一个视频（改地址和外壳、派发跳转完成的事件，面板留着旧内容）。
// 另有两个新式面板的视频：有章节的打开的是带「章节」「文字稿」页签的面板，没章节的打开新式文字稿面板；
// 两个页面上都一直留着关着的旧面板和新式面板空壳，段落是新写法，搜索框是多行文本框，没有语言菜单。
// 文字稿入口在页面上有两份：简介里一份，一直关着的简介面板里一份；点了后面那份，页面记一笔，测试据此判点错了。
import { QUIET_MEDIA_PATH } from "./watch-page.mjs";

export const TUBE_HOST = "www.youtube.com";

/** 自造的视频：编号只照字符集和长度写，不对应真实视频。layout 是打开文字稿时的面板样子。 */
export const TUBE_VIDEOS = Object.freeze({
  jmTube00001: { layout: "classic", title: "样例英文讲座", author: "样例频道", channel: "@sample.channel", label: "English (auto-generated)", lines: ["sample line one", "sample line two", "sample line three"] },
  jmTube00002: { layout: "classic", title: "样例第二个视频", author: "样例频道", channel: "@sample.channel", label: "English", lines: ["second video line one", "second video line two"] },
  jmTube00003: { layout: "chapters", title: "样例新面板带章节", author: "样例频道", channel: "@sample.channel", label: "", lines: ["modern line one", "modern line two", "modern line three"] },
  jmTube00004: { layout: "modern", title: "样例新面板没章节", author: "样例频道", channel: "@sample.channel", label: "", lines: ["plain modern line one", "plain modern line two"] },
});

/** 旧式页面上「下一个视频」在这两个之间来回跳。 */
const CLASSIC_IDS = ["jmTube00001", "jmTube00002"];

/** @param {string} id */
export const tubeWatchPage = (id) => `https://${TUBE_HOST}/watch?v=${id}`;

const STEP_SEC = 20;

/** @param {string} id */
export function tubePageHtml(id) {
  const video = TUBE_VIDEOS[/** @type {keyof typeof TUBE_VIDEOS} */ (id)];
  return video && video.layout !== "classic" ? modernPageHtml(id, video) : classicPageHtml(id);
}

/** @param {string} id */
function classicPageHtml(id) {
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
    const next = ${JSON.stringify(CLASSIC_IDS)}.find((key) => key !== current());
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

/**
 * 新式面板的页面。有章节时打开的是带页签的面板（没有 target-id），没章节时打开新式文字稿面板；
 * 旧面板和新式面板的空壳都关着留在页面上。段落的时间、给读屏的一句和正文各占一块。
 * @param {string} id @param {{ layout: string, title: string, author: string, channel: string, lines: readonly string[] }} video
 */
function modernPageHtml(id, video) {
  const chapters = video.layout === "chapters";
  const lines = JSON.stringify(video.lines);
  // 有章节时，开着的是带页签的面板，新式面板那个空壳一直关着；没章节时打开的就是新式面板。
  const opened = chapters
    ? `<ytd-engagement-panel-section-list-renderer id="e2e-open-panel" visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN">
    <div id="header"><span>In this video</span><div role="tab" id="e2e-chapters-tab" aria-selected="false">Chapters</div><div role="tab" id="e2e-transcript-tab" aria-selected="true">Transcript</div></div>
    <div id="content"></div>
  </ytd-engagement-panel-section-list-renderer>
  <ytd-engagement-panel-section-list-renderer target-id="PAmodern_transcript_view" visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"><div class="spinner"></div></ytd-engagement-panel-section-list-renderer>`
    : `<ytd-engagement-panel-section-list-renderer id="e2e-open-panel" target-id="PAmodern_transcript_view" visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN">
    <div id="header"><span>Transcript</span></div>
    <div id="content"></div>
  </ytd-engagement-panel-section-list-renderer>`;
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
      <h1>${video.title}</h1>
      <ytd-channel-name><a href="/${video.channel}">${video.author}</a></ytd-channel-name>
      <div id="description-inline-expander">样例简介</div>
    </ytd-watch-metadata>
    <ytd-video-description-transcript-section-renderer><button id="e2e-open-transcript">Show transcript</button></ytd-video-description-transcript-section-renderer>
    <button id="e2e-close-transcript">关上文字稿</button>
  </ytd-watch-flexy>
  <ytd-engagement-panel-section-list-renderer target-id="engagement-panel-searchable-transcript" visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"></ytd-engagement-panel-section-list-renderer>
  <ytd-engagement-panel-section-list-renderer target-id="engagement-panel-structured-description" visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN">
    <ytd-video-description-transcript-section-renderer><button id="e2e-hidden-entry">Show transcript</button></ytd-video-description-transcript-section-renderer>
  </ytd-engagement-panel-section-list-renderer>
  ${opened}
</ytd-app>
<script>
  const lines = ${lines};
  const panel = document.getElementById("e2e-open-panel");
  const content = panel.querySelector("#content");
  const stamp = (seconds) => Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
  // 文字稿那一页：搜索框、章节标题和段落，都在一个带标记的列表里。
  function showTranscript() {
    const list = document.createElement("yt-section-list-renderer");
    list.setAttribute("data-target-id", "PAmodern_transcript_view");
    const search = document.createElement("textarea");
    search.placeholder = "Search transcript";
    search.id = "e2e-search";
    const chapter = document.createElement("timeline-chapter-view-model");
    chapter.innerHTML = '<h3 class="ytwTimelineChapterViewModelTitle">Intro</h3>';
    list.append(search, chapter, ...lines.map((line, index) => {
      const segment = document.createElement("transcript-segment-view-model");
      segment.className = "ytwTranscriptSegmentViewModelHost";
      const time = document.createElement("div");
      time.className = "ytwTranscriptSegmentViewModelTimestamp";
      time.setAttribute("aria-hidden", "true");
      time.textContent = stamp(index * ${STEP_SEC});
      const spoken = document.createElement("div");
      spoken.textContent = (index * ${STEP_SEC}) + " seconds";
      const text = document.createElement("span");
      text.className = "ytAttributedStringHost";
      text.setAttribute("role", "text");
      text.textContent = line;
      segment.append(time, spoken, text);
      return segment;
    }));
    content.replaceChildren(list);
  }
  const select = (id) => {
    for (const tab of panel.querySelectorAll('[role="tab"]')) tab.setAttribute("aria-selected", String(tab.id === id));
  };
  document.getElementById("e2e-open-transcript").addEventListener("click", () => {
    panel.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
    select("e2e-transcript-tab");
    setTimeout(showTranscript, 50);
  });
  document.getElementById("e2e-hidden-entry").addEventListener("click", () => document.body.setAttribute("data-e2e-wrong-entry", "1"));
  document.getElementById("e2e-close-transcript").addEventListener("click", () => {
    panel.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
  });
  // 页签：切到章节时文字稿那一块整个拿掉，切回来重新建。
  document.getElementById("e2e-chapters-tab")?.addEventListener("click", () => {
    select("e2e-chapters-tab");
    content.replaceChildren(Object.assign(document.createElement("div"), { textContent: "Intro 0:00" }));
  });
  document.getElementById("e2e-transcript-tab")?.addEventListener("click", () => {
    select("e2e-transcript-tab");
    setTimeout(showTranscript, 50);
  });
</script>
</body>
</html>`;
}
