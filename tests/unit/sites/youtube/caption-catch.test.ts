// 主世界里接住播放器取回的字幕：页面用假的请求对象和一个事件目标代替。看只认取字幕的那一种请求、只记那几项、只留最近两份、
// 超大的不存、出错不碍页面的请求、新的一份顶替时把原来的函数还回去；内容脚本的问话只认带着自己标记、视频对得上、形状对的回答。样例全是自造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import { INJECTED } from "../../../../src/shared/names.ts";
import { askPlayerCaption, switchCaptionCatch } from "../../../../src/sites/youtube/page/caption-ask.ts";
import { captionSourceOf, startCaptionCatch, type CatchScope } from "../../../../src/sites/youtube/page/caption-catch.ts";
import { CAPTION_LIMITS, captionReplyOf, playerCaptionOf } from "../../../../src/sites/youtube/page/caption-types.ts";
import { startMainBridge } from "../../../../src/sites/youtube/page/main-bridge.ts";

const ORIGIN = "https://www.youtube.com";
const ID = "jmSample0001";
const OTHER = "jmSample0002";
const TOKEN = "jm-sample-token-0001";
const BODY = '{"events":[{"tStartMs":0,"segs":[{"utf8":"sample"}]}]}';
const address = (query: string) => `/api/timedtext?${query}`;

/** 假的网页请求对象：记下页面自己的打开和发出，发出以后由测试决定什么时候回、回什么。 */
class FakeRequest {
  static sent: FakeRequest[] = [];
  readyState = 0;
  status = 0;
  responseType = "";
  body = "";
  opened: unknown[] = [];
  private listeners = new Map<string, Set<() => void>>();
  get responseText(): string {
    if (this.responseType !== "" && this.responseType !== "text") throw new Error("自造的错误：不是文本");
    return this.body;
  }
  open(...args: unknown[]): void {
    this.opened = args;
  }
  send(): void {
    FakeRequest.sent.push(this);
  }
  addEventListener(type: string, listener: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }
  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  finish(status: number, body: string): void {
    this.readyState = 4;
    this.status = status;
    this.body = body;
    for (const listener of [...(this.listeners.get("loadend") ?? [])]) listener();
  }
}

function pageWith() {
  FakeRequest.sent = [];
  const document = Object.assign(new EventTarget(), { getElementById: () => null });
  const Request = class extends FakeRequest {};
  const scope = { document, location: { origin: ORIGIN }, XMLHttpRequest: Request } as unknown as CatchScope;
  const original = { open: Request.prototype.open, send: Request.prototype.send };
  /** 页面自己发一个请求，回来时回 body。 */
  const request = (url: string | URL, body = BODY, setup: (request: FakeRequest) => void = () => undefined): FakeRequest => {
    const made = new Request();
    setup(made);
    made.open("GET", url);
    made.send();
    made.finish(200, body);
    return made;
  };
  return { document, scope, Request, original, request };
}

test("认得取字幕的请求：视频、语言、自动生成、机器翻译和译成的语言；别的地址、别的站点、少了编号或语言都不认", () => {
  assert.deepEqual(captionSourceOf(address(`v=${ID}&lang=en&sig=sample`), ORIGIN), { videoId: ID, lang: "en", auto: false, translated: false, targetLang: "" });
  assert.deepEqual(captionSourceOf(address(`v=${ID}&lang=en&kind=asr&tlang=fr`), ORIGIN), { videoId: ID, lang: "en", auto: true, translated: true, targetLang: "fr" });
  for (const bad of [`/api/other?v=${ID}&lang=en`, `https://sample.example/api/timedtext?v=${ID}&lang=en`, address("lang=en"), address(`v=${ID}`), address(`v=${ID}&lang=en&tlang=%20`), address("v=bad id&lang=en")]) {
    assert.equal(captionSourceOf(bad, ORIGIN), null, bad);
  }
});

test("接住页面自己取回的字幕，只记那几项，不记地址和别的参数；页面的请求照常发出、参数原样", () => {
  const w = pageWith();
  const stop = startCaptionCatch(w.scope);
  const made = w.request(address(`v=${ID}&lang=en&sig=sample-secret`), BODY, (request) => (request.responseType = "text"));
  assert.deepEqual(made.opened, ["GET", address(`v=${ID}&lang=en&sig=sample-secret`)]);
  assert.equal(FakeRequest.sent.length, 1);
  const found = askPlayerCaption(w.document, ID, TOKEN);
  assert.deepEqual(found, { videoId: ID, lang: "en", auto: false, translated: false, targetLang: "", text: BODY });
  assert.ok(!JSON.stringify(found).includes("sample-secret"));
  assert.equal(askPlayerCaption(w.document, OTHER, TOKEN), null, "别的视频没有");
  stop();
});

test("只认成功、文本、不超上限的；别的请求不碰；只留最近两份，问的时候交这个视频最近的一份", () => {
  const w = pageWith();
  startCaptionCatch(w.scope);
  w.request(address(`v=${ID}&lang=en`), BODY, (request) => (request.responseType = "json"));
  w.request(address(`v=${ID}&lang=en`), "x".repeat(CAPTION_LIMITS.text + 1));
  w.request(`/api/other?v=${ID}&lang=en`);
  const failed = new w.Request();
  failed.open("GET", address(`v=${ID}&lang=en`));
  failed.send();
  failed.finish(404, BODY);
  assert.equal(askPlayerCaption(w.document, ID, TOKEN), null);
  w.request(address(`v=${ID}&lang=en`), '{"events":[]}');
  w.request(new URL(`${ORIGIN}${address(`v=${ID}&lang=de`)}`));
  assert.equal(askPlayerCaption(w.document, ID, TOKEN)?.lang, "de");
  w.request(address(`v=${OTHER}&lang=en`));
  w.request(address(`v=${OTHER}&lang=fr`));
  assert.equal(askPlayerCaption(w.document, ID, TOKEN), null, "只留最近两份");
  assert.equal(askPlayerCaption(w.document, OTHER, TOKEN)?.lang, "fr");
});

test("接的时候出错也不碍页面的请求", () => {
  const w = pageWith();
  startCaptionCatch(w.scope);
  const made = new w.Request();
  Object.defineProperty(made, "addEventListener", { value: () => { throw new Error("自造的错误"); } });
  made.open("GET", address(`v=${ID}&lang=en`));
  assert.doesNotThrow(() => made.send());
  assert.equal(FakeRequest.sent.length, 1);
  const odd = new w.Request();
  assert.doesNotThrow(() => odd.open("GET", { toString: () => { throw new Error("自造的错误"); } }));
});

test("新注入的一份顶替时：旧的停下、把原来的函数还回去，新的再包一层；接的东西不跨份", () => {
  const w = pageWith();
  startMainBridge(w.document as unknown as Document);
  startCaptionCatch(w.scope);
  assert.notEqual(w.Request.prototype.open, w.original.open);
  w.request(address(`v=${ID}&lang=en`));
  startMainBridge(w.document as unknown as Document);
  assert.equal(w.Request.prototype.open, w.original.open);
  assert.equal(w.Request.prototype.send, w.original.send);
  assert.equal(askPlayerCaption(w.document, ID, TOKEN), null);
  const stop = startCaptionCatch(w.scope);
  w.request(address(`v=${ID}&lang=en`));
  assert.equal(askPlayerCaption(w.document, ID, TOKEN)?.videoId, ID);
  stop();
  assert.equal(w.Request.prototype.open, w.original.open);
});

test("内容脚本只认带着自己标记、视频对得上、形状和大小都对的回答", () => {
  const document = new EventTarget();
  const answer = (detail: unknown) => document.addEventListener(INJECTED.captionsAsk, () => document.dispatchEvent(new CustomEvent(INJECTED.captionsAnswer, { detail })), { once: true });
  const good = { videoId: ID, lang: "en", auto: true, translated: false, targetLang: "", text: BODY };
  for (const detail of [
    JSON.stringify({ token: "jm-other-token-0001", caption: good }),
    JSON.stringify({ token: TOKEN, caption: { ...good, videoId: OTHER } }),
    JSON.stringify({ token: TOKEN, caption: { ...good, auto: "yes" } }),
    JSON.stringify({ token: TOKEN, caption: { ...good, translated: true } }),
    JSON.stringify({ token: TOKEN, caption: { ...good, text: "" } }),
    "不是 JSON",
    { token: TOKEN, caption: good },
    "x".repeat(CAPTION_LIMITS.answer + 1),
  ]) {
    answer(detail);
    assert.equal(askPlayerCaption(document, ID, TOKEN), null, String(detail).slice(0, 60));
  }
  answer(JSON.stringify({ token: TOKEN, caption: { ...good, translated: true, targetLang: "fr" } }));
  assert.equal(askPlayerCaption(document, ID, TOKEN)?.targetLang, "fr");
});

test("后台核对内容脚本的回答：接住了必须带字幕，别的结果不许带", () => {
  const good = { videoId: ID, lang: "en", auto: false, translated: false, targetLang: "", text: BODY };
  assert.equal(captionReplyOf({ outcome: "caught", caption: good, player: null })?.caption?.videoId, ID);
  assert.equal(captionReplyOf({ outcome: "caught", caption: null }), null);
  assert.equal(captionReplyOf({ outcome: "not-caught", caption: good }), null);
  assert.deepEqual(captionReplyOf({ outcome: "ad", caption: null }), { outcome: "ad", caption: null, player: null });
  assert.equal(captionReplyOf({ outcome: "other" }), null);
  assert.equal(playerCaptionOf({ ...good, targetLang: "fr" }), null, "不是机器翻译却带着译成的语言");
});

test("内容脚本撤下时叫小桥停下：接住的清掉、之后的不接、问也不答；再接上以后照常接", () => {
  const w = pageWith();
  const stop = startCaptionCatch(w.scope);
  w.request(address(`v=${ID}&lang=en`));
  assert.equal(askPlayerCaption(w.document, ID, TOKEN)?.videoId, ID);
  switchCaptionCatch(w.document, false);
  assert.equal(askPlayerCaption(w.document, ID, TOKEN), null);
  // 停着的时候页面的请求照常发出，只是不记。
  const made = w.request(address(`v=${ID}&lang=en`));
  assert.deepEqual(made.opened, ["GET", address(`v=${ID}&lang=en`)]);
  assert.equal(FakeRequest.sent.length, 2);
  switchCaptionCatch(w.document, true);
  assert.equal(askPlayerCaption(w.document, ID, TOKEN), null);
  w.request(address(`v=${ID}&lang=en`));
  assert.equal(askPlayerCaption(w.document, ID, TOKEN)?.videoId, ID);
  // 认不出的指令不理。
  w.document.dispatchEvent(new CustomEvent(INJECTED.captionsSwitch, { detail: "sample" }));
  assert.equal(askPlayerCaption(w.document, ID, TOKEN)?.videoId, ID);
  stop();
});

test("停之前发出、停了以后才回来的请求：再接上时也不记", () => {
  const w = pageWith();
  const stop = startCaptionCatch(w.scope);
  const early = new w.Request();
  early.open("GET", address(`v=${ID}&lang=en`));
  early.send();
  switchCaptionCatch(w.document, false);
  switchCaptionCatch(w.document, true);
  early.finish(200, BODY);
  assert.equal(askPlayerCaption(w.document, ID, TOKEN), null);
  // 接上以后才发出的照常记。
  w.request(address(`v=${ID}&lang=en`));
  assert.equal(askPlayerCaption(w.document, ID, TOKEN)?.videoId, ID);
  stop();
});
