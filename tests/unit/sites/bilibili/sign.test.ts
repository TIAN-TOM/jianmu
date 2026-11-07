import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  buildQuery,
  deriveSigningSecret,
  KEY_ORDER,
  keyFromImageUrl,
  keysFromNav,
  md5,
  signedUrl,
  signParams,
  type QueryParams,
  type SigningKeys,
} from "../../../../src/sites/bilibili/sign.ts";

interface GoldenCase {
  readonly id: string;
  readonly label: string;
  readonly fn: string;
  readonly args: readonly unknown[];
  readonly result?: unknown;
  readonly thrown?: { readonly $error: { readonly name: string; readonly message: string } };
}

const FIXTURE = new URL("../../../fixtures/golden/bilibili-sign.json", import.meta.url);
const { cases } = JSON.parse(readFileSync(FIXTURE, "utf8")) as { cases: readonly GoldenCase[] };

const REPLAY: Readonly<Record<string, (args: readonly unknown[]) => unknown>> = {
  md5: ([text]) => md5(text as string),
  keyFromImageUrl: ([url]) => keyFromImageUrl(url as string | null),
  deriveSigningSecret: ([imgKey, subKey]) => deriveSigningSecret(imgKey as string, subKey as string),
  buildQuery: ([params]) => buildQuery(params as QueryParams),
  signParams: ([params, keys, now]) => signParams(params as QueryParams, keys as SigningKeys, now as number),
  signedUrl: ([baseUrl, params, keys, now]) =>
    signedUrl(baseUrl as string, params as QueryParams, keys as SigningKeys, now as number),
};

// JSON 表达不了 undefined，样本里记成 { $undefined: true }。
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value === null || typeof value !== "object") return value;
  if ("$undefined" in value) return undefined;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item)]));
}

// 样本里的对象键按字典序。
function sorted(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)));
}

const casesOf = (fn: string): readonly GoldenCase[] => cases.filter((item) => item.fn === fn);

const KEYS: SigningKeys = { imgKey: "aaaabbbbccccddddeeeeffff00001111", subKey: "2222333344445555666677778888999a" };
const NOW = 1800000000;

test("样本覆盖全部用例和函数", () => {
  assert.equal(cases.length, 30);
  assert.deepEqual([...new Set(cases.map((item) => item.fn))].sort(), Object.keys(REPLAY).sort());
});

for (const item of cases) {
  test(`黄金样本 ${item.id} ${item.label}`.trim(), () => {
    const replay = REPLAY[item.fn];
    assert.ok(replay, `样本里有没接上的函数：${item.fn}`);
    const args = decode(item.args) as unknown[];
    if (item.thrown) {
      assert.throws(() => replay(args), item.thrown.$error);
      return;
    }
    assert.equal(JSON.stringify(sorted(replay(args))), JSON.stringify(item.result));
  });
}

test("自带的 MD5 与 node:crypto 结果一致", () => {
  const samples = [
    "",
    "abc",
    "The quick brown fox jumps over the lazy dog",
    "中文字幕测试",
    "a".repeat(55),
    "a".repeat(56),
    "a".repeat(64),
    "番茄".repeat(500),
  ];
  for (const sample of samples) {
    assert.equal(md5(sample), createHash("md5").update(sample, "utf8").digest("hex"), `md5 不一致：${sample.slice(0, 20)}`);
  }
});

test("从 wbi_img URL 中提取密钥文件名", () => {
  assert.equal(keyFromImageUrl(`https://i0.hdslb.com/bfs/wbi/${KEYS.imgKey}.png`), KEYS.imgKey);
  assert.equal(keyFromImageUrl(`//i0.hdslb.com/bfs/wbi/${KEYS.subKey}.png?v=1`), KEYS.subKey);
  assert.equal(keyFromImageUrl(""), "");
});

test("签名密钥推导和黄金样本一致", () => {
  assert.deepEqual([...KEY_ORDER].sort((a, b) => a - b), Array.from({ length: 64 }, (_, index) => index));
  const derived = casesOf("deriveSigningSecret").filter((item) => !item.thrown);
  assert.equal(derived.length, 2);
  for (const { args, result } of derived) {
    const secret = deriveSigningSecret(args[0] as string, args[1] as string);
    assert.equal(secret, result);
    assert.equal(secret.length, 32);
  }
});

test("密钥长度不足时拒绝推导，而不是产出错误签名", () => {
  assert.throws(() => deriveSigningSecret("short", "key"), /签名密钥长度不足/);
  assert.throws(() => signParams({ a: 1 }, { imgKey: "short", subKey: "key" }, NOW), /签名密钥长度不足/);
});

test("query 编码使用 encodeURIComponent 语义（大写十六进制 + %20）", () => {
  assert.equal(
    buildQuery({ row: "two two three", seed: "番茄", plot: 7070 }),
    "plot=7070&row=two%20two%20three&seed=%E7%95%AA%E8%8C%84",
  );
});

test("query 会先剔除值里的 !'()* 字符", () => {
  assert.equal(buildQuery({ a: "to!m'a(t)o*" }), "a=tomato");
});

test("w_rid 和黄金样本一致", () => {
  const signed = casesOf("signParams");
  assert.equal(signed.length, 5);
  for (const { id, args, result } of signed) {
    const [params, keys, now] = args as [QueryParams, SigningKeys, number];
    const actual = signParams(params, keys, now);
    assert.equal(actual.w_rid, (result as { w_rid: string }).w_rid, id);
    assert.equal(actual.wts, now, id);
    // 原始参数必须原样保留。
    assert.deepEqual({ ...actual, wts: undefined, w_rid: undefined }, { ...params, wts: undefined, w_rid: undefined }, id);
  }
});

test("signedUrl 拼出带签名的完整地址", () => {
  const base = "https://api.bilibili.com/x/player/wbi/v2";
  const params = { aid: 1, cid: 2, bvid: "BV1Sample000" };
  const url = signedUrl(base, params, KEYS, NOW);
  assert.ok(url.startsWith(`${base}?`), url);
  const query = new URL(url).searchParams;
  assert.equal(query.get("wts"), String(NOW));
  assert.equal(query.get("cid"), "2");
  assert.equal(query.get("w_rid"), signParams(params, KEYS, NOW).w_rid);
});

test("nav 响应解析出密钥对", () => {
  const images = {
    img_url: `https://i0.hdslb.com/bfs/wbi/${KEYS.imgKey}.png`,
    sub_url: `https://i0.hdslb.com/bfs/wbi/${KEYS.subKey}.png`,
  };
  assert.deepEqual(keysFromNav({ code: 0, data: { wbi_img: images } }), KEYS);
  assert.deepEqual(keysFromNav({ code: -101, data: { isLogin: false, wbi_img: images } }), KEYS, "没登录时响应里也有密钥");
});

test("nav 缺少 wbi_img 时拿不到密钥", () => {
  assert.equal(keysFromNav({ code: 0, data: {} }), null);
  assert.equal(keysFromNav({ code: 0, data: { wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${KEYS.imgKey}.png` } } }), null);
  assert.equal(keysFromNav({ code: 0 }), null);
  assert.equal(keysFromNav(null), null);
});

test("自造向量：派生和签名是写死的结果，node:crypto 独立算一遍也一样", () => {
  const secret = "55ea7cf2d6c18a5204b62c4e11d3d34d";
  assert.equal(deriveSigningSecret(KEYS.imgKey, KEYS.subKey), secret);

  const params = { bvid: "BV1Sample000", cid: 2002, note: "番茄 (a)!" };
  const signed = signParams(params, KEYS, NOW);
  const query = "bvid=BV1Sample000&cid=2002&note=%E7%95%AA%E8%8C%84%20a&wts=1800000000";
  assert.equal(buildQuery({ ...params, wts: NOW }), query);
  assert.equal(createHash("md5").update(query + secret, "utf8").digest("hex"), "ba5eaad99648a791a144b8316c871d62");
  assert.equal(signed.w_rid, "ba5eaad99648a791a144b8316c871d62");
  assert.equal(signed.wts, NOW);
  assert.equal(signed.note, "番茄 (a)!");
});

test("时间取整到秒，时间变了签名就变", () => {
  const signed = signParams({ a: 1 }, KEYS, NOW + 0.9);
  assert.equal(signed.wts, NOW);
  assert.equal(signed.w_rid, signParams({ a: 1 }, KEYS, NOW).w_rid);
  assert.notEqual(signed.w_rid, signParams({ a: 1 }, KEYS, NOW + 1).w_rid);
});

test("基础地址自带参数时拒绝：发出去的参数都要进签名", () => {
  assert.throws(() => signedUrl("https://example.invalid/sign?from=test", { a: 1 }, KEYS, NOW), /不能自带参数/);
  assert.throws(() => signedUrl("https://example.invalid/sign#part", { a: 1 }, KEYS, NOW), /不能自带参数/);
  const url = new URL(signedUrl("https://example.invalid/sign", { a: 1, from: "test" }, KEYS, NOW));
  const sent = Object.fromEntries([...url.searchParams].filter(([key]) => key !== "w_rid"));
  assert.equal(url.searchParams.get("w_rid"), signParams({ a: 1, from: "test" }, KEYS, NOW).w_rid);
  assert.deepEqual(Object.keys(sent).sort(), ["a", "from", "wts"]);
});
