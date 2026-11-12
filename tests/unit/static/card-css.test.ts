// 卡片样式的高度上限和内容脚本给框架夹的上限一致：上限不一样，底部按钮就会被框架裁掉，或者框架下面多出一截空白。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CARD_HEIGHT } from "../../../src/content/card-frame.ts";

test("卡片整张的最大高度等于框架的高度上限", () => {
  const css = readFileSync(new URL("../../../static/pages/card.css", import.meta.url), "utf8");
  const block = /^\.card \{([^}]*)\}/m.exec(css)?.[1] ?? "";
  assert.match(block, new RegExp(`max-height: ${CARD_HEIGHT.max}px;`));
  assert.match(block, /box-sizing: border-box;/, "边框算在上限以内");
});
