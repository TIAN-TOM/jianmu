// 两份说明的英文措辞：每个条目、每句合成的措辞都有英文；排成行时按语言取，不传语言和原来一样是中文；加英文不动版本和指纹。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ACTIVATION_FINGERPRINT,
  ACTIVATION_TABLE,
  ACTIVATION_VERSION,
  currentStamp,
  DATA_CONSENT_ERROR,
  DATA_CONSENT_ERROR_EN,
  DATA_CONSENT_FINGERPRINT,
  DATA_CONSENT_TABLE,
  DATA_CONSENT_VERSION,
  dataConsentErrorText,
  noticeLines,
  noticeText,
  versionStamps,
  type NoticeItem,
  type NoticeTable,
} from "../../../src/core/consent.ts";
import { validate, validateForSave, DATA_CONSENT_CONFIRMED } from "../../../src/shared/settings-schema.ts";

const CJK = /[　-〿一-鿿＀-￯]/;
const itemsOf = (table: NoticeTable<string>): readonly NoticeItem<string>[] => table.flatMap((row) => row.items);
const ALL: readonly NoticeItem<string>[] = [...itemsOf(DATA_CONSENT_TABLE), ...itemsOf(ACTIVATION_TABLE)];

test("每个条目都有英文措辞，并显示的条目也有英文的合成措辞，里面没有中文", () => {
  // 测试构建打开了解释当前画面，那几条也在。
  assert.ok(ALL.some((item) => item.id === "current-frame"));
  for (const item of ALL) {
    const label = `${item.kind}:${item.id}`;
    assert.ok(item.en.trim(), `${label} 没有英文`);
    assert.doesNotMatch(item.en, CJK, `${label}：${item.en}`);
    assert.equal(noticeText(item), item.text);
    assert.equal(noticeText(item, "en"), item.en);
    if (!item.shownWith) continue;
    assert.ok(item.shownWith.combinedEn.trim(), `${label} 没有英文的合成措辞`);
    assert.doesNotMatch(item.shownWith.combinedEn, CJK, `${label}：${item.shownWith.combinedEn}`);
  }
});

test("排成行：不传语言和传中文一样，英文的行和中文的行一一对应", () => {
  for (const table of [DATA_CONSENT_TABLE, ACTIVATION_TABLE] as readonly NoticeTable<string>[]) {
    const items = itemsOf(table);
    const zh = noticeLines(items);
    assert.deepEqual(noticeLines(items, "zh"), zh);
    const en = noticeLines(items, "en");
    assert.deepEqual(en.map(({ kind, ids }) => ({ kind, ids })), zh.map(({ kind, ids }) => ({ kind, ids })));
    for (const line of en) assert.doesNotMatch(line.text, CJK, line.ids.join(","));
  }
  // 只列新增的、指向的那一条不在这组里：单列，用自己的英文措辞。
  const duration = DATA_CONSENT_TABLE.flatMap((row) => row.items).find((item) => item.id === "video-duration");
  assert.ok(duration);
  assert.deepEqual(noticeLines([duration], "en"), [{ kind: "category", ids: ["video-duration"], text: "Video length" }]);
  const title = DATA_CONSENT_TABLE.flatMap((row) => row.items).find((item) => item.id === "video-title");
  assert.ok(title);
  assert.deepEqual(noticeLines([title, duration], "en"), [{ kind: "category", ids: ["video-title", "video-duration"], text: "Video title and length" }]);
});

test("加英文不动版本和指纹：指纹只算条目的类别和标识", () => {
  assert.deepEqual(currentStamp(DATA_CONSENT_TABLE), { version: DATA_CONSENT_VERSION, fingerprint: DATA_CONSENT_FINGERPRINT });
  assert.deepEqual(currentStamp(ACTIVATION_TABLE), { version: ACTIVATION_VERSION, fingerprint: ACTIVATION_FINGERPRINT });
  const reworded = DATA_CONSENT_TABLE.map((row) => ({ ...row, items: row.items.map((item) => ({ ...item, en: "changed" })) }));
  assert.deepEqual(versionStamps(reworded), versionStamps(DATA_CONSENT_TABLE));
});

test("没同意数据说明的提示：中文那句仍是标识，英文另取", () => {
  assert.equal(dataConsentErrorText(), DATA_CONSENT_ERROR);
  assert.equal(dataConsentErrorText("zh"), DATA_CONSENT_ERROR);
  assert.equal(dataConsentErrorText("en"), DATA_CONSENT_ERROR_EN);
  assert.doesNotMatch(DATA_CONSENT_ERROR_EN, CJK);
});

test("设置的校验提示：不传语言和原来一样是中文，英文每一条都没有中文", () => {
  const cases: readonly unknown[] = [
    {},
    { presetId: "custom", aiBaseUrl: "http://example.test", aiModel: "" },
    { presetId: "custom", aiBaseUrl: "not a url" },
    { presetId: "custom", aiBaseUrl: "https://[::1]/v1" },
    { presetId: "custom", aiBaseUrl: "" },
  ];
  for (const settings of cases) {
    const zh = validate(settings);
    assert.deepEqual(validate(settings, "zh"), zh);
    const en = validate(settings, "en");
    assert.equal(en.ok, zh.ok);
    assert.equal(en.errors.length, zh.errors.length, JSON.stringify(settings));
    for (const error of en.errors) assert.doesNotMatch(error, CJK, error);
    const save = validateForSave(settings);
    assert.deepEqual(validateForSave(settings, "zh"), save);
    const saveEn = validateForSave(settings, "en");
    assert.equal(saveEn.ok, save.ok);
    for (const error of saveEn.errors) assert.doesNotMatch(error, CJK, error);
  }
  // 后台按中文那句认出只差同意：不传语言时那一句还是 DATA_CONSENT_ERROR。
  const onlyConsent = { presetId: "custom", aiBaseUrl: "https://example.test", aiApiKey: "k", aiModel: "m" };
  assert.deepEqual(validate(onlyConsent).errors, [DATA_CONSENT_ERROR]);
  assert.deepEqual(validate(onlyConsent, "en").errors, [DATA_CONSENT_ERROR_EN]);
  assert.deepEqual(validate({ ...onlyConsent, ...DATA_CONSENT_CONFIRMED }, "en").errors, []);
});
