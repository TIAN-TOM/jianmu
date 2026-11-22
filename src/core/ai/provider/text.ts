// 协议层给用户看的说明：地址校验、重定向、工作区密钥、空响应的诊断。中文那份定形状，英文那份少一条、多一条或签名不一样，类型检查就报错。
// 错误照旧用中文说明（message），英文挂在不可枚举的 messageEn 上，到要显示的地方按语言挑：错误和诊断会按可枚举字段编码进黄金样本和存储，
// 加英文不该改变它们。模块顶层只放字面量和函数。
import type { OutputLang } from "../../output-lang.ts";

const PROVIDER_ZH = {
  baseUrlMissing: "请填写 API 地址。",
  baseUrlNotUrl: "API 地址不是合法的 URL。",
  baseUrlNotHttps: "API 地址要以 https:// 开头。只有本机地址（localhost、127.0.0.1）可以用 http://。",
  baseUrlIpv6: "Chrome 的权限系统不支持 IPv6 字面量地址，请改用域名。",
  baseUrlBad: "API 地址不合法，请到设置页检查。",
  redirected: (baseUrl: string) =>
    `${baseUrl} 把请求重定向到了别的地址。为了不把 API 密钥带过去，扩展不跟随重定向。请在设置页把 API 地址改成服务实际使用的地址。`,
  workspaceRequired:
    "这把 Anthropic 密钥没有限定工作区，每个请求都要另带工作区 ID，本扩展不支持。"
    + "请在 Claude Console 新建一把密钥，创建时选定一个工作区（例如 Default），再填到设置页。",
  statusOnly: (status: number) => `服务返回 ${status}`,
  streamError: "服务在返回途中报了错。",
  reasoningOnlyLocked: "模型只输出了思考过程，没有正文。这个型号的思考关不掉，可以重试一次，或者在设置页「按功能选模型」里给这项功能另选一个型号。",
  reasoningOnly: "模型只输出了思考过程，没有正文。建议在设置页换一个非推理模型。",
  anthropicGotOpenAi: "响应看起来是 OpenAI 格式，但当前选的是 Anthropic 协议。请到设置页把「API 协议」改成 OpenAI 兼容。",
  openAiGotAnthropic: "响应看起来是 Anthropic 格式，但当前选的是 OpenAI 兼容协议。请到设置页把「API 协议」改成 Anthropic。",
  noChoices: "响应里没有 choices 字段，这个地址可能不是 OpenAI 兼容接口。请到设置页核对 API 地址与协议。",
  thinkingTruncatedLocked:
    "模型还没输出正文就到了 token 上限，思考占满了额度。已经放大预算重试过，仍然不够。这个型号的思考关不掉，扩展已经替你放大过预算。可以在设置页「按功能选模型」里给这项功能另选一个型号；生成概览时，也可以把「概览分块」改成「较短」。",
  thinkingTruncated: "模型还没输出正文就到了 token 上限，多半是思考占满了额度。已经放大预算重试过，仍然不够，建议换一个非推理模型。",
  truncated: "输出被 token 上限截断了，放大预算重试后仍然不够。可以换一个输出更简洁的模型试试。",
  quotaOnThinkingLocked:
    "模型把 token 配额全用在思考上了，没能输出正文。已经放大预算重试过，仍然不够。这个型号的思考关不掉，扩展已经替你放大过预算。可以在设置页「按功能选模型」里给这项功能另选一个型号；生成概览时，也可以把「概览分块」改成「较短」。",
  quotaOnThinking: "模型把 token 配额全用在思考上了，没能输出正文。已经放大预算重试过，仍然不够，建议换一个非推理模型。",
  empty: "模型返回了空内容，请重试。",
  notResponses: "响应不是 Responses 格式，这个地址可能只支持 Chat Completions 或 Anthropic。请到设置页核对「API 协议」。",
  noOutput: "响应里没有 output 字段，这个地址可能不支持 Responses 接口。请到设置页核对 API 地址与协议。",
  quotaOnReasoning: "模型把 token 配额全用在推理上了，没能输出正文。已经放大预算重试过，仍然不够，可以换一个推理更少的型号。",
  contentFiltered: "输出被服务方的内容过滤拦下了，没有正文。",
  generationFailed: "模型生成失败，请重试。",
  reasoningOnlyResponses: "模型只做了推理，没有输出正文。可以换一个推理更少的型号再试。",
};

export type ProviderText = typeof PROVIDER_ZH;

const PROVIDER_EN: ProviderText = {
  baseUrlMissing: "Enter an API address.",
  baseUrlNotUrl: "The API address isn't a valid URL.",
  baseUrlNotHttps: "The API address must start with https://. Only local addresses (localhost, 127.0.0.1) can use http://.",
  baseUrlIpv6: "Chrome's permission system doesn't support IPv6 address literals. Use a domain name instead.",
  baseUrlBad: "The API address isn't valid. Check it in settings.",
  redirected: (baseUrl) =>
    `${baseUrl} redirected the request to another address. Jianmu doesn't follow redirects, so your API key isn't passed on. In settings, change the API address to the one the service actually uses.`,
  workspaceRequired:
    "This Anthropic key isn't limited to a workspace, so every request would need a workspace ID, which Jianmu doesn't support. "
    + "Create a new key in the Claude Console, choose a workspace when you create it (for example Default), then enter it in settings.",
  statusOnly: (status) => `The service returned ${status}`,
  streamError: "The service reported an error partway through its reply.",
  reasoningOnlyLocked: "The model only wrote out its thinking, with no reply. This model's thinking can't be turned off. Try again, or choose a different model for this feature under “Models per feature” in settings.",
  reasoningOnly: "The model only wrote out its thinking, with no reply. Try choosing a non-reasoning model in settings.",
  anthropicGotOpenAi: "The response looks like OpenAI format, but the Anthropic protocol is selected. In settings, change “API protocol” to OpenAI compatible.",
  openAiGotAnthropic: "The response looks like Anthropic format, but the OpenAI compatible protocol is selected. In settings, change “API protocol” to Anthropic.",
  noChoices: "The response has no choices field, so this address may not be an OpenAI compatible endpoint. Check the API address and protocol in settings.",
  thinkingTruncatedLocked:
    "The model reached its token limit before writing a reply because thinking used it all up. Jianmu already retried with a bigger budget, and it still wasn't enough. This model's thinking can't be turned off. Choose a different model for this feature under “Models per feature” in settings. For overviews, you can also set “Overview chunk size” to “Shorter”.",
  thinkingTruncated: "The model reached its token limit before writing a reply, most likely because thinking used it all up. Jianmu already retried with a bigger budget, and it still wasn't enough. Try a non-reasoning model.",
  truncated: "The output was cut off at the token limit, and a retry with a bigger budget still wasn't enough. Try a model that writes more concisely.",
  quotaOnThinkingLocked:
    "The model spent its whole token allowance on thinking and couldn't write a reply. Jianmu already retried with a bigger budget, and it still wasn't enough. This model's thinking can't be turned off. Choose a different model for this feature under “Models per feature” in settings. For overviews, you can also set “Overview chunk size” to “Shorter”.",
  quotaOnThinking: "The model spent its whole token allowance on thinking and couldn't write a reply. Jianmu already retried with a bigger budget, and it still wasn't enough. Try a non-reasoning model.",
  empty: "The model returned nothing. Try again.",
  notResponses: "The response isn't in Responses format. This address may only support Chat Completions or Anthropic. Check “API protocol” in settings.",
  noOutput: "The response has no output field, so this address may not support the Responses API. Check the API address and protocol in settings.",
  quotaOnReasoning: "The model spent its whole token allowance on reasoning and couldn't write a reply. Jianmu already retried with a bigger budget, and it still wasn't enough. Try a model that reasons less.",
  contentFiltered: "The service's content filter blocked the output, so there's no reply.",
  generationFailed: "The model couldn't generate a reply. Try again.",
  reasoningOnlyResponses: "The model only reasoned and didn't write a reply. Try a model that reasons less.",
};

/** 指定语言那份说明。不传语言时是中文。 */
export const providerText = (lang: OutputLang = "zh"): ProviderText => (lang === "en" ? PROVIDER_EN : PROVIDER_ZH);

/** 一句说明的两种语言：pick 从说明表里挑出同一句。 */
export function bothLangs(pick: (text: ProviderText) => string): { readonly message: string; readonly messageEn: string } {
  return { message: pick(PROVIDER_ZH), messageEn: pick(PROVIDER_EN) };
}

/** 带英文说明的对象：错误和空响应的诊断。 */
export interface WithEnglish {
  readonly message?: string | undefined;
  readonly messageEn?: string | undefined;
}

/** 挂上英文说明，不可枚举，见文件开头。返回同一个对象。 */
export function withEnglish<T extends object>(target: T, messageEn: string): T {
  Object.defineProperty(target, "messageEn", { value: messageEn, enumerable: false, writable: true, configurable: true });
  return target;
}

// 遮掉密钥留下的占位字：密钥本身（按这次发出的密钥遮）和像密钥的片段（服务原话里按形状遮）。
// 错误的可枚举字段里一律是中文，按英文显示时换成英文。
export const HIDDEN_SECRET = "[已隐藏的密钥]";
export const HIDDEN_WORDS = "[已隐藏]";

/** 把文字里的占位字换成指定语言的说法。不传语言时是中文，原样返回。 */
export function hiddenIn(text: string, lang: OutputLang = "zh"): string {
  if (lang !== "en") return text;
  return text.split(HIDDEN_SECRET).join("[key hidden]").split(HIDDEN_WORDS).join("[hidden]");
}

const STATUS_ONLY = /^服务返回 (\d+)$/;

/**
 * 按语言挑说明：要英文、又挂着英文的用英文；没挂的（服务自己的原话）照原样。
 * 协议层只写了状态码、或者流里报错没带原话时用的那两句中文认得出，也换成英文；遮掉密钥的占位字也换成英文。不传语言时是中文。
 */
export function messageIn(source: WithEnglish | null | undefined, lang: OutputLang = "zh"): string {
  const message = String(source?.message ?? "");
  if (lang !== "en") return message;
  if (source?.messageEn) return hiddenIn(source.messageEn, lang);
  const status = STATUS_ONLY.exec(message.trim());
  if (status) return PROVIDER_EN.statusOnly(Number(status[1]));
  return message === PROVIDER_ZH.streamError ? PROVIDER_EN.streamError : hiddenIn(message, lang);
}
