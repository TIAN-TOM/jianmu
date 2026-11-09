// 问答服务：检索、生成、引用校验、问答历史。先经任务登记（问题随登记一起交），再凭任务号开始；
// 回答只写进发起时那个视频的历史。
import assert from "node:assert/strict";
import { test } from "node:test";
import { FALLBACK_ANSWER } from "../../../../src/background/services/qa.ts";
import { QA_ANSWER } from "../../../../src/core/ai/schemas.ts";
import { describe, type Result } from "../../../../src/core/errors.ts";
import type { QaRecord } from "../../../../src/core/notes/records.ts";
import type { TaskView } from "../../../../src/core/tasks.ts";
import { videoKey } from "../../../../src/core/video-ref.ts";
import type { QaAnswerView, QaHistoryView } from "../../../../src/shared/messages/qa.ts";
import { chatReply, type ServiceReply } from "../../../helpers/fake-model-service.ts";
import { SAMPLE_ID } from "../../../helpers/fake-site-service.ts";
import { studyBackground } from "../../../helpers/study-background.ts";
import { cue, OTHER, studyHarness, VIDEO } from "../../../helpers/study-service.ts";
import { until } from "../../../helpers/wait-until.ts";

const answerOf = (result: Result<QaAnswerView>): QaRecord => {
  assert.ok(result.ok, JSON.stringify(result));
  return result.value.entry;
};

const userMessage = (request: { readonly messages?: readonly { readonly role: string; readonly content: unknown }[] | null }): string =>
  String(request.messages?.find((message) => message.role === "user")?.content ?? "");

// ============================================================
// 走真实后台分发
// ============================================================

const FIRST = videoKey({ platform: "bilibili", videoId: SAMPLE_ID, segment: 1 });
const SECOND = videoKey({ platform: "bilibili", videoId: SAMPLE_ID, segment: 2 });

async function startQa(send: ReturnType<typeof studyBackground>["send"], question: string, video = FIRST) {
  const started = await send<{ readonly task: TaskView; readonly joined: boolean }>("task.start", { kind: "qa", video, question });
  return started;
}

test("问答端到端：检索、生成、引用校验、历史落库与删除", async () => {
  const bg = studyBackground({
    cues: [{ start: 0, duration: 60, text: "字幕原句" }],
    handler: () => chatReply(JSON.stringify({ answer: "结论 [0:05]" })),
  });
  const started = await startQa(bg.send, "这个视频讲了什么？");
  assert.ok(started.ok, JSON.stringify(started));
  const result = await bg.send<QaAnswerView>("qa.ask", { video: FIRST, taskId: started.value.task.id });
  const entry = answerOf(result);
  assert.equal(entry.answer, "结论 [0:05]");
  // 依据由本地从字幕里取，不靠模型摘录。
  assert.deepEqual(entry.citations, [{ startSeconds: 5, quote: "字幕原句" }]);
  assert.ok(entry.clickable.includes(5), "正文里的时间点可以点");
  assert.equal(entry.derived.basis.source, "transcript");
  assert.equal(entry.derived.gen?.feature, "qa");

  const history = await bg.send<QaHistoryView>("qa.history", { video: FIRST });
  assert.ok(history.ok);
  assert.deepEqual(history.value.entries.map((item) => item.question), ["这个视频讲了什么？"]);
  const otherPart = await bg.send<QaHistoryView>("qa.history", { video: SECOND });
  assert.deepEqual(otherPart.ok && otherPart.value.entries, [], "分 P 之间互相隔离");

  assert.deepEqual(await bg.send("qa.delete", { id: entry.id }), { ok: true, value: {} });
  const emptied = await bg.send<QaHistoryView>("qa.history", { video: FIRST });
  assert.deepEqual(emptied.ok && emptied.value.entries, []);
  const listed = await bg.send<{ readonly tasks: readonly TaskView[] }>("task.list", {});
  assert.deepEqual(listed.ok && listed.value.tasks, [], "问答任务跑完就收尾");
});

test("空问题与超长问题在入口被拦下，不发起模型请求", async () => {
  const bg = studyBackground({ handler: () => chatReply(JSON.stringify({ answer: "x" })) });
  assert.deepEqual(await startQa(bg.send, "   "), { ok: false, code: "EMPTY_QUESTION" });
  assert.deepEqual(await startQa(bg.send, "问".repeat(501)), { ok: false, code: "QUESTION_TOO_LONG" });
  assert.equal((await startQa(bg.send, "问".repeat(500))).ok, true, "500 个字以内照常登记");
  assert.equal(bg.ai.posts().length, 0);
  assert.equal(bg.site.calls.length, 0, "登记时不取字幕");
});

// 完整的信封切在后半句之前：内层正文和外层的结束原因一起丢了，补齐以后才读得出来。
function cutChatEnvelope(content: string, marker: string): ServiceReply {
  const full = JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] });
  const raw = full.slice(0, full.indexOf(marker));
  assert.throws(() => JSON.parse(raw), "切出来的信封本身不是合法 JSON");
  return { ok: true, status: 200, text: async () => raw, json: async () => JSON.parse(raw) };
}

test("问答的回答来自补齐的信封：返回的结果和存下的记录都标着可能不完整", async () => {
  const bg = studyBackground({
    cues: [{ start: 0, duration: 10, text: "字幕依据" }],
    handler: () => cutChatEnvelope(JSON.stringify({ answer: "[0:00] 前半句已经到达，后半句尚未到达" }), "后半句"),
  });
  const started = await startQa(bg.send, "字幕说了什么？");
  assert.ok(started.ok);
  const entry = answerOf(await bg.send<QaAnswerView>("qa.ask", { video: FIRST, taskId: started.value.task.id }));
  assert.equal(entry.answer, "[0:00] 前半句已经到达，");
  assert.equal(entry.truncated, true);
  assert.equal(bg.ai.posts().length, 1, "断掉的连接加大预算也补不回来，不再付一次费");
  const history = await bg.send<QaHistoryView>("qa.history", { video: FIRST });
  assert.ok(history.ok);
  const [saved] = history.value.entries;
  assert.equal(saved?.answer, entry.answer);
  assert.equal(saved?.truncated, true);
});

test("同一个问题连点两下：登记接上同一个任务，两次开始只发一次模型请求，拿到同一份回答", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const bg = studyBackground({ handler: async () => (await gate, chatReply(JSON.stringify({ answer: "第一句 [0:00]" }))) });
  const first = await startQa(bg.send, "讲了什么");
  const second = await startQa(bg.send, "  讲了什么  ");
  assert.ok(first.ok && second.ok);
  assert.equal(second.value.task.id, first.value.task.id, "去掉首尾空白后是同一个问题");
  assert.equal(second.value.joined, true);
  const different = await startQa(bg.send, "别的问题");
  assert.ok(different.ok);
  assert.notEqual(different.value.task.id, first.value.task.id, "同一视频的不同问题各起各的，没有互斥");

  const asking = [first, second].map((started) => bg.send<QaAnswerView>("qa.ask", { video: FIRST, taskId: started.ok ? started.value.task.id : "" }));
  assert.ok(await until(() => bg.ai.posts().length === 1));
  release();
  const [one, two] = await Promise.all(asking);
  assert.deepEqual(one, two);
  assert.equal(bg.ai.posts().length, 1);
});

// ============================================================
// 服务本身
// ============================================================

test("引用全是幻觉时整条回答替换为兜底文案", async () => {
  const h = studyHarness({ ai: { replies: { qa: JSON.stringify({ answer: "编造的结论，没有任何时间戳" }) } } });
  const entry = answerOf(await h.ask("随便问点什么").result);
  assert.equal(entry.answer, FALLBACK_ANSWER);
  assert.deepEqual(entry.citations, []);
  assert.match(entry.answer, /未能从字幕中找到/);
});

test("取消问答任务返回 TASK_CANCELED 且不落历史", async () => {
  const h = studyHarness({ ai: { replies: { qa: JSON.stringify({ answer: "结论 [0:00]" }) } } });
  h.fake.hold("qa");
  const { taskId, result } = h.ask("会话中途取消");
  assert.ok(await until(() => h.fake.count("qa") === 1), "请求已经发出去");
  assert.ok(h.tasks.cancel(await taskId));
  assert.deepEqual(await result, { ok: false, code: "TASK_CANCELED" });
  assert.deepEqual(await h.qaStore.byVideo(VIDEO), []);
  assert.deepEqual(h.tasks.list(), [], "任务按取消收尾");
  assert.deepEqual(h.logs, [], "用户点停止不是故障，不报错误");
});

test("问答历史落库失败时，已生成的回答照常返回并如实标注", async () => {
  const h = studyHarness({
    ai: { replies: { qa: JSON.stringify({ answer: "结论 [0:00]" }) } },
    wrapQa: (inner) => ({ ...inner, commit: async () => Promise.reject(Object.assign(new Error("磁盘满"), { name: "UnknownError" })) }),
  });
  const result = await h.ask("结论？").result;
  assert.ok(result.ok, "落库失败不吞掉已经生成、已经花了钱的回答");
  assert.equal(result.value.historySaved, false);
  assert.equal(result.value.entry.answer, "结论 [0:00]");
  assert.deepEqual(h.logs, [{ level: "error", label: "问答历史保存失败" }]);
});

test("回答原样透传，不做二次加工", async () => {
  const h = studyHarness({ ai: { replies: { qa: JSON.stringify({ answer: "  “结论 [0:02]。”  " }) } } });
  const entry = answerOf(await h.ask("问题").result);
  assert.equal(entry.answer, "  “结论 [0:02]。”  ", "模型输出原样保存，样式归页面管");
  assert.deepEqual(entry.citations, [{ startSeconds: 2, quote: "字幕句子" }], "依据由本地从字幕提取");
  assert.equal(h.fake.count("qa"), 1);
});

test("回答由被截断的正文补齐得到时，标上可能不完整并随历史保存", async () => {
  const h = studyHarness({ ai: { replies: { qa: { text: '{"answer":"结论是 [0:02] 讲到了一半', truncated: true } } } });
  const entry = answerOf(await h.ask("问题").result);
  assert.equal(entry.answer, "结论是 [0:02] 讲到了一半");
  assert.equal(entry.truncated, true);
  const [saved] = await h.qaStore.byVideo(VIDEO);
  assert.equal(saved?.truncated, true, "截断标记随问答历史落库");
});

test("没被截断、或换成了兜底文案时，问答记录不带截断标记", async () => {
  const complete = studyHarness({ ai: { replies: { qa: JSON.stringify({ answer: "结论 [0:02]" }) } } });
  assert.equal("truncated" in answerOf(await complete.ask("问题").result), false);

  // 截断后的回答一条引用都没有：整条换成兜底文案，那段正文没用上。
  const fallback = studyHarness({ ai: { replies: { qa: { text: '{"answer":"没有时间戳的半句', truncated: true } } } });
  const replaced = answerOf(await fallback.ask("问题").result);
  assert.equal(replaced.answer, FALLBACK_ANSWER);
  assert.equal("truncated" in replaced, false);
  const [saved] = await fallback.qaStore.byVideo(VIDEO);
  assert.equal(saved && "truncated" in saved, false);
});

test("问答按回答正文的 schema 请求结构化输出", async () => {
  const h = studyHarness({ ai: { replies: { qa: JSON.stringify({ answer: "结论 [0:02]" }) } } });
  answerOf(await h.ask("问题").result);
  assert.deepEqual(
    h.fake.calls.map((call) => call.request.responseFormat),
    [QA_ANSWER],
  );
  assert.equal(h.fake.calls[0]?.frozen?.feature, "qa", "按登记时取定的问答配置发");
});

test("服务限流或过载、传输层要等一会儿再重发时，等待提示写进问答任务的进度", async () => {
  const h = studyHarness({
    ai: {
      replies: {
        qa: (request) => {
          request.onRetry?.({ status: 529, delayMs: 3000, message: "服务繁忙，3 秒后重试…" });
          return JSON.stringify({ answer: "结论 [0:02]" });
        },
      },
    },
  });
  const { taskId, result } = h.ask("问题");
  answerOf(await result);
  const id = await taskId;
  assert.ok(
    h.broadcasts.some((message) => message.type === "task.changed" && message.task.id === id && message.task.message === "服务繁忙，3 秒后重试…"),
    JSON.stringify(h.broadcasts),
  );
});

// 不认结构化输出的中转站、不守约定的模型会直接用散文回答。
test("模型用散文回答时保留这份已付费的回答，引用照样校验", async () => {
  const h = studyHarness({ ai: { replies: { qa: "根据字幕，结论在 [0:02] 讲到。" } } });
  const entry = answerOf(await h.ask("结论？").result);
  assert.equal(entry.answer, "根据字幕，结论在 [0:02] 讲到。");
  assert.equal(entry.citations.length, 1);
  assert.equal((await h.qaStore.byVideo(VIDEO)).length, 1, "存进了问答历史");
});

test("散文回答里没有落在字幕范围内的引用：照旧换成兜底文案", async () => {
  const h = studyHarness({ ai: { replies: { qa: "这个视频讲了很多方法。" } } });
  assert.equal(answerOf(await h.ask("结论？").result).answer, FALLBACK_ANSWER);
});

test("像 JSON 又解析不了的回答报 QA_PARSE_FAILED，提示换模型，不显示 V8 的报错", async () => {
  const h = studyHarness({ ai: { replies: { qa: "{oops 不是 JSON [" } } });
  const result = await h.ask("结论？").result;
  assert.deepEqual(result, { ok: false, code: "QA_PARSE_FAILED" }, "不带解析器的报错");
  assert.match(describe("QA_PARSE_FAILED"), /按功能选模型/);
  assert.doesNotMatch(describe("QA_PARSE_FAILED"), /Unexpected token|JSON/);
  assert.deepEqual(await h.qaStore.byVideo(VIDEO), []);
});

test("回答回来时侧边栏已经换了视频：回答只写进发起时那个视频的历史", async () => {
  const h = studyHarness({
    transcripts: { [VIDEO]: [cue(0, "原视频的字幕", 60)], [OTHER]: [cue(0, "新视频的字幕", 60)] },
    ai: { replies: { qa: (request) => JSON.stringify({ answer: `${userMessage(request).includes("原视频") ? "原视频" : "新视频"}的回答 [0:01]` }) } },
  });
  const release = h.fake.hold("qa");
  const original = h.ask("原视频讲了什么", VIDEO);
  assert.ok(await until(() => h.fake.count("qa") === 1));
  // 用户换到另一个视频，又问了一句；这时原视频的回答才回来。
  const switched = h.ask("新视频讲了什么", OTHER);
  assert.ok(await until(() => h.fake.count("qa") === 2));
  release();
  answerOf(await original.result);
  answerOf(await switched.result);
  assert.deepEqual((await h.qaStore.byVideo(VIDEO)).map((item) => [item.question, item.answer]), [["原视频讲了什么", "原视频的回答 [0:01]"]]);
  assert.deepEqual((await h.qaStore.byVideo(OTHER)).map((item) => [item.question, item.answer]), [["新视频讲了什么", "新视频的回答 [0:01]"]]);
});

test("等模型的工夫清除了本机数据：回答照常交回，不写进问答历史", async () => {
  const h = studyHarness({ ai: { replies: { qa: JSON.stringify({ answer: "结论 [0:00]" }) } } });
  const release = h.fake.hold("qa");
  const { result } = h.ask("问题");
  assert.ok(await until(() => h.fake.count("qa") === 1));
  await h.guard.clear("all", async () => {});
  release();
  const answered = await result;
  assert.ok(answered.ok);
  assert.equal(answered.value.historySaved, false);
  assert.deepEqual(await h.qaStore.byVideo(VIDEO), []);
});

test("只认登记成问答、而且是这个视频的任务号：别的任务、别的视频都不认，不取字幕也不发请求", async () => {
  const h = studyHarness({ ai: { replies: { qa: JSON.stringify({ answer: "结论 [0:00]" }) } } });
  const explainTask = await h.register("explain", { selection: "词", context: "" });
  assert.deepEqual(await h.qa.ask(explainTask, VIDEO), { ok: false, code: "TASK_NOT_FOUND" });
  const qaTask = await h.register("qa", { question: "问题" });
  assert.deepEqual(await h.qa.ask(qaTask, OTHER), { ok: false, code: "TASK_NOT_FOUND" });
  assert.deepEqual(await h.qa.ask("missing", VIDEO), { ok: false, code: "TASK_NOT_FOUND" });
  assert.equal(h.reads().ensure, 0);
  assert.equal(h.fake.count(), 0);
});

test("没有字幕时照实报取字幕的错，不发模型请求", async () => {
  const h = studyHarness({ transcripts: { [VIDEO]: "NEED_LOGIN" }, ai: { replies: { qa: JSON.stringify({ answer: "x" }) } } });
  assert.deepEqual(await h.ask("问题").result, { ok: false, code: "NEED_LOGIN" });
  const empty = studyHarness({ transcripts: { [VIDEO]: [] }, ai: { replies: { qa: JSON.stringify({ answer: "x" }) } } });
  assert.deepEqual(await empty.ask("问题").result, { ok: false, code: "NO_TRANSCRIPT" });
  assert.equal(h.fake.count() + empty.fake.count(), 0);
});

test("字幕太长、问题又没有内容词时只送每块开头一句：引用只认这几句的时间点，送进去以外的时间点不算依据", async () => {
  const long = (index: number) => `第${index + 1}分钟这一段讲的是普通的田间管理，`.repeat(25);
  const cues = Array.from({ length: 30 }, (_, index) => cue(index * 60, long(index), 60));
  const fabricated = studyHarness({ transcripts: { [VIDEO]: cues }, ai: { replies: { qa: JSON.stringify({ answer: "开头讲的是种番茄 [0:10]" }) } } });
  const made = answerOf(await fabricated.ask("总结一下").result);
  assert.equal(made.answer, FALLBACK_ANSWER, "模型没看到第 10 秒那句，不能拿它当依据");
  assert.deepEqual(made.citations, []);

  const grounded = studyHarness({ transcripts: { [VIDEO]: cues }, ai: { replies: { qa: JSON.stringify({ answer: "开头讲田间管理 [0:00]" }) } } });
  const kept = answerOf(await grounded.ask("总结一下").result);
  assert.equal(kept.answer, "开头讲田间管理 [0:00]");
  assert.deepEqual(kept.clickable, [0]);
});

test("只挑了部分块时：紧挨着没送进去的块，它起点那一秒的引用不算依据，也不能点；送进去的最后一句照常认", async () => {
  // 每条字幕 1900 字、三条一块；只有第 14 条讲嫁接，检索挑中它所在的块和前一块，后一块超出预算没送。
  const filler = (index: number) => `第${index + 1}条：${"田间管理要点。".repeat(280)}`.slice(0, 1900);
  const cues = Array.from({ length: 30 }, (_, index) => cue(index * 60, index === 13 ? `嫁接先削口。${filler(index)}`.slice(0, 1900) : filler(index), 60));
  const ask = async (answer: string) => {
    const h = studyHarness({ transcripts: { [VIDEO]: cues }, info: { durationSec: 1800 }, ai: { replies: { qa: JSON.stringify({ answer }) } } });
    const result = await h.ask("嫁接怎么做？").result;
    assert.ok(result.ok && result.value.retrievalMode === "selected", JSON.stringify(result.ok && result.value.retrievalMode));
    assert.match(userMessage(h.fake.calls[0]!.request), /\[14:00\]/);
    assert.doesNotMatch(userMessage(h.fake.calls[0]!.request), /\[15:00\]/, "后一块没送进去");
    return answerOf(result);
  };

  const outside = await ask("后面还讲了别的 [15:00]");
  assert.equal(outside.answer, FALLBACK_ANSWER, "第 15 分钟那句模型没看到，不能拿它当依据");
  assert.deepEqual(outside.citations, []);

  const mixed = await ask("先削口 [14:59]，后面还讲了别的 [15:00]");
  assert.deepEqual(mixed.citations.map((citation) => citation.startSeconds), [899]);
  assert.match(mixed.citations[0]?.quote ?? "", /^第15条/, "第 14 分 59 秒对到送进去的最后一句");
  assert.deepEqual(mixed.clickable, [899], "没送进去的那一秒不能点");
});
