// 卡片框架的明暗：插入时把周围页面的明暗写在卡片地址的 # 后面；之后页面换了明暗，等卡片在听了才发消息告诉它，
// 没变不发；挪位置让卡片重新载入以后，从地址上写的明暗重新算起。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createCardFrame, type CardSlot } from "../../../src/content/card-frame.ts";
import type { PageTone } from "../../../src/content/page-tone.ts";
import { CARD_TONE, INJECTED } from "../../../src/shared/names.ts";

const CARD_URL = "chrome-extension://dynamic-sample/pages/card.html";
const ROOT = "chrome-extension://sample-extension/";
const ORIGIN = "chrome-extension://sample-extension";
/** 在右栏里时每隔这么多轮才全面核对一次。 */
const FULL_CHECK = 5;

interface FakeFrame {
  id: string;
  title: string;
  src: string;
  style: { cssText: string; height: string };
  isConnected: boolean;
  parentElement: unknown;
  nextSibling: unknown;
  contentWindow: { postMessage(message: unknown, origin: string): void };
  remove(): void;
}

function world(initial: PageTone | null) {
  const posted: { message: unknown; origin: string }[] = [];
  const listeners: ((event: unknown) => void)[] = [];
  const frames: FakeFrame[] = [];
  const contentWindow = { postMessage: (message: unknown, origin: string) => void posted.push({ message, origin }) };
  const column = (name: string) => ({
    name,
    insertBefore(node: FakeFrame, before: unknown) {
      node.parentElement = this;
      node.nextSibling = before;
      node.isConnected = true;
    },
  });
  const state = { tone: initial, parent: column("右栏"), title: "简幕卡片" };
  const document = {
    defaultView: { addEventListener: (_type: string, listener: (event: unknown) => void) => void listeners.push(listener), removeEventListener: () => undefined },
    body: column("页面"),
    createElement(): FakeFrame {
      const node: FakeFrame = { id: "", title: "", src: "", style: { cssText: "", height: "" }, isConnected: false, parentElement: null, nextSibling: null, contentWindow, remove: () => void (node.isConnected = false) };
      frames.push(node);
      return node;
    },
  };
  const card = createCardFrame({
    document: document as unknown as Document,
    cardUrl: () => CARD_URL,
    extensionRoot: () => ROOT,
    slot: () => ({ parent: state.parent, before: null }) as unknown as CardSlot,
    fillsScreen: () => false,
    tone: () => state.tone,
    title: () => state.title,
  });
  return {
    card,
    state,
    frames,
    column,
    /** 卡片报了一次高度：从这时起它在听。 */
    cardReports: () => listeners.forEach((listener) => listener({ source: contentWindow, origin: ORIGIN, data: { source: INJECTED.cardMessage, type: "resize", height: 120 } })),
    /** 走够一次全面核对。 */
    fullCheck: () => {
      for (let i = 0; i < FULL_CHECK; i += 1) card.ensure();
    },
    tones: () => posted.filter(({ message }) => (message as { type?: string }).type === CARD_TONE.message),
  };
}

test("插入时把周围页面的明暗写在卡片地址的 # 后面；认不出时不写", () => {
  for (const tone of ["light", "dark"] as const) {
    const { card, frames } = world(tone);
    card.ensure();
    assert.equal(frames[0]?.src, `${CARD_URL}#${CARD_TONE.param}=${tone}`);
  }
  const unknown = world(null);
  unknown.card.ensure();
  assert.equal(unknown.frames[0]?.src, CARD_URL);
});

test("框架的名字用调用方给的，界面语言换了跟着换，不重新插", () => {
  const { card, state, frames } = world("light");
  card.ensure();
  assert.equal(frames[0]?.title, "简幕卡片");
  state.title = "Jianmu card";
  card.ensure();
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.title, "Jianmu card");
});

test("页面换了明暗：卡片在听了才告诉它，只发给扩展自己的来源；没变不发，同一个明暗不重复发", () => {
  const { card, state, cardReports, fullCheck, tones } = world("light");
  card.ensure();
  state.tone = "dark";
  fullCheck();
  assert.deepEqual(tones(), [], "卡片还没报过高度，发了也收不到");

  cardReports();
  assert.deepEqual(tones(), [{ message: { source: INJECTED.hostMessage, type: CARD_TONE.message, tone: "dark" }, origin: ORIGIN }]);
  cardReports();
  fullCheck();
  assert.equal(tones().length, 1);

  state.tone = "light";
  card.ensure();
  assert.equal(tones().length, 1, "右栏里不是每一轮都核对");
  fullCheck();
  assert.equal(tones().length, 2);
  assert.equal((tones()[1]?.message as { tone?: string }).tone, "light");
});

test("明暗和地址上写的一样时不发；插入时认不出、后来认出了，补发一次；之后又认不出时不发", () => {
  const same = world("dark");
  same.card.ensure();
  same.cardReports();
  same.fullCheck();
  assert.deepEqual(same.tones(), []);

  const late = world(null);
  late.card.ensure();
  late.cardReports();
  assert.deepEqual(late.tones(), []);
  late.state.tone = "dark";
  late.fullCheck();
  assert.equal(late.tones().length, 1);
  late.state.tone = null;
  late.fullCheck();
  assert.equal(late.tones().length, 1);
});

test("挪位置让卡片按原地址重新载入：等它再报高度，才把和地址上不一样的明暗重新告诉它", () => {
  const { card, state, column, cardReports, fullCheck, tones } = world("light");
  card.ensure();
  cardReports();
  state.tone = "dark";
  fullCheck();
  assert.equal(tones().length, 1);

  // 页面把右栏换了一个：卡片挪过去，框架重新载入，又回到地址上写的浅色。
  state.parent = column("新的右栏");
  fullCheck();
  fullCheck();
  assert.equal(tones().length, 1, "重新载入的卡片还没在听");
  cardReports();
  assert.equal(tones().length, 2, "它回到了浅色，页面还是深色，再告诉一次");
  assert.equal((tones()[1]?.message as { tone?: string }).tone, "dark");
});
