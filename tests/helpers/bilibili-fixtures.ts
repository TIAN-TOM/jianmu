// B 站接口的响应样例，全部自造：视频号、密钥和说明文字都不来自真实响应。
import type { SigningKeys } from "../../src/sites/bilibili/sign.ts";

export const BVID = "BV1Sample000";

export const FIRST_KEYS = { imgKey: "aaaabbbbccccddddeeeeffff00001111", subKey: "2222333344445555666677778888999a" };
export const SECOND_KEYS = { imgKey: "1111000033332222555544447777666a", subKey: "bbbbaaaaddddccccffffeeee99998888" };

const KEY_IMAGE_BASE = "https://i0.hdslb.com/bfs/wbi";

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function keyImages(keys: SigningKeys): { img_url: string; sub_url: string } {
  return { img_url: `${KEY_IMAGE_BASE}/${keys.imgKey}.png`, sub_url: `${KEY_IMAGE_BASE}/${keys.subKey}.png` };
}

export function navLoggedIn(keys: SigningKeys = FIRST_KEYS): unknown {
  return { code: 0, data: { isLogin: true, wbi_img: keyImages(keys) } };
}

/** 已登录，但响应里没有密钥。 */
export function navWithoutKeys(): unknown {
  return { code: 0, data: { isLogin: true } };
}

/** 未登录时账号接口也带着密钥。 */
export function navLoggedOut(keys: SigningKeys = FIRST_KEYS): unknown {
  return { code: -101, data: { isLogin: false, wbi_img: keyImages(keys) } };
}

export interface ViewOverrides {
  readonly [field: string]: unknown;
}

export function viewData(overrides: ViewOverrides = {}): Record<string, unknown> {
  return {
    bvid: BVID,
    aid: 1001,
    cid: 2002,
    title: "样例视频",
    desc: "样例简介",
    duration: 120,
    owner: { name: "样例作者", mid: 3003 },
    rights: { pay: 0, ugc_pay: 0, arc_pay: 0 },
    is_upower_exclusive: false,
    pages: [{ page: 1, cid: 2002, part: "样例视频", duration: 120 }],
    ...overrides,
  };
}

export function viewEnvelope(overrides: ViewOverrides = {}): unknown {
  return { code: 0, data: viewData(overrides) };
}

/** 平台限流或拦下请求的几种响应：每个接口都按这张表逐条过。 */
export const BAN_RESPONSES: readonly (readonly [string, () => Response])[] = [
  ["HTTP 412 加 -412", () => json(412, { code: -412, message: "sample refusal" })],
  ["HTTP 200 加 -412", () => json(200, { code: -412, message: "sample refusal" })],
  ["HTTP 412 但响应体不是 JSON", () => new Response("<html>sample refusal</html>", { status: 412 })],
  ["HTTP 429 但响应体不是 JSON", () => new Response("sample refusal", { status: 429 })],
  ["HTTP 429 加 -509", () => json(429, { code: -509, message: "sample refusal" })],
  ["HTTP 200 加 -799", () => json(200, { code: -799, message: "sample refusal" })],
  ["HTTP 200 加 -509", () => json(200, { code: -509, message: "sample refusal" })],
];
