// 画面分析的模型能不能看图：探测记下的结果优先，再看本机的模型能力；说不准时发一张 8×8 的图探一次。
// 服务以看不了图拒掉记成不能看，连不上、密钥不对这类和看图无关的失败不记；探测途中清除了缓存就不写回去。
import assert from "node:assert/strict";
import { test } from "node:test";
import { createImageSupport, isImageRejection, PROBE_IMAGE, PROBE_TTL_MS, requireImage } from "../../../src/background/image-support.ts";
import { createClearGuard } from "../../../src/core/clear-guard.ts";
import { ok } from "../../../src/core/errors.ts";
import type { FrozenGen } from "../../../src/core/tasks.ts";
import { IMAGE_PROBE_STORAGE_KEY } from "../../../src/shared/names.ts";
import { createFakeAi, type FakeAiOptions } from "../../helpers/fake-ai.ts";
import { memoryStorage } from "../../helpers/memory-storage.ts";

const GEN: FrozenGen = { feature: "frame", baseUrl: "https://ai.example.test/v1", model: "vision-model", effort: "off", promptVersion: "v1" };

function setup(options: FakeAiOptions = {}, start = 1_000) {
  let clock = start;
  const fake = createFakeAi({ imageInput: "unknown", replies: { frame: "红色" }, ...options });
  const storage = memoryStorage();
  const clearGuard = createClearGuard();
  const images = createImageSupport({ storage, clearGuard, ai: fake.ai, now: () => clock });
  return { fake, storage, clearGuard, images, tick: (ms: number) => (clock += ms) };
}

const httpError = (status: number, message: string): Error => Object.assign(new Error(message), { status });

test("说不准时探一次：带一张 JPEG 小图和一句问题，图在前；能回话就记成能看，下次不再探", async () => {
  const { fake, storage, images } = setup();
  assert.equal(await images.known(GEN), "unknown");
  assert.deepEqual(await images.ensure(GEN), ok({ imageInput: true }));
  assert.equal(fake.calls.length, 1);
  const content = fake.calls[0]?.request.messages?.[0]?.content as readonly { readonly type: string; readonly dataUrl?: string }[];
  assert.deepEqual(content.map((part) => part.type), ["image", "text"]);
  assert.equal(content[0]?.dataUrl, PROBE_IMAGE);
  assert.ok(PROBE_IMAGE.startsWith("data:image/jpeg;base64,"));
  assert.equal(fake.calls[0]?.frozen?.model, "vision-model", "按画面分析选的模型探");

  assert.equal(await images.known(GEN), true);
  assert.deepEqual(await images.ensure(GEN), ok({ imageInput: true }));
  assert.equal(fake.calls.length, 1, "记住了，不再探");
  assert.deepEqual(Object.keys(storage.data[IMAGE_PROBE_STORAGE_KEY] as object), ["https://ai.example.test/v1|vision-model"]);
});

test("服务以看不了图拒掉：记成不能看，requireImage 回专门的码", async () => {
  const { images } = setup({ replies: { frame: httpError(400, "This model does not support image input") } });
  const probed = await images.probe(GEN);
  assert.deepEqual(probed, ok({ imageInput: false }));
  assert.equal(await images.known(GEN), false);
  assert.deepEqual(requireImage(probed), { ok: false, code: "AI_IMAGE_UNSUPPORTED" });
  assert.deepEqual(requireImage(ok({ imageInput: true })), ok(true));
});

test("和看图无关的失败照常报错，不记；收下了请求只是没写出正常回答的，算能看", async () => {
  const keyed = setup({ replies: { frame: httpError(401, "invalid image key") } });
  const failed = await keyed.images.probe(GEN);
  assert.equal(failed.ok, false);
  assert.equal(failed.ok ? "" : failed.code, "INVALID_AI_KEY");
  assert.equal(await keyed.images.known(GEN), "unknown", "没记");

  const empty = setup({ replies: { frame: Object.assign(new Error("空的"), { code: "EMPTY_AI_RESPONSE" }) } });
  assert.deepEqual(await empty.images.probe(GEN), ok({ imageInput: true }));
});

test("本机认得出的型号不探：能看就直接放行", async () => {
  const { fake, images } = setup({ imageInput: true });
  assert.deepEqual(await images.ensure(GEN), ok({ imageInput: true }));
  assert.equal(fake.calls.length, 0);
});

test("探测结果按地址加模型记，过期以后重新看；真实请求被拒也记成不能看", async () => {
  const { images, tick } = setup({ imageInput: true });
  await images.rejected(GEN);
  assert.equal(await images.known(GEN), false);
  assert.equal(await images.known({ ...GEN, model: "other" }), true, "别的模型不受影响");
  tick(PROBE_TTL_MS);
  assert.equal(await images.known(GEN), true, "过期了按本机的能力");
});

test("探测途中清除了缓存：结果不写回去", async () => {
  const { storage, clearGuard, images, fake } = setup();
  const release = fake.hold("frame");
  const probing = images.probe(GEN);
  await clearGuard.clear("cache", () => undefined);
  release();
  assert.deepEqual(await probing, ok({ imageInput: true }));
  assert.equal(storage.data[IMAGE_PROBE_STORAGE_KEY], undefined);
});

test("认得出的拒收：4xx 并且说明里提到图片；鉴权、找不到、限流和别的说法都不算", () => {
  assert.equal(isImageRejection(httpError(400, "image_url is not supported")), true);
  assert.equal(isImageRejection(httpError(422, "该模型不支持图片输入")), true);
  assert.equal(isImageRejection(httpError(400, "max_tokens too large")), false);
  for (const status of [401, 403, 404, 429, 500]) assert.equal(isImageRejection(httpError(status, "image")), false, String(status));
  assert.equal(isImageRejection(new Error("image")), false);
});
