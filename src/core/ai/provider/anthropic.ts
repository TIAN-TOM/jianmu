// Anthropic 协议的方言：API 版本、型号识别，以及 thinking、effort、temperature、结构化输出怎么发。
import { PROTOCOLS } from "./endpoint.ts";
import type { AiSettings, ClaudeCapabilities, ClaudeTraits } from "./types.ts";

// Anthropic 的版本号是必填头部。官方地址用 2026-10-21，这个版本对所有型号都
// 拒绝 temperature、top_p、top_k；自定义的 Anthropic 兼容地址不一定认新版本，
// 继续用 2023-06-01。
export const ANTHROPIC_VERSION = "2026-10-21";
export const ANTHROPIC_LEGACY_VERSION = "2023-06-01";

export function isOfficialAnthropic(baseUrl: unknown): boolean {
  try {
    const url = new URL(String(baseUrl));
    return url.protocol === "https:" && url.hostname === "api.anthropic.com";
  } catch {
    return false;
  }
}

// 请求头和放宽记忆的键都从这里取，按地址换版本时两边不会对不上。
export function apiVersionFor(settings: Pick<AiSettings, "protocol" | "aiBaseUrl"> | null | undefined): string {
  if (settings?.protocol !== PROTOCOLS.ANTHROPIC) return "";
  return isOfficialAnthropic(settings.aiBaseUrl)
    ? ANTHROPIC_VERSION
    : ANTHROPIC_LEGACY_VERSION;
}

/**
 * 关掉推理：本扩展的任务都是按规则改写，推理只拉长延迟；
 * 且 Anthropic 的 max_tokens 把思考算进去，放开思考可能在写出正文前烧光预算。
 */
export const THINKING_DISABLED = Object.freeze({ type: "disabled" });
// Sonnet 5.5 拒绝 disabled，这是它最低的一档：不做回答前思考。
export const THINKING_BETWEEN_TOOLS = Object.freeze({ type: "between_tools" });

export interface ClaudeModelInfo {
  readonly family: string;
  readonly major: number;
  readonly minor: number;
}

/**
 * 从模型名里认出 Claude 的系列和版本号。兼容新式（claude-opus-4-6、
 * claude-haiku-4-5-20251001）、旧式（claude-3-7-sonnet-20250219），
 * 以及云平台加了前后缀的写法（anthropic.claude-opus-4-6-v1）。认不出返回 null。
 */
export function parseClaudeModel(model: string | null | undefined): ClaudeModelInfo | null {
  const id = String(model || "").toLowerCase();
  const modern = id.match(
    /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2}))?(?!\d)/,
  );
  if (modern) {
    return {
      family: modern[1] as string,
      major: Number(modern[2]),
      minor: Number(modern[3] || 0),
    };
  }
  const legacy = id.match(/claude-(\d+)(?:-(\d))?-(opus|sonnet|haiku)/);
  if (legacy) {
    return {
      family: legacy[3] as string,
      major: Number(legacy[1]),
      minor: Number(legacy[2] || 0),
    };
  }
  // claude-mythos-preview 这类不带版本号的名字。
  const named = id.match(/claude-(fable|mythos)\b/);
  if (named) return { family: named[1] as string, major: 0, minor: 0 };
  return null;
}

/**
 * 决定 Claude 请求里 thinking、effort、temperature、结构化输出怎么发，
 * 以及单轮输出预算的上限（maxTokens，0 表示不知道）。
 * 有 Models API 读到的能力（capabilities.ts）就按能力来，没有就按型号名判断。
 */
export function claudeRequestTraits(
  model: string | null | undefined,
  { official = false, capabilities = null }: { official?: boolean; capabilities?: ClaudeCapabilities | null | undefined } = {},
): ClaudeTraits {
  const byName = claudeTraitsByName(model, official);
  if (!capabilities) return byName;
  // 能力表里 disabled、between_tools 为 false 时，发了就是 400。
  const types = capabilities.thinking || {};
  return {
    thinking: types.disabled ? "disabled" : types.betweenTools ? "between_tools" : "adaptive",
    // 能力表按从低到高列出支持的档位，取最低的一档；不支持 effort 就不发。
    effort: capabilities.efforts?.[0] || "",
    omitTemperature: byName.omitTemperature,
    structuredOutputs: Boolean(capabilities.structuredOutputs),
    maxTokens: Number(capabilities.maxTokens) > 0 ? Number(capabilities.maxTokens) : 0,
  };
}

/**
 * 按型号名判断，依据官方逐型号对照表：
 * - Opus 5.5、Fable、Mythos 关不掉思考，传 disabled 直接 400；
 * - Sonnet 5.5 也拒绝 disabled，最低档是 between_tools；
 * - 其余型号显式关闭。
 * 关不掉思考的型号用最低档 effort 压住思考的时长和 token。
 * Claude 4.7 及之后的型号在 2023-06-01 版本下拒绝非默认的 temperature；
 * 官方地址用的 2026-10-21 版本对所有型号都拒绝，official 为 true 时一律不发。
 * 结构化输出按官方支持列表：Claude 4.5 及之后，以及 Fable、Mythos。
 * 自定义的兼容地址不一定支持，只对官方地址按型号名开启。
 * 认不出的模型名按能关掉思考发，由传输层在 400 后按报错放宽。
 */
function claudeTraitsByName(model: string | null | undefined, official: boolean): ClaudeTraits {
  const info = parseClaudeModel(model);
  if (!info) {
    return {
      thinking: "disabled",
      effort: "low",
      omitTemperature: official,
      structuredOutputs: false,
      maxTokens: 0,
    };
  }
  const { family, major, minor } = info;
  const atLeast = (a: number, b: number): boolean => major > a || (major === a && minor >= b);
  const alwaysThinks = family === "fable" || family === "mythos";
  let thinking = "disabled";
  if (alwaysThinks || (family === "opus" && atLeast(5, 5))) thinking = "adaptive";
  else if (family === "sonnet" && atLeast(5, 5)) thinking = "between_tools";
  return {
    thinking,
    effort: "low",
    omitTemperature: official || alwaysThinks || atLeast(4, 7),
    structuredOutputs: official && (alwaysThinks || atLeast(4, 5)),
    maxTokens: 0,
  };
}
