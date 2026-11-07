import assert from "node:assert/strict";
import { test } from "node:test";
import * as pickTrackModule from "../../../../src/core/transcript/pick-track.ts";
import { pickTrack, pickTrackByLang, type PickableTrack } from "../../../../src/core/transcript/pick-track.ts";

type Track = PickableTrack & { readonly trackId: string };

const human = (lang: string, trackId = lang, isOriginalLang?: boolean): Track => ({ trackId, lang, kind: "human", isOriginalLang });
const auto = (lang: string, trackId = lang, isOriginalLang?: boolean): Track => ({ trackId, lang, kind: "auto", isOriginalLang });

test("选轨顺序：按语言偏好，同语言下人工字幕优先于 AI", () => {
  const tracks = [human("en-US"), auto("ai-zh"), human("zh-CN")];
  assert.equal(pickTrack(tracks)?.lang, "zh-CN");

  const aiOnly = [auto("ai-zh"), human("en-US")];
  assert.equal(pickTrack(aiOnly)?.lang, "en-US", "拿不到原语言时，其余这一档里人工在自动之前");
  assert.equal(pickTrack([auto("en"), human("ja")])?.lang, "ja");

  const bothAi = [auto("ai-en"), auto("ai-zh")];
  assert.equal(pickTrack(bothAi)?.lang, "ai-zh");

  const sameLang = [auto("zh-CN", "auto"), human("zh-CN", "human")];
  assert.equal(pickTrack(sameLang)?.trackId, "human");

  assert.equal(pickTrack([]), null);
  assert.equal(pickTrack(null), null);

  // 三档的先后：原语言人工、中文人工、原语言自动。
  assert.equal(pickTrack([human("zh-CN"), auto("en-US", "auto"), human("en-US", "human")], "en")?.trackId, "human");
  assert.equal(pickTrack([human("zh-CN"), auto("en-US"), auto("ai-en")], "en")?.lang, "zh-CN");
  assert.equal(pickTrack([auto("ai-zh"), human("ja"), auto("en-US")], "en")?.lang, "en-US");
  // 原语言自动排在外语人工之前，外语人工排在其余自动之前。
  assert.equal(pickTrack([human("en-US"), auto("ai-zh")], "zh-CN")?.lang, "ai-zh");
  assert.equal(pickTrack([auto("ai-zh"), human("en-US")], "ja")?.lang, "en-US");
  // 中文的地区写法也算中文人工，同一档里具体中文在前。
  assert.equal(pickTrack([human("en"), human("zh-TW")])?.lang, "zh-TW");
  assert.equal(pickTrack([human("en"), human("ZH-TW")])?.lang, "ZH-TW");
  assert.equal(pickTrack([human("zh-CN"), human("zh-Hant"), human("zh-Hans")])?.lang, "zh-Hans");
  // 语言码是空串的轨不算原语言，拿不到原语言时也不会排到中文前面。
  assert.equal(pickTrack([human("zh-CN"), human("")])?.lang, "zh-CN");
  // 适配层明确标过的算数，语言码比对只在没标时用。
  assert.equal(pickTrack([human("zh-CN"), human("en", "en", false), human("ja", "ja", true)], "en")?.lang, "ja");
});

test("语言优先级固定在代码里，选轨不接受外面传进来的偏好", () => {
  const tracks = [human("zh-CN", "zh"), human("en-US", "en")];
  // 第二个参数是视频的原语言，不是偏好表：列表里没有这种语言时顺序不变，也不看传入的先后。
  assert.equal(pickTrack(tracks, "ja")?.trackId, "zh");
  assert.equal(pickTrack([...tracks].reverse())?.trackId, "zh");
  // 传偏好数组进来也不会把英文排到前面。
  assert.equal(pickTrack(tracks, ["en-US", "zh-CN"] as never)?.trackId, "zh");
  assert.deepEqual(Object.keys(pickTrackModule).sort(), ["pickTrack", "pickTrackByLang"]);
});

test("原语言没标也拿不到时不猜，按语言表顺序选", () => {
  // 适配层有可靠依据才标原语言，标了就按原语言人工字幕选。
  assert.equal(pickTrack([human("zh-Hans", "zh"), human("en-US", "en", true)])?.lang, "en-US");

  // 没标、视频的原语言也拿不到：唯一的一种外语人工字幕不当原语言，中文人工排在前面。
  for (const audio of [undefined, null, ""]) {
    assert.equal(pickTrack([human("en-US"), human("zh-Hans")], audio)?.lang, "zh-Hans");
    assert.equal(pickTrack([human("en"), auto("ai-zh")], audio)?.lang, "en", "没有中文人工时，人工在自动之前");
    assert.equal(pickTrack([human("ja"), human("en-US")], audio)?.lang, "en-US", "外语人工之间按语言表");
    assert.equal(pickTrack([auto("ai-en"), auto("ai-zh")], audio)?.lang, "ai-zh", "只有自动字幕时按语言表");
  }
});

test("按语言点名选轨：手动切换字幕语言", () => {
  const tracks = [human("zh-CN", "zh"), auto("en-US", "en")];
  assert.equal(pickTrackByLang(tracks, "en-US")?.trackId, "en");
  assert.equal(pickTrackByLang(tracks, "zh-CN")?.trackId, "zh");

  // 列表里没有这条语言时（被平台限流、列表变化），非严格模式回退到固定顺序。
  assert.equal(pickTrackByLang(tracks, "ja-JP")?.trackId, "zh");
  assert.equal(pickTrackByLang(tracks, "")?.trackId, "zh");
  assert.equal(pickTrackByLang([], "en-US"), null);
  // 用户点名的语言不在列表里时，严格模式不能静默改回中文。
  assert.equal(pickTrackByLang(tracks, "ja-JP", { strict: true }), null);
  // 回退时带上原语言。
  assert.equal(pickTrackByLang([human("ja"), auto("en-US")], "ko", { audioLang: "en" })?.lang, "en-US");
});
