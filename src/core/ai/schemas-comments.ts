// 带评论区的结论（prompts/skim/verdict-comments.md）的输出格式：只在构建开关 FEATURE_COMMENTS 打开时进包，只从开关分支引用。
// 顶层只放字面量：前几项和一句话结论一样，多一个 comments 对象；标签和章节标记的种类限定在本机认得的几种里。
import type { ResponseSchema } from "./schemas.ts";
import { VERDICT_STARS } from "./verdict.ts";

const text = { type: "string" } as const;

export const VERDICT_WITH_COMMENTS: ResponseSchema = {
  type: "json_schema",
  name: "verdict_comments",
  schema: {
    type: "object",
    properties: {
      summary: text,
      value: text,
      reason: text,
      verdict: { anyOf: [{ type: "integer", enum: VERDICT_STARS }, { type: "string", enum: ["信息不足"] }] },
      keyChapters: { type: "array", items: text },
      translatedTitle: text,
      comments: {
        type: "object",
        properties: {
          tag: { type: "string", enum: ["好评居多", "有争议", "有人指出错误", "说是标题党", "评论还少"] },
          line: text,
          points: {
            type: "array",
            items: { type: "object", properties: { text, refs: { type: "array", items: { type: "integer" } } }, required: ["text", "refs"], additionalProperties: false },
          },
          marks: {
            type: "array",
            items: { type: "object", properties: { at: text, kind: { type: "string", enum: ["有误", "可跳过", "精彩"] } }, required: ["at", "kind"], additionalProperties: false },
          },
        },
        required: ["tag", "line", "points", "marks"],
        additionalProperties: false,
      },
    },
    required: ["summary", "value", "reason", "verdict", "keyChapters", "translatedTitle", "comments"],
    additionalProperties: false,
  },
};
