// B 站接口要求的请求签名。
export interface SigningKeys {
  readonly imgKey: string;
  readonly subKey: string;
}

export type QueryValue = string | number | null | undefined;
export type QueryParams = Readonly<Record<string, QueryValue>>;

interface NavResponse {
  readonly data?: { readonly wbi_img?: { readonly img_url?: string; readonly sub_url?: string } };
}

const MD5_SHIFTS: readonly number[] = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 4,
  11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_SINE = Int32Array.from({ length: 64 }, (_, index) => Math.floor(Math.abs(Math.sin(index + 1)) * 4294967296) | 0);

const rotateLeft = (value: number, bits: number): number => ((value << bits) | (value >>> (32 - bits))) | 0;

// Web Crypto 没有 MD5。
export function md5(input: string): string {
  const message = new TextEncoder().encode(input);
  const bitLength = message.length * 8;
  // 补到 64 字节的整数倍，末尾写消息的比特长度。
  const paddedLength = (((message.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 4294967296), true);

  let a0 = 0x67452301 | 0;
  let b0 = 0xefcdab89 | 0;
  let c0 = 0x98badcfe | 0;
  let d0 = 0x10325476 | 0;

  const words = new Int32Array(16);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      words[i] = view.getInt32(offset + i * 4, true);
    }

    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;

    for (let i = 0; i < 64; i += 1) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }

      f = (f + a + (MD5_SINE[i] as number) + (words[g] as number)) | 0;
      a = d;
      d = c;
      c = b;
      b = (b + rotateLeft(f, MD5_SHIFTS[i] as number)) | 0;
    }

    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }

  const digest = new DataView(new ArrayBuffer(16));
  digest.setInt32(0, a0, true);
  digest.setInt32(4, b0, true);
  digest.setInt32(8, c0, true);
  digest.setInt32(12, d0, true);
  let hex = "";
  for (let i = 0; i < 16; i += 1) {
    hex += digest.getUint8(i).toString(16).padStart(2, "0");
  }
  return hex;
}

// 签名用的常量，顺序错一位签名就整体失效。
export const KEY_ORDER: readonly number[] = Object.freeze([
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
  44, 52,
]);

const SECRET_LENGTH = 32;

/** 取地址里的文件名，不带扩展名和参数。 */
export function keyFromImageUrl(url: string | null | undefined): string {
  const lastSegment = String(url || "").split("/").at(-1) ?? "";
  const [name = ""] = lastSegment.split("?");
  const dot = name.lastIndexOf(".");
  return dot === -1 ? name : name.slice(0, dot);
}

/** 取签名密钥，取不全时返回 null。 */
export function keysFromNav(response: unknown): SigningKeys | null {
  const images = (response as NavResponse | null | undefined)?.data?.wbi_img;
  const imgKey = keyFromImageUrl(images?.img_url);
  const subKey = keyFromImageUrl(images?.sub_url);
  return imgKey && subKey ? { imgKey, subKey } : null;
}

export function deriveSigningSecret(imgKey: string, subKey: string): string {
  const material = imgKey + subKey;
  if (material.length < KEY_ORDER.length) throw new Error("签名密钥长度不足");
  const reordered = KEY_ORDER.map((position) => material.charAt(position)).join("");
  return reordered.slice(0, SECRET_LENGTH);
}

function queryText(value: QueryValue): string {
  return String(value ?? "").replace(/[!'()*]/g, "");
}

// 编码规则固定，不用 URLSearchParams。
export function buildQuery(params: QueryParams): string {
  const pairs: string[] = [];
  for (const key of Object.keys(params).sort()) {
    pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(queryText(params[key]))}`);
  }
  return pairs.join("&");
}

/** 给参数加上时间和签名，原来的参数原样留着。时间由调用方传入，这里不读时钟。 */
export function signParams<T extends QueryParams>(
  params: T,
  keys: SigningKeys,
  nowSeconds: number,
): T & { wts: number; w_rid: string } {
  const secret = deriveSigningSecret(keys.imgKey, keys.subKey);
  const stamped = { ...params, wts: Math.floor(nowSeconds) };
  return { ...stamped, w_rid: md5(buildQuery(stamped) + secret) };
}

/** 发出去的参数要全部进签名，所以基础地址不能自带参数。 */
export function signedUrl(baseUrl: string, params: QueryParams, keys: SigningKeys, nowSeconds: number): string {
  if (/[?#]/.test(baseUrl)) throw new Error("签名的基础地址不能自带参数，参数都放进 params");
  return `${baseUrl}?${buildQuery(signParams(params, keys, nowSeconds))}`;
}
