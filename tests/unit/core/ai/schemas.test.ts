import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import * as SCHEMAS from "../../../../src/core/ai/schemas.ts";
import type { ResponseSchema, SchemaNode } from "../../../../src/core/ai/schemas.ts";
import { VERDICT_WITH_COMMENTS } from "../../../../src/core/ai/schemas-comments.ts";

// 两家结构化输出都不接受的关键字。Anthropic 不支持数值和字符串约束、
// 除 0 和 1 以外的 minItems；OpenAI 不支持组合关键字，根节点也不能用 anyOf。
const UNPORTABLE_KEYWORDS = [
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "maxItems",
  "allOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "dependentRequired",
  "dependentSchemas",
];

function assertPortable(node: SchemaNode, where: string): void {
  for (const keyword of UNPORTABLE_KEYWORDS) {
    assert.equal(keyword in node, false, `${where} 用了 ${keyword}`);
  }
  if ("minItems" in node) {
    assert.ok(node.minItems === 0 || node.minItems === 1, `${where} 的 minItems 只能是 0 或 1`);
  }
  if ("anyOf" in node) {
    for (const branch of node.anyOf) assertPortable(branch, where);
    return;
  }
  if (node.type === "object") {
    assert.equal(node.additionalProperties, false, `${where} 要写 additionalProperties: false`);
    assert.deepEqual(
      [...node.required].sort(),
      Object.keys(node.properties).sort(),
      `${where} 的字段要全部列进 required`,
    );
    for (const [key, child] of Object.entries(node.properties)) {
      assertPortable(child, `${where}.${key}`);
    }
  }
  if (node.type === "array") assertPortable(node.items, `${where}[]`);
}

// 按 schema 检查一份模型输出：字段齐全、没有多余字段、类型和枚举对得上。
function conforms(schema: SchemaNode, value: unknown): boolean {
  if ("anyOf" in schema) return schema.anyOf.some((branch) => conforms(branch, value));
  switch (schema.type) {
    case "object":
      return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        Object.keys(value).every((key) => key in schema.properties) &&
        schema.required.every((key) => key in value) &&
        Object.entries(value).every(([key, child]) => {
          const node = schema.properties[key];
          return node !== undefined && conforms(node, child);
        })
      );
    case "array":
      return Array.isArray(value) && value.every((item) => conforms(schema.items, item));
    case "string":
      return typeof value === "string" && (!schema.enum || schema.enum.includes(value));
    case "integer":
      return typeof value === "number" && Number.isInteger(value) && (!schema.enum || schema.enum.includes(value));
    default:
      return false;
  }
}

const ALL: readonly [string, ResponseSchema][] = Object.entries(SCHEMAS);

test("每份 schema 都同时满足 Claude 和 OpenAI 结构化输出的限制", () => {
  assert.equal(ALL.length, 5);
  for (const [key, descriptor] of ALL) {
    assert.equal(descriptor.type, "json_schema", key);
    assert.match(descriptor.name, /^[a-zA-Z0-9_-]{1,64}$/, `${key} 的 name 不合 OpenAI 的格式`);
    assert.equal(descriptor.schema.type, "object", `${key} 的根节点必须是对象`);
    assert.equal("anyOf" in descriptor.schema, false, `${key} 的根节点不能用 anyOf`);
    assertPortable(descriptor.schema, key);
  }
});

test("schema 描述对象整棵冻结，请求层顺手改了也影响不到别的功能", () => {
  for (const [key, descriptor] of ALL) {
    assert.ok(Object.isFrozen(descriptor), key);
    assert.ok(Object.isFrozen(descriptor.schema.properties), key);
  }
  assert.throws(() => {
    (SCHEMAS.VERDICT.schema.required as string[]).push("extra");
  });
});

test("普通结论和带评论的结论都只接受一到五的整数或「信息不足」", () => {
  for (const descriptor of [SCHEMAS.VERDICT, VERDICT_WITH_COMMENTS]) {
    const rating = descriptor.schema.properties.verdict;
    assert.ok(rating);
    assertPortable(rating, descriptor.name);
    for (const valid of [1, 2, 3, 4, 5, "信息不足"]) assert.ok(conforms(rating, valid), String(valid));
    for (const invalid of [0, 6, 3.5, "3", "推荐看", null]) assert.equal(conforms(rating, invalid), false, String(invalid));
  }
});

// 下面的样例照抄 prompts/*.md 「输出格式」里的示例：schema 和提示词要的是同一个形状。
// 示例直接从提示词里取：每份要 JSON 的提示词都写着一行以 JSON 对象结尾的示例输出，它得符合要的那份 schema。
test("各提示词的示例输出都符合对应的 schema", () => {
  const samples: readonly (readonly [string, ResponseSchema])[] = [
    ["skim/chapters.md", SCHEMAS.ANALYSIS_CHUNK],
    ["skim/verdict.md", SCHEMAS.VERDICT],
    ["skim/verdict-comments.md", VERDICT_WITH_COMMENTS],
    ["study/translation.md", SCHEMAS.SEGMENT_BATCH],
    ["common/qa.md", SCHEMAS.QA_ANSWER],
    ["study/note-polish.md", SCHEMAS.NOTE_QUOTE],
  ];
  for (const [file, descriptor] of samples) {
    const markdown = readFileSync(new URL(`../../../../prompts/${file}`, import.meta.url), "utf8");
    const example = /\{"[^\n]*\}$/m.exec(markdown.slice(markdown.indexOf("## 系统提示词")))?.[0];
    assert.ok(example, `${file} 没有示例输出`);
    assert.ok(conforms(descriptor.schema, JSON.parse(example)), `${file} 的示例不符合 ${descriptor.name}`);
  }
});

test("schema 拒绝提示词之外的形状：缺字段、多字段、自创档位", () => {
  assert.equal(conforms(SCHEMAS.NOTE_QUOTE.schema, {}), false);
  assert.equal(conforms(SCHEMAS.QA_ANSWER.schema, { answer: "a", citations: [] }), false);
  assert.equal(
    conforms(SCHEMAS.VERDICT.schema, { summary: "s", value: "v", verdict: "还行", reason: "r", keyChapters: [], translatedTitle: "" }),
    false,
  );
  assert.equal(
    conforms(SCHEMAS.ANALYSIS_CHUNK.schema, {
      chapters: [{ title: "t", timestamp: "0:01", timestampSeconds: 1.5, summary: "s" }],
      keyQuotes: [],
    }),
    false,
    "秒数要求整数",
  );
});

// 名字和字段顺序原样进请求：结构化输出按字段顺序生成，先写摘要再下判断；名字出现在 OpenAI 的请求里。
// 只比 deepEqual 拦不住换顺序，这里比序列化后的文字。
test("五份输出结构的名字、字段和顺序逐字节固定", () => {
  const text = { type: "string" };
  const expected: readonly (readonly [ResponseSchema, unknown])[] = [
    [
      SCHEMAS.ANALYSIS_CHUNK,
      {
        type: "json_schema",
        name: "analysis_chunk",
        schema: {
          type: "object",
          properties: {
            chapters: {
              type: "array",
              items: {
                type: "object",
                properties: { start: text, title: text, summary: text },
                required: ["start", "title", "summary"],
                additionalProperties: false,
              },
            },
            keyQuotes: {
              type: "array",
              items: {
                type: "object",
                properties: { start: text, quote: text },
                required: ["start", "quote"],
                additionalProperties: false,
              },
            },
          },
          required: ["chapters", "keyQuotes"],
          additionalProperties: false,
        },
      },
    ],
    [
      SCHEMAS.VERDICT,
      {
        type: "json_schema",
        name: "verdict",
        schema: {
          type: "object",
          properties: {
            summary: text,
            value: text,
            reason: text,
            verdict: { anyOf: [{ type: "integer", enum: [5, 4, 3, 2, 1] }, { type: "string", enum: ["信息不足"] }] },
            keyChapters: { type: "array", items: text },
            translatedTitle: text,
          },
          required: ["summary", "value", "reason", "verdict", "keyChapters", "translatedTitle"],
          additionalProperties: false,
        },
      },
    ],
    [
      SCHEMAS.SEGMENT_BATCH,
      {
        type: "json_schema",
        name: "segment_batch",
        schema: {
          type: "object",
          properties: {
            segments: {
              type: "array",
              items: {
                type: "object",
                properties: { id: text, text },
                required: ["id", "text"],
                additionalProperties: false,
              },
            },
          },
          required: ["segments"],
          additionalProperties: false,
        },
      },
    ],
    [
      SCHEMAS.QA_ANSWER,
      {
        type: "json_schema",
        name: "qa_answer",
        schema: { type: "object", properties: { answer: text }, required: ["answer"], additionalProperties: false },
      },
    ],
    [
      SCHEMAS.NOTE_QUOTE,
      {
        type: "json_schema",
        name: "note_quote",
        schema: { type: "object", properties: { quote: text }, required: ["quote"], additionalProperties: false },
      },
    ],
  ];
  assert.equal(expected.length, ALL.length);
  for (const [descriptor, shape] of expected) {
    assert.equal(JSON.stringify(descriptor), JSON.stringify(shape), descriptor.name);
  }
});
