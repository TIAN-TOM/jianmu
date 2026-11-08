// 消息部件：用户消息可以写成文字和图片的部件数组，发出前按协议换成各自的内容写法。
// 纯文本仍写字符串，原样透传；认不出的内容也原样透传，不替调用方改写。
import { PROTOCOLS, type Protocol } from "./endpoint.ts";
import type { ChatMessage } from "./types.ts";

/** cache 只在 Anthropic 写成缓存标记，其余协议忽略。图片只收 JPEG 的 data URL。 */
export type MessagePart =
  | { readonly type: "text"; readonly text: string; readonly cache?: true }
  | { readonly type: "image"; readonly dataUrl: string };

export type MessageContent = string | readonly MessagePart[];

const JPEG_PREFIX = "data:image/jpeg;base64,";
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const TEXT_KEYS: ReadonlySet<string> = new Set(["type", "text", "cache"]);
const IMAGE_KEYS: ReadonlySet<string> = new Set(["type", "dataUrl"]);

const onlyKeys = (value: object, allowed: ReadonlySet<string>): boolean => Object.keys(value).every((key) => allowed.has(key));

function isPart(value: unknown): value is MessagePart {
  if (!value || typeof value !== "object") return false;
  const part = value as { type?: unknown; text?: unknown; cache?: unknown; dataUrl?: unknown };
  if (part.type === "text") {
    return typeof part.text === "string" && (part.cache === undefined || part.cache === true) && onlyKeys(part, TEXT_KEYS);
  }
  return part.type === "image" && typeof part.dataUrl === "string" && onlyKeys(part, IMAGE_KEYS);
}

/** 非空数组、每一项都是部件才算；协议自己的内容块数组不算，原样透传。 */
export function isMessageParts(content: unknown): content is readonly MessagePart[] {
  return Array.isArray(content) && content.length > 0 && content.every(isPart);
}

// 截帧固定编码成 JPEG，别的格式说明调用方出了错，在发出之前就拦下，不花一次请求。
function jpegData(dataUrl: string): string {
  const data = dataUrl.startsWith(JPEG_PREFIX) ? dataUrl.slice(JPEG_PREFIX.length) : "";
  if (!BASE64.test(data)) throw new Error("图片只收 JPEG 格式的 data URL。");
  return data;
}

function imageBlock(protocol: Protocol, dataUrl: string): unknown {
  const data = jpegData(dataUrl);
  if (protocol === PROTOCOLS.ANTHROPIC) {
    return { type: "image", source: { type: "base64", media_type: "image/jpeg", data } };
  }
  if (protocol === PROTOCOLS.RESPONSES) return { type: "input_image", image_url: dataUrl };
  return { type: "image_url", image_url: { url: dataUrl } };
}

function textBlock(protocol: Protocol, part: Extract<MessagePart, { type: "text" }>): unknown {
  if (protocol === PROTOCOLS.ANTHROPIC) {
    return part.cache
      ? { type: "text", text: part.text, cache_control: { type: "ephemeral" } }
      : { type: "text", text: part.text };
  }
  if (protocol === PROTOCOLS.RESPONSES) return { type: "input_text", text: part.text };
  return { type: "text", text: part.text };
}

/** 一条消息的内容按协议换写法。图片排在文字前面，同类之间保持原来的先后。 */
export function toProtocolContent(protocol: Protocol, content: unknown): unknown {
  if (!isMessageParts(content)) return content;
  const images = content.filter((part) => part.type === "image");
  const texts = content.filter((part) => part.type === "text");
  return [
    ...images.map((part) => imageBlock(protocol, part.dataUrl)),
    ...texts.map((part) => textBlock(protocol, part)),
  ];
}

/** 整组消息换写法。没有一条用部件时原样返回，请求体和以前逐字节一样。 */
export function withProtocolContent(protocol: Protocol, messages: readonly ChatMessage[]): readonly ChatMessage[] {
  if (!messages.some((message) => isMessageParts(message?.content))) return messages;
  return messages.map((message) =>
    isMessageParts(message?.content) ? { ...message, content: toProtocolContent(protocol, message.content) } : message,
  );
}
