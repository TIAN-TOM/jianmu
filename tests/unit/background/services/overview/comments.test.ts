// 生成概览时读评论区（PRD F23）：要读的任务和分块请求同时读，写结论时带上；不要求读的不读；读不到照常生成；补失败块沿用原来那份。
// 评论和模型的回复都是自造的。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommentInput } from "../../../../../src/core/ai/comments.ts";
import { commentStage } from "../../../../../src/background/services/overview/comment-stage.ts";
import type { SiteAccess } from "../../../../../src/background/services/transcript/index.ts";
import { videoKey } from "../../../../../src/core/video-ref.ts";
import type { SiteCtx, SiteResult, SiteService, TopComment, VideoInfo } from "../../../../../src/sites/types.ts";
import { overviewHarness, twoSegments, value, VIDEO, type Ask } from "../../../../helpers/overview-service.ts";

const COMMENTS: readonly CommentInput[] = [
  { text: "前面是背景", likes: 12, pinned: true },
  { text: "后半段讲得清楚", likes: 230, pinned: false },
  { text: "2:30 那里的数字写错了", likes: 88, pinned: false },
];

/** 站点读取的替身：只有读评论这一项，记下问的是哪个视频、经哪个标签页。 */
function reader(answer: readonly CommentInput[] | null) {
  const calls: { video: string; tabId: number | undefined }[] = [];
  const sites: SiteAccess = {
    service: () =>
      ({
        readTopComments: async (info: VideoInfo, ctx: SiteCtx & { readonly tabId?: number }): Promise<SiteResult<TopComment[]>> => {
          calls.push({ video: videoKey(info.ref), tabId: ctx.tabId });
          return answer ? { ok: true, value: [...answer] } : { ok: false, code: "NEED_LOGIN" };
        },
      }) as unknown as SiteService,
    ctx: (_platform, { signal, tabId }) => ({ signal, tabId }) as unknown as SiteCtx,
  };
  return { read: sites, calls };
}

const verdictWithComments = (ask: Ask) =>
  ask.isVerdict
    ? {
        text: JSON.stringify({
          summary: "讲了样例",
          value: "",
          verdict: "可以看",
          reason: "评论区普遍说后半段好",
          keyChapters: [],
          translatedTitle: "",
          comments: { tag: "有人指出错误", line: "多数人说后半段好", points: [{ text: "有评论指出 2:30 的数字写错了", refs: [3] }], marks: [{ at: "2:30", kind: "有误" }] },
        }),
      }
    : undefined;

test("卡片、侧边栏点的生成：读这个标签页的评论，写结论时带上，评论区那一块存进概览", async () => {
  const { read, calls } = reader(COMMENTS);
  const harness = overviewHarness({ segments: twoSegments(), durationSec: 300, sites: read, respond: verdictWithComments });
  const result = value(await harness.generate({ comments: { tabId: 7 } }).result);
  assert.deepEqual(calls, [{ video: VIDEO, tabId: 7 }]);
  const [verdictAsk] = harness.verdictAsks();
  assert.ok(verdictAsk?.user.includes("评论区：[1] 置顶 赞 12：前面是背景"));
  assert.equal(harness.chunkAsks().some((ask) => ask.user.includes("前面是背景")), false, "评论不进分块请求");
  const stored = (await harness.record())?.analysis.verdict as { comments?: unknown } | undefined;
  assert.deepEqual(stored?.comments, {
    tag: "有人指出错误",
    line: "多数人说后半段好",
    points: [{ text: "有评论指出 2:30 的数字写错了", quotes: [COMMENTS[2]] }],
    marks: [{ start: 150, kind: "有误" }],
  });
  assert.ok(result.analysis);
});

test("不要求读评论的生成（本窗口全部生成）：不读评论，结论照旧", async () => {
  const { read, calls } = reader(COMMENTS);
  const harness = overviewHarness({ segments: twoSegments(), durationSec: 300, sites: read });
  value(await harness.generate().result);
  assert.deepEqual(calls, []);
  assert.equal(harness.verdictAsks()[0]?.user.includes("评论区"), false);
});

test("读不到评论：照常生成，结论里没有评论区", async () => {
  const { read } = reader(null);
  const harness = overviewHarness({ segments: twoSegments(), durationSec: 300, sites: read });
  value(await harness.generate({ comments: {} }).result);
  assert.equal(harness.verdictAsks()[0]?.user.includes("评论区"), false);
  const stored = (await harness.record())?.analysis.verdict as { comments?: unknown } | undefined;
  assert.equal(stored?.comments, undefined);
});

test("补失败块重写结论：不再读评论，沿用原来那份，章节标记只留还对得上的", () => {
  const stage = commentStage(undefined);
  const previous = { comments: { tag: "有争议", line: "两派", points: [{ text: "有人说好", quotes: [{ text: "好", likes: 1, pinned: false }] }], marks: [{ start: 150, kind: "有误" }, { start: 999, kind: "精彩" }] } };
  const verdict = { summary: "s", value: "", verdict: "可以看", reason: "r" };
  assert.deepEqual(stage.carry(verdict, previous, [0, 150])?.comments, { ...previous.comments, marks: [{ start: 150, kind: "有误" }] });
  const fresh = { ...verdict, comments: { tag: "好评居多", line: "", points: [], marks: [] } };
  assert.equal(stage.carry(fresh, previous, [0, 150]), fresh, "这次新读到的优先");
  assert.equal(stage.carry(verdict, undefined, [0]), verdict);
});
