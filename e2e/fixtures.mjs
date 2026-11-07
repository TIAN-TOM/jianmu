// 模拟 B 站接口用的响应样例，全部自造：视频号、密钥和文字都不来自真实响应。

const KEY_IMAGE_BASE = "https://i0.hdslb.com/bfs/wbi";
const CAPTION_FILE_BASE = "//aisubtitle.hdslb.com/bfs/subtitle";
const COVER_BASE = "https://i0.hdslb.com/bfs/archive";

export const LOGIN_COOKIE = "e2e_session=1";

/** @typedef {{ imgKey: string, subKey: string }} Keys */

/** @type {Keys} */
export const KEYS = { imgKey: "0123456789abcdef0123456789abcdef", subKey: "fedcba98765432100123456789abcdef" };
/** 平台换过的密钥。 @type {Keys} */
export const ROTATED_KEYS = { imgKey: "aaaa0000bbbb1111cccc2222dddd3333", subKey: "eeee4444ffff55556666777788889999" };

/**
 * @typedef {object} Video
 * @property {string} bvid
 * @property {number} aid
 * @property {number} cid
 * @property {number} mid
 * @property {string} title
 * @property {string} owner
 * @property {number} duration
 */

/** @type {Video} */
export const FIRST_VIDEO = { bvid: "BV1Sample001", aid: 1001, cid: 2001, mid: 3001, title: "样例长视频", owner: "样例作者", duration: 1800 };
/** @type {Video} */
export const SECOND_VIDEO = { bvid: "BV1Sample002", aid: 1002, cid: 2002, mid: 3002, title: "第二个样例视频", owner: "另一位样例作者", duration: 900 };

/** @type {Readonly<Record<string, Video>>} */
export const VIDEOS = { [FIRST_VIDEO.bvid]: FIRST_VIDEO, [SECOND_VIDEO.bvid]: SECOND_VIDEO };

/** @param {Keys} keys */
export function accountImages(keys) {
  return { img_url: `${KEY_IMAGE_BASE}/${keys.imgKey}.png`, sub_url: `${KEY_IMAGE_BASE}/${keys.subKey}.png` };
}

/**
 * @param {Video} video
 * @param {Record<string, unknown>} [overrides]
 */
export function viewData(video, overrides = {}) {
  return {
    bvid: video.bvid,
    aid: video.aid,
    cid: video.cid,
    title: video.title,
    desc: `${video.title}的简介`,
    duration: video.duration,
    owner: { name: video.owner, mid: video.mid },
    rights: { pay: 0, ugc_pay: 0, arc_pay: 0 },
    is_upower_exclusive: false,
    pages: [{ page: 1, cid: video.cid, part: video.title, duration: video.duration }],
    ...overrides,
  };
}

/** @param {Video} video */
function trackList(video) {
  return [
    { lan: "zh-CN", lan_doc: "中文（中国）", subtitle_url: `${CAPTION_FILE_BASE}/sample-zh.json`, ai_status: 0, ai_type: 0, author_mid: video.mid },
    { lan: "ai-en", lan_doc: "英语（自动生成）", subtitle_url: `${CAPTION_FILE_BASE}/sample-en.json`, ai_status: 2, ai_type: 1, author_mid: 0 },
  ];
}

/**
 * @param {Video} video
 * @param {{ tracks?: readonly unknown[] }} [options]
 */
export function playerData(video, { tracks = trackList(video) } = {}) {
  return {
    need_login_subtitle: false,
    subtitle: { subtitles: tracks },
    view_points: [
      { content: "样例分段一", from: 0, to: 600 },
      { content: "样例分段二", from: 600, to: 1800 },
    ],
  };
}

/** 字幕地址放在不可信的主机上。 @param {Video} video */
export function untrustedTracks(video) {
  return trackList(video).map((track) => ({ ...track, subtitle_url: "https://files.example.com/bfs/subtitle/sample.json" }));
}

export function summaryData() {
  return {
    code: 0,
    stid: "1",
    model_result: {
      summary: "这是自造的样例总结。",
      outline: [
        {
          title: "样例小节",
          timestamp: 30,
          part_outline: [{ timestamp: 30, content: "样例要点" }],
        },
      ],
      subtitle: [{ part_subtitle: [{ content: "样例总结里的台词", start_timestamp: 0, end_timestamp: 2 }] }],
    },
  };
}

/**
 * @param {Video} video
 * @param {boolean} paid
 */
function watchLaterItem(video, paid) {
  return {
    bvid: video.bvid,
    cid: video.cid,
    title: video.title,
    pic: `${COVER_BASE}/${video.bvid}.jpg`,
    desc: `${video.title}的简介`,
    duration: video.duration,
    owner: { name: video.owner, mid: video.mid },
    videos: 1,
    count: 1,
    progress: 0,
    add_at: 1800000000,
    state: 0,
    rights: paid ? { pay: 1 } : { pay: 0, ugc_pay: 0, arc_pay: 0 },
  };
}

/** @param {{ paid?: boolean }} [options] 第一项要不要带付费标记 */
export function watchLaterData({ paid = false } = {}) {
  return { count: 2, list: [watchLaterItem(FIRST_VIDEO, paid), watchLaterItem(SECOND_VIDEO, false)] };
}

export function captionFile() {
  return {
    body: [
      { from: 0, to: 2.5, content: "样例台词一" },
      { from: 2.5, to: 5, content: "样例台词二" },
    ],
  };
}

export const COVER_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>';
