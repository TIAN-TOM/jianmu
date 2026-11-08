import assert from "node:assert/strict";
import { test } from "node:test";
import * as SCHEMAS from "../../../../src/core/ai/schemas.ts";
import type { ResponseSchema, SchemaNode } from "../../../../src/core/ai/schemas.ts";
import { VERDICT_LABELS } from "../../../../src/core/ai/verdict.ts";

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
      return Number.isInteger(value);
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

test("一句话结论的档位就是界面认得的那几档", () => {
  assert.deepEqual(SCHEMAS.VERDICT.schema.properties.verdict.enum, [...VERDICT_LABELS]);
});

// 下面的样例照抄 prompts/*.md 「输出格式」里的示例：schema 和提示词要的是同一个形状。
test("各提示词的示例输出都符合对应的 schema", () => {
  const samples: readonly (readonly [ResponseSchema, unknown])[] = [
    [
      SCHEMAS.ANALYSIS_CHUNK,
      {
        chapters: [{ title: "章节标题", timestamp: "0:00", timestampSeconds: 0, summary: "这一段讲了什么" }],
        keyQuotes: [{ quote: "整理后的原话", timestamp: "2:30", timestampSeconds: 150 }],
      },
    ],
    [
      SCHEMAS.VERDICT,
      { summary: "这个视频主要讲了什么", value: "核心价值", verdict: "看概览就够", reason: "判断理由" },
    ],
    [SCHEMAS.SEGMENT_BATCH, { segments: [{ id: "s12", text: "修复后的文字。" }] }],
    [SCHEMAS.QA_ANSWER, { answer: "…[0:32]…" }],
    [SCHEMAS.NOTE_QUOTE, { quote: "整理后的文字。" }],
  ];
  for (const [descriptor, sample] of samples) {
    assert.ok(conforms(descriptor.schema, sample), descriptor.name);
  }
});

test("schema 拒绝提示词之外的形状：缺字段、多字段、自创档位", () => {
  assert.equal(conforms(SCHEMAS.NOTE_QUOTE.schema, {}), false);
  assert.equal(conforms(SCHEMAS.QA_ANSWER.schema, { answer: "a", citations: [] }), false);
  assert.equal(
    conforms(SCHEMAS.VERDICT.schema, { summary: "s", value: "v", verdict: "还行", reason: "r" }),
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
  const seconds = { type: "integer" };
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
                properties: { title: text, timestamp: text, timestampSeconds: seconds, summary: text },
                required: ["title", "timestamp", "timestampSeconds", "summary"],
                additionalProperties: false,
              },
            },
            keyQuotes: {
              type: "array",
              items: {
                type: "object",
                properties: { quote: text, timestamp: text, timestampSeconds: seconds },
                required: ["quote", "timestamp", "timestampSeconds"],
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
            verdict: { type: "string", enum: ["值得看完整视频", "看概览就够", "可以跳过", "信息不足"] },
            reason: text,
          },
          required: ["summary", "value", "verdict", "reason"],
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
