// 端到端的模拟 YouTube：只有自造的观看页和静音媒体，别的路径都算意外请求；页面上有内容脚本和面板读取认的那几处结构。
import assert from "node:assert/strict";
import { test } from "node:test";
import { hostRulesFor, route } from "../../../../e2e/mock-server.mjs";
import { TUBE_HOST, TUBE_VIDEOS, tubePageHtml, tubeWatchPage } from "../../../../e2e/youtube-page.mjs";
import { parseWatchUrl } from "../../../../src/sites/youtube/url.ts";

const ask = (path: string, query = "") => route({ host: TUBE_HOST, path, query: new URLSearchParams(query), cookie: "" });

test("模拟观看页：认得的两个视频回页面，别的视频、别的路径都算意外", () => {
  for (const id of Object.keys(TUBE_VIDEOS)) {
    const answer = ask("/watch", `v=${id}`);
    assert.equal(answer.status, 200);
    assert.equal(answer.unexpected, undefined);
    assert.deepEqual(parseWatchUrl(tubeWatchPage(id)), { platform: "youtube", videoId: id });
  }
  assert.equal(ask("/watch", "v=jmTube99999").unexpected, true);
  for (const path of ["/sample/api", "/feed", "/results"]) assert.equal(ask(path).unexpected, true, path);
  assert.ok(hostRulesFor(4321).includes(`MAP ${TUBE_HOST} 127.0.0.1:4321`));
});

test("模拟观看页的结构：应用外壳、带视频编号的观看页外壳、播放器、文字稿入口和面板、语言菜单", () => {
  const [id = ""] = Object.keys(TUBE_VIDEOS);
  const html = tubePageHtml(id);
  for (const piece of [
    "<ytd-app>",
    `<ytd-watch-flexy video-id="${id}">`,
    'class="html5-video-player"',
    'class="html5-main-video"',
    "ytd-video-description-transcript-section-renderer",
    'target-id="engagement-panel-searchable-transcript"',
    "ytd-transcript-footer-renderer",
    "segment-timestamp",
    "segment-text",
    "yt-navigate-finish",
  ]) {
    assert.ok(html.includes(piece), piece);
  }
});
