// 端到端的模拟 YouTube：只有自造的观看页和静音媒体，别的路径都算意外请求；页面上有内容脚本和面板读取认的那几处结构。
import assert from "node:assert/strict";
import { test } from "node:test";
import { hostRulesFor, route } from "../../../../e2e/mock-server.mjs";
import { TUBE_CAPTION_PATH, TUBE_HOST, TUBE_VIDEOS, tubeCaptionJson, tubePageHtml, tubeWatchPage } from "../../../../e2e/youtube-page.mjs";
import { parseCaptionJson } from "../../../../src/sites/youtube/caption-json.ts";
import { PANEL_LIMITS } from "../../../../src/sites/youtube/page/panel-types.ts";
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

test("模拟观看页的结构：应用外壳、带视频编号的观看页外壳、播放器、文字稿入口和面板、语言菜单、放卡片的右栏", () => {
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
    '<div id="secondary-inner">',
    '<div id="related">',
  ]) {
    assert.ok(html.includes(piece), piece);
  }
});

test("播放器取的字幕：只给只有播放器字幕的那个视频的英文原文，别的视频、别的语言、机器翻译都算意外；正文解析得出每一句", () => {
  const id = "jmTube00009";
  const answer = ask(TUBE_CAPTION_PATH, `v=${id}&lang=en`);
  assert.equal(answer.status, 200);
  assert.equal(answer.unexpected, undefined);
  assert.deepEqual(parseCaptionJson(tubeCaptionJson(id), PANEL_LIMITS)?.map((line) => line.text), TUBE_VIDEOS[id].lines);
  for (const query of ["v=jmTube00001&lang=en", `v=${id}&lang=fr`, `v=${id}&lang=en&tlang=fr`]) assert.equal(ask(TUBE_CAPTION_PATH, query).unexpected, true, query);
});
