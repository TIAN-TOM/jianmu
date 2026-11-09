// 划词解释：先经任务登记（选中的文字和附近的字幕随登记一起交），再凭任务号开始。
// 输出被截断、又没法加大预算时，传输层交回半截正文并标截断：结果带标记，正文末尾注明可能不完整，页面不用改就看得到。
import assert from "node:assert/strict";
import { test } from "node:test";
import { selectionInput } from "../../../../src/background/services/explain.ts";
import type { Result } from "../../../../src/core/errors.ts";
import type { TaskView } from "../../../../src/core/tasks.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";
import type { ExplainView } from "../../../../src/shared/messages/qa.ts";
import { reply, type SentRequest } from "../../../helpers/fake-model-service.ts";
import { SAMPLE_ID } from "../../../helpers/fake-site-service.ts";
import { studyBackground } from "../../../helpers/study-background.ts";
import { cue, studyHarness, VIDEO } from "../../../helpers/study-service.ts";
import { until } from "../../../helpers/wait-until.ts";

const PLAYING = videoKey({ platform: "bilibili", videoId: SAMPLE_ID, segment: 1 });

const userOf = (request: SentRequest): string => {
  const messages = (request.body?.messages ?? []) as { readonly role: string; readonly content: string }[];
  return messages.find((message) => message.role === "user")?.content ?? "";
};

async function explainWith(content: string, finishReason: string) {
  const bg = studyBackground({ handler: () => reply({ choices: [{ finish_reason: finishReason, message: { content } }] }) });
  const started = await bg.send<{ readonly task: TaskView }>("task.start", { kind: "explain", video: PLAYING, selection: "术语", context: "上下文" });
  assert.ok(started.ok, JSON.stringify(started));
  const result = await bg.send<ExplainView>("explain.selection", { video: PLAYING, taskId: started.value.task.id });
  return { bg, result };
}

/** 第一次请求发出去的全部消息，拼成一段好搜。 */
const sentText = (h: ReturnType<typeof studyHarness>): string => JSON.stringify(h.fake.calls[0]?.request.messages ?? []);

const valueOf = (result: Result<ExplainView>): ExplainView => {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value;
};

test("解释被截断：结果标 truncated，正文末尾注明可能不完整", async () => {
  const { result } = await explainWith("这个术语指的是在机器学习中", "length");
  const value = valueOf(result);
  assert.equal(value.truncated, true);
  assert.ok(value.explanation.startsWith("这个术语指的是在机器学习中"));
  assert.match(value.explanation, /可能不完整/);
});

test("完整的解释不带截断标记，也不加注", async () => {
  const { bg, result } = await explainWith("一句完整的解释。", "stop");
  const value = valueOf(result);
  assert.equal("truncated" in value, false);
  assert.equal(value.explanation, "一句完整的解释。");
  const [sent] = bg.ai.posts();
  assert.ok(sent && userOf(sent).includes("术语") && userOf(sent).includes("上下文"), "选中的文字和附近的字幕都送到了");
  assert.equal(bg.site.calls.length, 0, "为解释一个词不向视频网站读任何东西");
});

test("选中的是空白时在入口拦下，不登记任务、不发请求；选中的和附近的字幕按上限截短", async () => {
  const bg = studyBackground({ handler: () => reply({ choices: [{ finish_reason: "stop", message: { content: "解释" } }] }) });
  assert.deepEqual(await bg.send("task.start", { kind: "explain", video: PLAYING, selection: "  \n " }), { ok: false, code: "EMPTY_SELECTION" });
  assert.deepEqual(await bg.send("task.start", { kind: "explain", video: PLAYING }), { ok: false, code: "INVALID_REQUEST" });
  assert.deepEqual(await bg.send("task.start", { kind: "explain", video: PLAYING, selection: "词", extra: 1 }), { ok: false, code: "INVALID_REQUEST" });
  const listed = await bg.send<{ readonly tasks: readonly TaskView[] }>("task.list", {});
  assert.deepEqual(listed.ok && listed.value.tasks, []);

  assert.equal(bg.ai.posts().length, 0);

  const long = selectionInput(` ${"选".repeat(1500)} `, "文".repeat(5000));
  assert.ok(long.ok);
  assert.deepEqual([long.value.selection.length, long.value.context.length], [1000, 4000]);
});

test("视频标题只看本机已有的字幕缓存：有就带上，没有写「未知」，不向视频网站读", async () => {
  const cached = studyHarness({ transcripts: { [VIDEO]: [cue(0, "字幕")] }, info: { title: "缓存里的标题" }, ai: { replies: { explain: "解释" } } });
  await cached.explain.explain(await cached.register("explain", { selection: "词", context: "" }), VIDEO);
  assert.match(sentText(cached), /视频：缓存里的标题/);
  assert.match(sentText(cached), /上下文：无/, "没给附近的字幕时写「无」");

  const missing = studyHarness({ transcripts: {}, ai: { replies: { explain: "解释" } } });
  await missing.explain.explain(await missing.register("explain", { selection: "词", context: "" }), VIDEO);
  assert.match(sentText(missing), /视频：未知/);
  assert.deepEqual([cached.reads().ensure, missing.reads().ensure], [0, 0], "只看缓存，不发起读取");
});

test("同一处连点两下解释：登记接上同一个任务，两次开始只发一次请求；用户点停止按取消收尾", async () => {
  const h = studyHarness({ ai: { replies: { explain: "解释" } } });
  const release = h.fake.hold("explain");
  const first = await h.register("explain", { selection: "词", context: "上下文" });
  const second = await h.register("explain", { selection: "词", context: "上下文" });
  assert.equal(second, first);
  const both = [h.explain.explain(first, VIDEO), h.explain.explain(second, VIDEO)];
  assert.ok(await until(() => h.fake.count("explain") === 1));
  release();
  const [one, two] = await Promise.all(both);
  assert.deepEqual(one, two);
  assert.equal(h.fake.count("explain"), 1);

  h.fake.hold("explain");
  const stopped = await h.register("explain", { selection: "另一个词", context: "" });
  const pending = h.explain.explain(stopped, VIDEO);
  assert.ok(await until(() => h.fake.count("explain") === 2));
  h.tasks.cancel(stopped);
  assert.deepEqual(await pending, { ok: false, code: "TASK_CANCELED" });
  assert.deepEqual(h.logs, []);
});
