// 构建开关：发行默认值只有一处，开关名、全局常量、类型声明和 Node 测试里的定义对得上。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  FEATURE_GLOBALS,
  FEATURE_NAMES,
  featureDefines,
  RELEASE_FEATURES,
  TEST_BUILD_FEATURES,
  type FeatureSet,
} from "../../../src/shared/features.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("发行构建打开解释当前画面（首发带上），YouTube 的两个代操作关着；测试构建全部打开", () => {
  assert.deepEqual(FEATURE_NAMES, ["frameExplain", "youtubeOpenPanel", "youtubeSwitchLang"]);
  assert.deepEqual(RELEASE_FEATURES, { frameExplain: true, youtubeOpenPanel: false, youtubeSwitchLang: false });
  assert.deepEqual(TEST_BUILD_FEATURES, { frameExplain: true, youtubeOpenPanel: true, youtubeSwitchLang: true });
  assert.ok(Object.isFrozen(RELEASE_FEATURES) && Object.isFrozen(TEST_BUILD_FEATURES) && Object.isFrozen(FEATURE_GLOBALS));
});

test("全局常量名是开关名的大写下划线写法，带 FEATURE_ 前缀", () => {
  for (const name of FEATURE_NAMES) {
    assert.equal(FEATURE_GLOBALS[name], `FEATURE_${name.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`);
  }
});

test("define 把每个全局常量换成字面量，只认真正的 true", () => {
  assert.deepEqual(featureDefines(RELEASE_FEATURES), {
    FEATURE_FRAME_EXPLAIN: "true",
    FEATURE_YOUTUBE_OPEN_PANEL: "false",
    FEATURE_YOUTUBE_SWITCH_LANG: "false",
  });
  assert.deepEqual(featureDefines({ ...RELEASE_FEATURES, frameExplain: false, youtubeOpenPanel: true }), {
    FEATURE_FRAME_EXPLAIN: "false",
    FEATURE_YOUTUBE_OPEN_PANEL: "true",
    FEATURE_YOUTUBE_SWITCH_LANG: "false",
  });
  const loose = { frameExplain: "yes", youtubeOpenPanel: 1, youtubeSwitchLang: null } as unknown as FeatureSet;
  assert.deepEqual(Object.values(featureDefines(loose)), ["false", "false", "false"]);
});

test("类型声明里的全局常量就是开关表里那几个", () => {
  const declared = readFileSync(join(ROOT, "src/shared/build-flags.d.ts"), "utf8");
  const names = [...declared.matchAll(/\bconst (FEATURE_\w+): boolean;/g)].map((match) => match[1]);
  assert.deepEqual(names.sort(), Object.values(FEATURE_GLOBALS).sort());
});

test("Node 测试里的全局常量和测试构建一致，而且改不了", () => {
  const scope = globalThis as unknown as Record<string, unknown>;
  for (const name of FEATURE_NAMES) {
    assert.equal(scope[FEATURE_GLOBALS[name]], TEST_BUILD_FEATURES[name], FEATURE_GLOBALS[name]);
    // 模块代码是严格模式，给只读属性赋值会抛错。
    assert.throws(() => {
      scope[FEATURE_GLOBALS[name]] = !TEST_BUILD_FEATURES[name];
    }, TypeError);
  }
  assert.equal(FEATURE_YOUTUBE_OPEN_PANEL, true, "裸常量在测试里也能直接用");
});
