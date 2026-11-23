// 构建参数到开关取值，开关记录的写读。打包怎么用这份记录见 package.test.ts。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BUILD_FLAGS_FILE,
  BUILD_VARIANTS,
  buildFlagProblems,
  buildFlagsRecord,
  clearBuildFlags,
  featuresFromArgs,
  readBuildFlags,
  writeBuildFlags,
} from "../../../scripts/lib/build-flags.mjs";
import { DAILY_FEATURES, RELEASE_FEATURES, TEST_BUILD_FEATURES } from "../../../src/shared/features.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const work = mkdtempSync(join(tmpdir(), "jianmu-build-flags-test-"));
after(() => rmSync(work, { recursive: true, force: true }));

test("不带参数是发行构建；--test-build 全开；--daily 是日用那份；没有别的构建参数", () => {
  assert.deepEqual(featuresFromArgs([]), RELEASE_FEATURES);
  assert.deepEqual(featuresFromArgs(["--watch"]), RELEASE_FEATURES);
  assert.deepEqual(featuresFromArgs(["--test-build"]), TEST_BUILD_FEATURES);
  assert.deepEqual(featuresFromArgs(["--watch", "--daily"]), DAILY_FEATURES);
  assert.deepEqual(Object.keys(BUILD_VARIANTS).sort(), ["--daily", "--test-build"]);
  assert.throws(() => featuresFromArgs(["--test-build", "--daily"]), /只能选一个/);
});

test("开关记录放在 build/ 之外，不进包", () => {
  assert.equal(dirname(BUILD_FLAGS_FILE), ROOT);
});

test("开关记录写下去读得回来，构建开始前删掉旧记录", () => {
  const file = join(work, "flags.json");
  assert.equal(readBuildFlags(file), undefined, "没有记录");
  writeBuildFlags(TEST_BUILD_FEATURES, file);
  assert.deepEqual(readBuildFlags(file), {
    FEATURE_FRAME_EXPLAIN: true,
    FEATURE_YOUTUBE: true,
    FEATURE_YOUTUBE_OPEN_PANEL: true,
    FEATURE_YOUTUBE_CAPTION_CATCH: true,
    FEATURE_KEEP_CONSENT: false,
  });
  writeBuildFlags(RELEASE_FEATURES, file);
  assert.deepEqual(readBuildFlags(file), buildFlagsRecord(RELEASE_FEATURES));
  assert.deepEqual(buildFlagProblems(readBuildFlags(file)), []);
  clearBuildFlags(file);
  assert.equal(readBuildFlags(file), undefined);
  clearBuildFlags(file);
  writeFileSync(file, "{ 不是 JSON");
  assert.equal(readBuildFlags(file), null);
  assert.ok(buildFlagProblems(readBuildFlags(file)).length > 0);
});

test("直接读产品模块的脚本先加载发行取值：说明按发行构建算；已经定义过的不动", async () => {
  const script = [
    'await import("./scripts/lib/release-globals.mjs");',
    'const { ACTIVATION_TABLE } = await import("./src/core/consent.ts");',
    "console.log(JSON.stringify([FEATURE_FRAME_EXPLAIN, FEATURE_YOUTUBE_OPEN_PANEL, ACTIVATION_TABLE.flatMap((row) => row.items).some(({ id }) => id === \"current-frame\")]));",
  ].join("\n");
  const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: ROOT, encoding: "utf8" });
  assert.deepEqual(JSON.parse(output), [RELEASE_FEATURES.frameExplain, RELEASE_FEATURES.youtubeOpenPanel, RELEASE_FEATURES.frameExplain]);
  // 本进程先加载了测试构建的取值，再加载发行取值也不改。
  await import("../../../scripts/lib/release-globals.mjs");
  assert.equal(FEATURE_FRAME_EXPLAIN, TEST_BUILD_FEATURES.frameExplain);
});
