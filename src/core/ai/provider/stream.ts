// 强制流式的拼回：有的网关不管请求怎么写都回事件流。这里把三种协议的事件流拼成各自的普通响应，
// 之后照原样解析正文、判断截断和拒答。流中途的错误事件拼成服务方报错，交给原有的限流和忙碌重发。
// 首发不主动请求流式，这里只认、只拼。
import { PROTOCOLS, type Protocol } from "./endpoint.ts";

export type StreamAssembly =
  // complete 为 false：流没有正常收尾（连接断了），data 只是收到的那部分；data 为 null 表示一个事件也没认出来。
  | { readonly ok: true; readonly data: Record<string, unknown> | null; readonly complete: boolean }
  // 流中途的错误事件。status 是按错误类型对应的状态码，message 是服务给的原话，脱敏由调用方做。
  | {
      readonly ok: false;
      readonly status: number;
      readonly message: string;
      readonly type?: string;
      readonly code?: string;
      readonly param?: string;
    };

type Payload = Record<string, unknown>;

const SSE_FIELD = /^(?:(?:data|event|id|retry)[ \t]*:|:)/;
const EVENT_STREAM_TYPE = /\btext\/event-stream\b/i;
const STREAM_ERROR_MESSAGE = "服务在返回途中报了错。";

/** 按响应类型或正文开头认事件流。正文是 JSON 就按 JSON，哪怕响应类型写的是事件流。 */
export function looksLikeEventStream(contentType: string | null | undefined, head: string): boolean {
  const start = String(head ?? "").replace(/^﻿/, "").trimStart();
  if (start.startsWith("{") || start.startsWith("[")) return false;
  return SSE_FIELD.test(start) || EVENT_STREAM_TYPE.test(String(contentType ?? ""));
}

const isObject = (value: unknown): value is Payload => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

interface Decoded {
  readonly payloads: readonly Payload[];
  readonly done: boolean; // 收到了 [DONE]
  readonly broken: boolean; // 有事件的数据像 JSON 却解析不了，多半是连接断在了半截
}

// 事件之间空一行；data 可以分几行写，按换行拼回；冒号开头的是注释（保活用），跳过。
function decode(text: string): Decoded {
  const payloads: Payload[] = [];
  let done = false;
  let broken = false;
  let event = "";
  let data: string[] = [];
  const flush = (): void => {
    if (data.length) {
      const raw = data.join("\n").trim();
      if (raw === "[DONE]") done = true;
      else if (raw.startsWith("{")) {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (isObject(parsed)) payloads.push(event && typeof parsed.type !== "string" ? { type: event, ...parsed } : parsed);
        } catch {
          broken = true;
        }
      }
    }
    event = "";
    data = [];
  };
  for (const line of text.replace(/^﻿/, "").split(/\r\n|\r|\n/)) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  // 最后一个事件后面没有空行也收下；断在半截的解析不了，记成 broken。
  flush();
  return { payloads, done, broken };
}

// 错误类型和状态码的对应，只用来决定交给哪条重发逻辑：限流和过载才会自动重发一次。
const ERROR_STATUS: Readonly<Record<string, number>> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529,
};

function statusOf(type: string, code: string): number {
  for (const value of [code, type]) {
    const status = Number(value);
    if (Number.isInteger(status) && status >= 400 && status < 600) return status;
  }
  const known = ERROR_STATUS[type] ?? ERROR_STATUS[code];
  if (known) return known;
  const kind = `${type} ${code}`;
  if (/rate.?limit|too.?many|quota|billing|balance|credit/i.test(kind)) return 429;
  if (/overload|unavailable|busy|capacity/i.test(kind)) return 503;
  if (/timeout|timed.?out/i.test(kind)) return 504;
  if (/auth|api.?key|unauthori[sz]ed/i.test(kind)) return 401;
  if (/invalid|bad.?request|context.?length/i.test(kind)) return 400;
  return 500;
}

const stringOf = (value: unknown): string => (typeof value === "string" || typeof value === "number" ? String(value) : "");

// Responses 以失败收尾时，错误在收尾带的响应里；没写原因也算失败，不把前面的增量当成功的正文交出去。
function responseFailure(payload: Payload): unknown {
  const response = isObject(payload.response) ? payload.response : {};
  return response.error ?? {};
}

// 三种协议的错误事件都认：type 为 error 的事件，Responses 的失败收尾，或带着顶层 error 的数据块。
function failureOf(payload: Payload): StreamAssembly | null {
  const raw =
    payload.type === "error" ? (payload.error ?? payload) : payload.type === "response.failed" ? responseFailure(payload) : payload.error;
  if (raw === undefined || raw === null || raw === false || raw === "") return null;
  const detail: Payload = isObject(raw) ? raw : { message: stringOf(raw) };
  const type = stringOf(detail.type === "error" ? "" : detail.type);
  const code = stringOf(detail.code);
  const param = stringOf(detail.param);
  return {
    ok: false,
    status: statusOf(type, code),
    message: stringOf(detail.message) || type || code || STREAM_ERROR_MESSAGE,
    ...(type ? { type } : {}),
    ...(code ? { code } : {}),
    ...(param ? { param } : {}),
  };
}

interface ChoiceDraft {
  role: string;
  content: string;
  reasoningContent: string;
  reasoning: string;
  refusal: string;
  finishReason: string | null;
}

// Chat Completions：按 choice 的序号把 delta 里的文字逐段拼起来，最后一块常带用量。
function assembleChat(payloads: readonly Payload[], done: boolean): StreamAssembly {
  const drafts = new Map<number, ChoiceDraft>();
  let head: Payload = {};
  let usage: unknown;
  let finished = false;
  for (const payload of payloads) {
    if (!head.id && payload.id) head = { id: payload.id, model: payload.model, created: payload.created };
    if (isObject(payload.usage)) usage = payload.usage;
    for (const choice of Array.isArray(payload.choices) ? payload.choices : []) {
      if (!isObject(choice)) continue;
      const index = Number(choice.index) || 0;
      const draft = drafts.get(index) ?? { role: "", content: "", reasoningContent: "", reasoning: "", refusal: "", finishReason: null };
      drafts.set(index, draft);
      const delta = isObject(choice.delta) ? choice.delta : isObject(choice.message) ? choice.message : {};
      if (typeof delta.role === "string") draft.role = delta.role;
      draft.content += textOf(delta.content);
      draft.reasoningContent += textOf(delta.reasoning_content);
      draft.reasoning += textOf(delta.reasoning);
      draft.refusal += textOf(delta.refusal);
      if (typeof choice.finish_reason === "string" && choice.finish_reason) {
        if (choice.finish_reason === "error") return { ok: false, status: 500, message: STREAM_ERROR_MESSAGE };
        draft.finishReason = choice.finish_reason;
        finished = true;
      }
    }
  }
  const choices = [...drafts.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, draft]) => ({
      index,
      message: {
        role: draft.role || "assistant",
        content: draft.content,
        ...(draft.reasoningContent ? { reasoning_content: draft.reasoningContent } : {}),
        ...(draft.reasoning ? { reasoning: draft.reasoning } : {}),
        ...(draft.refusal ? { refusal: draft.refusal } : {}),
      },
      finish_reason: draft.finishReason,
    }));
  const data = { ...head, object: "chat.completion", choices, ...(usage ? { usage } : {}) };
  return { ok: true, data, complete: done || finished };
}

const BLOCK_FOR_DELTA: Readonly<Record<string, Payload>> = {
  text_delta: { type: "text", text: "" },
  thinking_delta: { type: "thinking", thinking: "" },
};

// Anthropic：message_start 给出消息的骨架，内容块按序号逐段拼，message_delta 补上停止原因和用量。
function assembleAnthropic(payloads: readonly Payload[]): StreamAssembly {
  let message: Payload = {};
  const blocks: Payload[] = [];
  let stopped = false;
  for (const payload of payloads) {
    const index = Number(payload.index) || 0;
    if (payload.type === "message_start" && isObject(payload.message)) {
      message = { ...payload.message };
    } else if (payload.type === "content_block_start" && isObject(payload.content_block)) {
      blocks[index] = { ...payload.content_block };
    } else if (payload.type === "content_block_delta" && isObject(payload.delta)) {
      const delta = payload.delta;
      const block = (blocks[index] ??= { ...(BLOCK_FOR_DELTA[textOf(delta.type)] ?? { type: "unknown" }) });
      if (delta.type === "text_delta") block.text = textOf(block.text) + textOf(delta.text);
      else if (delta.type === "thinking_delta") block.thinking = textOf(block.thinking) + textOf(delta.thinking);
      else if (delta.type === "signature_delta") block.signature = textOf(delta.signature);
    } else if (payload.type === "message_delta") {
      const delta = isObject(payload.delta) ? payload.delta : {};
      for (const key of ["stop_reason", "stop_sequence"]) if (key in delta) message[key] = delta[key];
      if (typeof delta.stop_reason === "string" && delta.stop_reason) stopped = true;
      if (isObject(payload.usage)) message.usage = { ...(isObject(message.usage) ? message.usage : {}), ...payload.usage };
    } else if (payload.type === "message_stop") {
      stopped = true;
    }
  }
  const data = { ...message, content: blocks.filter(Boolean) };
  return { ok: true, data, complete: stopped };
}

const RESPONSE_DONE: ReadonlySet<string> = new Set(["response.completed", "response.incomplete", "response.failed"]);

interface PartDraft {
  text: string;
  refusal: string;
}

// Responses：收尾事件带着完整的响应，直接用它；没有收尾（连接断了）或收尾里没带输出时，按增量拼出消息项。
function assembleResponses(payloads: readonly Payload[]): StreamAssembly {
  let base: Payload = {};
  let final: Payload | null = null;
  const items = new Map<number, Payload>();
  const doneItems = new Set<number>();
  const parts = new Map<number, Map<number, PartDraft>>();
  const partOf = (payload: Payload): PartDraft => {
    const output = Number(payload.output_index) || 0;
    const content = Number(payload.content_index) || 0;
    const byContent = parts.get(output) ?? new Map<number, PartDraft>();
    parts.set(output, byContent);
    const part = byContent.get(content) ?? { text: "", refusal: "" };
    byContent.set(content, part);
    return part;
  };
  for (const payload of payloads) {
    const type = textOf(payload.type);
    if (RESPONSE_DONE.has(type) && isObject(payload.response)) final = { ...payload.response };
    else if ((type === "response.created" || type === "response.in_progress") && isObject(payload.response)) base = { ...payload.response };
    else if (type === "response.output_item.added" && isObject(payload.item)) items.set(Number(payload.output_index) || 0, { ...payload.item });
    else if (type === "response.output_item.done" && isObject(payload.item)) {
      const index = Number(payload.output_index) || 0;
      items.set(index, { ...payload.item });
      doneItems.add(index);
    } else if (type === "response.output_text.delta") partOf(payload).text += textOf(payload.delta);
    else if (type === "response.output_text.done" && typeof payload.text === "string") partOf(payload).text = payload.text;
    else if (type === "response.refusal.delta") partOf(payload).refusal += textOf(payload.delta);
    else if (type === "response.refusal.done" && typeof payload.refusal === "string") partOf(payload).refusal = payload.refusal;
  }
  const indexes = [...new Set([...items.keys(), ...parts.keys()])].sort((a, b) => a - b);
  const output = indexes.map((index) => {
    const item = items.get(index) ?? { type: "message", role: "assistant" };
    if (doneItems.has(index) || item.type !== "message") return item;
    const content = [...(parts.get(index) ?? new Map<number, PartDraft>()).entries()]
      .sort(([a], [b]) => a - b)
      .flatMap(([, part]) => [
        ...(part.text ? [{ type: "output_text", text: part.text }] : []),
        ...(part.refusal ? [{ type: "refusal", refusal: part.refusal }] : []),
      ]);
    return { ...item, content };
  });
  if (final) {
    if (!Array.isArray(final.output) || (!final.output.length && output.length)) final.output = output;
    return { ok: true, data: final, complete: true };
  }
  return { ok: true, data: { ...base, output }, complete: false };
}

/** 把一份完整的事件流拼成该协议的普通响应；中途有错误事件就回服务方报错。 */
export function assembleEventStream(protocol: Protocol, text: string): StreamAssembly {
  const { payloads, done, broken } = decode(String(text ?? ""));
  for (const payload of payloads) {
    const failure = failureOf(payload);
    if (failure) return failure;
  }
  if (!payloads.length) return { ok: true, data: null, complete: false };
  const assembled =
    protocol === PROTOCOLS.ANTHROPIC
      ? assembleAnthropic(payloads)
      : protocol === PROTOCOLS.RESPONSES
        ? assembleResponses(payloads)
        : assembleChat(payloads, done);
  return assembled.ok && broken ? { ...assembled, complete: false } : assembled;
}
