// 本机 HTTPS 模拟服务：一个端口扮演 B 站页面、接口和字幕文件主机，Chrome 把这几个主机解析到这里，按 Host 头分流。
// 路由是纯函数，单元测试拿真实读取实现直接对着它跑。验签用 node:crypto 另写一份：
// 要是拿产品自己的实现验签，签名用的常量写错时两边照样对得上，只能证明自洽。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
import {
  COVER_SVG,
  KEYS,
  LOGIN_COOKIE,
  ROTATED_KEYS,
  VIDEOS,
  accountImages,
  captionFile,
  playerData,
  summaryData,
  untrustedTracks,
  viewData,
  watchLaterData,
} from "./fixtures.mjs";

/**
 * @typedef {{ host: string, path: string, query: URLSearchParams, cookie: string, now?: number }} MockRequest
 * @typedef {{ status: number, headers?: Record<string, string>, body?: string, unexpected?: true }} MockResponse
 * @typedef {import("./fixtures.mjs").Keys} Keys
 * @typedef {import("./fixtures.mjs").Video} Video
 * @typedef {{ query: URLSearchParams, scenario: string, now: number }} Read
 */

const PAGE_HOST = "www.bilibili.com";
const API_HOST = "api.bilibili.com";
const FILE_HOST_SUFFIX = ".hdslb.com";

const ACCOUNT_PATH = "/x/web-interface/nav";
const MAX_SIGNATURE_AGE_SEC = 600;

const REORDER = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
  44, 52,
];

/** 探针用的地址和取值写法：e2e 脚本不写主机名、路径和响应结构。 */
export const PROBE = Object.freeze({
  account: `https://${API_HOST}${ACCOUNT_PATH}`,
  file: `https://aisubtitle${FILE_HOST_SUFFIX}/bfs/subtitle/sample-zh.json`,
  login: `https://${PAGE_HOST}/e2e/login`,
  cookie: LOGIN_COOKIE,
  loginOf: "(body) => body.data.isLogin",
});

/** @param {string} host */
export const apiHost = (host) => host === API_HOST;
/** @param {string} host */
export const fileHost = (host) => host.endsWith(FILE_HOST_SUFFIX);
/** 读视频内容的请求：接口主机上除登录检查以外的，加上字幕文件。 @param {{ host: string, path: string }} request */
export const contentRead = ({ host, path }) => (apiHost(host) && path !== ACCOUNT_PATH) || fileHost(host);

/** 只把这几个主机映射到本机，其余域名解析失败。 @param {number} port */
export function hostRulesFor(port) {
  const hosts = [PAGE_HOST, API_HOST, `*${FILE_HOST_SUFFIX}`];
  return [...hosts.map((host) => `MAP ${host} 127.0.0.1:${port}`), "MAP * ~NOTFOUND"].join(", ");
}

/**
 * @param {number} status
 * @param {unknown} payload
 * @param {Record<string, string>} [headers]
 * @returns {MockResponse}
 */
function json(status, payload, headers = {}) {
  return { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers }, body: JSON.stringify(payload) };
}

/**
 * @param {number} status
 * @param {string} contentType
 * @param {string} body
 * @param {Record<string, string>} [headers]
 * @returns {MockResponse}
 */
function text(status, contentType, body, headers = {}) {
  return { status, headers: { "Content-Type": contentType, "Cache-Control": "no-store", ...headers }, body };
}

/** @param {MockResponse} [response] @returns {MockResponse} */
function unexpected(response = { status: 404 }) {
  return { ...response, unexpected: true };
}

/** @param {unknown} data */
const ok = (data) => json(200, { code: 0, message: "0", data });
/** @param {number} code */
const refused = (code) => json(200, { code, message: "sample refusal" });

/** @type {Readonly<Record<string, () => MockResponse>>} */
const REFUSALS = {
  "http-429": () => text(429, "text/plain", "sample refusal", { "Retry-After": "120" }),
  "code-limited": () => refused(-412),
  "human-check": () => json(200, { code: -352, message: "sample check", data: { challenge: "sample" } }),
  "html-200": () => text(200, "text/html", "<html>sample page</html>"),
  "api-403": () => text(403, "text/plain", "sample refusal"),
};

/** @param {string} scenario */
const servingKeys = (scenario) => (scenario === "sign-rejected-once" ? ROTATED_KEYS : KEYS);

/**
 * @param {Readonly<Record<string, string>>} params
 * @param {Keys} keys
 */
function signatureFor(params, keys) {
  const material = keys.imgKey + keys.subKey;
  const secret = REORDER.map((position) => material[position]).join("").slice(0, 32);
  const query = Object.keys(params)
    .sort()
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]).replace(/[!'()*]/g, ""))}`)
    .join("&");
  return createHash("md5").update(query + secret).digest("hex");
}

/**
 * @param {URLSearchParams} query
 * @param {Keys} keys
 * @param {number} now
 */
function signedBy(query, keys, now) {
  const { w_rid: signature, ...params } = Object.fromEntries(query);
  const age = Math.abs(now / 1000 - Number(params["wts"]));
  return age < MAX_SIGNATURE_AGE_SEC && signature === signatureFor(params, keys);
}

/**
 * 签名要对、视频要认识，才轮到 read。换过密钥以后用旧密钥签的请求被拒一次。
 * @param {Read} request
 * @param {(video: Video) => MockResponse} read
 * @returns {MockResponse}
 */
function signedRead({ query, scenario, now }, read) {
  const keys = servingKeys(scenario);
  if (keys !== KEYS && signedBy(query, KEYS, now)) return refused(-352);
  if (!signedBy(query, keys, now)) return unexpected(refused(-352));
  const video = VIDEOS[query.get("bvid") ?? ""];
  if (!video || query.get("cid") !== String(video.cid)) return unexpected();
  return read(video);
}

/** 付费和确认不了是否付费的内容到视频信息就该停，后面的读取发过来就是意外。 @param {string} scenario */
const isPaid = (scenario) => ["paid", "upower-only", "paid-unknown"].includes(scenario);

/** @param {Read} request */
function readView({ query, scenario }) {
  const video = VIDEOS[query.get("bvid") ?? ""];
  if (!video || scenario === "not-found") return refused(-404);
  if (scenario === "paid") return ok(viewData(video, { rights: { pay: 1 } }));
  if (scenario === "upower-only") return ok(viewData(video, { is_upower_exclusive: true }));
  // 付费标记缺一个，其余都是假。
  if (scenario === "paid-unknown") return ok(viewData(video, { rights: { pay: 0, ugc_pay: 0 } }));
  return ok(viewData(video));
}

/** @param {Read} request */
function readPlayer(request) {
  if (isPaid(request.scenario)) return unexpected();
  return signedRead(request, (video) => {
    if (request.scenario === "no-captions") return ok(playerData(video, { tracks: [] }));
    if (request.scenario === "untrusted-file-host") return ok(playerData(video, { tracks: untrustedTracks(video) }));
    return ok(playerData(video));
  });
}

/** @param {Read} request */
function readSummary(request) {
  if (isPaid(request.scenario)) return unexpected();
  return signedRead(request, () => ok(summaryData()));
}

/** @param {Read} request */
const readWatchLater = ({ scenario }) => ok(watchLaterData({ paid: scenario === "paid" }));

/** @type {Readonly<Record<string, (request: Read) => MockResponse>>} */
const CONTENT_ROUTES = {
  "/x/web-interface/view": readView,
  "/x/player/wbi/v2": readPlayer,
  "/x/web-interface/view/conclusion/get": readSummary,
  "/x/v2/history/toview": readWatchLater,
};

/** @param {string} cookie @param {string} scenario */
function isLoggedIn(cookie, scenario) {
  return scenario !== "logged-out" && cookie.split(/;\s*/).includes(LOGIN_COOKIE);
}

/** @param {boolean} loggedIn @param {string} scenario */
function readAccount(loggedIn, scenario) {
  const data = { isLogin: loggedIn, wbi_img: accountImages(servingKeys(scenario)) };
  return json(200, { code: loggedIn ? 0 : -101, message: loggedIn ? "0" : "sample login required", data });
}

/**
 * @param {string} path
 * @param {boolean} loggedIn
 * @param {Read} request
 * @returns {MockResponse}
 */
function apiRoute(path, loggedIn, request) {
  if (path === ACCOUNT_PATH) return readAccount(loggedIn, request.scenario);
  const read = CONTENT_ROUTES[path];
  if (!read) return unexpected();
  // 没带登录状态就发到这里，说明登录门没挡住。
  if (!loggedIn) return unexpected(refused(-101));
  return REFUSALS[request.scenario]?.() ?? read(request);
}

/**
 * @param {string} path
 * @param {string} cookie
 * @param {string} scenario
 * @returns {MockResponse}
 */
function fileRoute(path, cookie, scenario) {
  if (cookie) return unexpected();
  if (/^\/bfs\/subtitle\/[\w-]+\.json$/.test(path)) {
    if (scenario === "file-429") return text(429, "text/plain", "sample refusal");
    return json(200, scenario === "empty-file" ? { body: [] } : captionFile());
  }
  if (/^\/bfs\/archive\/[\w-]+\.jpg$/.test(path)) return text(200, "image/svg+xml", COVER_SVG);
  return unexpected();
}

/** @param {string} path @returns {MockResponse} */
function pageRoute(path) {
  if (path === "/e2e/login") {
    const cookie = `${LOGIN_COOKIE}; Domain=.bilibili.com; Path=/; Secure; SameSite=Lax`;
    return text(200, "text/html; charset=utf-8", "<title>login</title>", { "Set-Cookie": cookie });
  }
  if (path === "/favicon.ico") return { status: 204 };
  return unexpected();
}

/**
 * 回答一个请求。没带登录状态读内容、路径不认识、字幕文件带了 Cookie，这些情况都带 unexpected。
 * @param {MockRequest} request
 * @param {string} [scenario] 场景开关，空串是一切正常
 * @returns {MockResponse}
 */
export function route({ host, path, query, cookie, now = Date.now() }, scenario = "") {
  if (host === PAGE_HOST) return pageRoute(path);
  if (apiHost(host)) return apiRoute(path, isLoggedIn(cookie, scenario), { query, scenario, now });
  if (fileHost(host)) return fileRoute(path, cookie, scenario);
  return unexpected();
}

/** 临时自签证书，只活一次运行。 @param {string} dir */
function selfSignedCert(dir) {
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  const args = ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath, "-days", "1", "-subj", "/CN=jianmu-e2e"];
  execFileSync("openssl", args, { stdio: "ignore" });
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

/** @param {{ dir: string }} options 放临时证书的目录 */
export async function startMockServer({ dir }) {
  /** @type {{ host: string, path: string, cookie: string, unexpected: boolean }[]} */
  const requests = [];
  // 当前场景，空串是一切正常；测试中途可以换。
  let scenario = "";
  const server = createServer(selfSignedCert(dir), (req, res) => {
    const host = String(req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
    const { pathname: path, searchParams: query } = new URL(req.url ?? "/", "https://mock.invalid");
    const cookie = req.headers.cookie ?? "";
    const answer = route({ host, path, query, cookie }, scenario);
    requests.push({ host, path, cookie, unexpected: answer.unexpected === true });
    res.writeHead(answer.status, answer.headers);
    res.end(answer.body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("模拟服务器没有拿到端口");
  return {
    hostRules: hostRulesFor(address.port),
    requests,
    /** 换场景，之后的请求按它回答。 @param {string} name */
    setScenario(name) {
      scenario = name;
    },
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}

