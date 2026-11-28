// 模型请求的并发：后台只有一道共用闸门，概览和结论两个服务排它（自动生成、本窗口全部生成、粗筛写结论都经这两个服务）；
// 翻译按自己的上限并发，不排这道闸门；问答、解释这类一次一路，也不过它。传输层没有全局的并发控制。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { TRANSLATION_BATCH_MAX_SEGMENTS } from "../../../src/core/ai/chunking.ts";
import { createLimiter } from "../../../src/core/concurrency.ts";
import type { TranscriptSegment } from "../../../src/core/transcript/segment.ts";
import { AI_CONCURRENCY } from "../../../src/shared/settings-schema.ts";
import { deferred } from "../../helpers/deferred.ts";
import { overviewHarness } from "../../helpers/overview-service.ts";
import { listSourceFiles, splitSource } from "../../helpers/source-scan.ts";
import { cue, transcriptView, translateHarness } from "../../helpers/translate-service.ts";
import { stillFalse, until } from "../../helpers/wait-until.ts";

const SRC = new URL("../../../src/", import.meta.url).pathname;
const code = (relative: string): string => splitSource(readFileSync(`${SRC}${relative}`, "utf8")).code;
const sources = (): { readonly path: string; readonly code: string }[] =>
  listSourceFiles(SRC, { relativeTo: SRC, skipDeclarations: true }).map((path) => ({ path, code: code(path) }));

test("共用的并发闸门只建一道，只交给概览和结论两个服务；传输层没有全局的并发控制", () => {
  const all = sources();
  assert.deepEqual(all.filter(({ code: text }) => text.includes("createLimiter(")).map(({ path }) => path), ["background/app.ts", "core/concurrency.ts"]);
  const usesGate = all.filter(({ path, code: text }) => path !== "core/concurrency.ts" && /\bLimiter\b/.test(text)).map(({ path }) => path).sort();
  assert.deepEqual(usesGate, [
    "background/app.ts",
    "background/services/overview/chunks.ts",
    "background/services/overview/conclude.ts",
    "background/services/overview/generate.ts",
    "background/services/overview/index.ts",
    "background/services/overview/verdict.ts",
  ]);
  // 拿到这道闸门的只有两处拼装：概览服务（assemble-overview.ts）和结论服务（app.ts 的 assembleVerdict）。
  const handedOut = all.flatMap(({ path, code: text }) => [...text.matchAll(/gate: parts\.gate/g)].map(() => path)).sort();
  assert.deepEqual(handedOut, ["background/app.ts", "background/assemble-overview.ts"]);
  assert.match(code("background/app.ts"), /function assembleVerdict[\s\S]*?gate: parts\.gate[\s\S]*?\n\}/);
  const transport = all.filter(({ path }) => path.startsWith("core/ai/transport/"));
  assert.ok(transport.length > 0);
  for (const { path, code: text } of transport) assert.doesNotMatch(text, /Limiter|mapWithConcurrency|inFlight|active\s*[+-]=/, path);
});

/** 比闸门的上限多一段，各成一块。 */
function segmentsOverCap(): TranscriptSegment[] {
  return Array.from({ length: AI_CONCURRENCY + 1 }, (_, index) => ({ id: `s${index}`, start: index * 150, text: `第${index}段。${"字".repeat(1800)}`, texts: [`第${index}段。`] }));
}

test("翻译不排概览那道闸门：概览把闸门占满时，翻译照样按自己的上限另发一批", async () => {
  const gate = createLimiter();
  const blocked = deferred();
  const overview = overviewHarness({ gate, concurrency: AI_CONCURRENCY, segments: segmentsOverCap(), respond: async (ask) => (ask.isVerdict ? undefined : (await blocked.promise, undefined)) });
  void overview.generate().result;
  assert.ok(await until(() => overview.chunkAsks().length === AI_CONCURRENCY), "概览占满闸门");
  assert.ok(await stillFalse(() => overview.chunkAsks().length > AI_CONCURRENCY), "多出的那块在闸门外排队");

  const cues = Array.from({ length: TRANSLATION_BATCH_MAX_SEGMENTS * AI_CONCURRENCY + 1 }, (_, index) => cue(index * 10, `第${index + 1}句`));
  const translate = translateHarness(await transcriptView(cues));
  const release = translate.fake.hold("rewrite");
  void translate.translate();
  assert.ok(await translate.requested(AI_CONCURRENCY), "翻译自己并发到上限");
  assert.ok(await stillFalse(() => translate.requests() > AI_CONCURRENCY), "多出的那批按翻译自己的上限排队");
  assert.equal(overview.chunkAsks().length + translate.requests(), AI_CONCURRENCY * 2, "同时在途的模型请求");
  release();
  blocked.resolve();
});
