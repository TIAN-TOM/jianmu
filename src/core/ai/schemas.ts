/**
 * 各功能要求模型输出的 JSON 结构，两家的结构化输出共用这一份。
 * 调用方把这里的描述对象当 responseFormat 传给 requestAiCompletion，
 * 协议层按协议和型号决定怎么发：支持结构化输出就发 schema，
 * 不支持就退回 json_object 加提示词。解析一律仍走 parseLooseJson 兜底。
 *
 * schema 只用两家都接受的写法：
 * - 每个对象都写 additionalProperties: false，所有字段都列进 required（OpenAI 要求）；
 * - 不用 minLength、maxLength、minimum、maximum 这类约束（Anthropic 不支持）；
 * - 根节点是对象，不用 anyOf、allOf。
 * 字数、条数、时间范围由提示词约束，再由校验函数兜底。
 */
import { VERDICT_LABELS } from "./verdict.ts";

export interface StringSchema {
  readonly type: "string";
  readonly enum?: readonly string[];
}

export interface IntegerSchema {
  readonly type: "integer";
}

export interface ArraySchema {
  readonly type: "array";
  readonly items: SchemaNode;
}

export type SchemaProperties = Readonly<Record<string, SchemaNode>>;

export interface ObjectSchema<P extends SchemaProperties = SchemaProperties> {
  readonly type: "object";
  readonly properties: P;
  readonly required: readonly string[];
  readonly additionalProperties: false;
}

export type SchemaNode = StringSchema | IntegerSchema | ArraySchema | ObjectSchema;

export interface ResponseSchema<P extends SchemaProperties = SchemaProperties> {
  readonly type: "json_schema";
  readonly name: string;
  readonly schema: ObjectSchema<P>;
}

const string: StringSchema = Object.freeze({ type: "string" });

// 冻结整棵树：描述对象是全局共享的，被哪个请求顺手改了会影响其他功能。
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function object<P extends SchemaProperties>(properties: P): ObjectSchema<P> {
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

// name 会出现在 OpenAI 的请求里，只能用字母、数字、下划线和连字符。
function describe<P extends SchemaProperties>(name: string, schema: ObjectSchema<P>): ResponseSchema<P> {
  return deepFreeze({ type: "json_schema", name, schema });
}

// 概览分块：prompts/analysis.md 的输出格式。
export const ANALYSIS_CHUNK = describe(
  "analysis_chunk",
  object({
    chapters: {
      type: "array",
      items: object({
        title: string,
        timestamp: string,
        timestampSeconds: { type: "integer" },
        summary: string,
      }),
    },
    keyQuotes: {
      type: "array",
      items: object({
        quote: string,
        timestamp: string,
        timestampSeconds: { type: "integer" },
      }),
    },
  }),
);

// 一句话结论：判断档位限定在界面认得的几档里。
export const VERDICT = describe(
  "verdict",
  object({
    summary: string,
    value: string,
    verdict: { type: "string", enum: [...VERDICT_LABELS] },
    reason: string,
  }),
);

// 翻译批次：按 id 原样返回每一条。
export const SEGMENT_BATCH = describe(
  "segment_batch",
  object({
    segments: {
      type: "array",
      items: object({ id: string, text: string }),
    },
  }),
);

// 视频问答：只要回答正文，引用由本地从字幕里提取。
export const QA_ANSWER = describe("qa_answer", object({ answer: string }));

// 笔记润色：一段笔记正文。
export const NOTE_QUOTE = describe("note_quote", object({ quote: string }));
