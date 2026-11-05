// OpenAI 和兼容服务的方言：推理模型的判断、Responses 的型号兼容表、厂商私有参数。
import { THINKING_DISABLED } from "./anthropic.ts";

/**
 * OpenAI 自家的推理模型：o 系列（o1、o3、o4-mini）和 GPT-5 及之后的各代
 * （gpt-5.5、gpt-6-astra、gpt-6.1-sol 等）。它们在 Chat Completions 里不接受
 * max_tokens，要用 max_completion_tokens；推理档位不是 none 时也不接受
 * temperature，而我们不传档位，用的是默认档。按代数判断而不是逐个列型号，
 * 以后出了新一代不用再改这里。gpt-4o、gpt-4.1 等仍按标准参数发送。
 */
export function isOpenAiReasoningModel(model: string | null | undefined): boolean {
  const id = String(model || "").toLowerCase();
  if (/^o\d/.test(id)) return true;
  const generation = id.match(/^gpt-(\d+)/);
  return Boolean(generation) && Number(generation?.[1]) >= 5;
}

/**
 * OpenAI 官方型号的兼容表，Responses 协议按它决定推理档位和结构化输出。
 * OpenAI 的模型列表只返回型号名、不返回能力，推理档位的可选值又因型号而异
 * （gpt-6-astra、gpt-6.1-sol 不支持 none），所以按各型号页面列一张小表，
 * 每项取该型号最低的一档：本扩展的任务都是按规则改写，推理只拉长延迟、多花 token。
 * 只认型号名本身和带日期的快照名，-pro、-mini 这类变体的档位不一定一样。
 * 认不出的型号走保守设置：不发 reasoning.effort（用型号默认档），结构化输出退回 JSON 模式。
 */
const SNAPSHOT = "(?:-\\d{4}-\\d{2}-\\d{2})?$";
const OPENAI_MODEL_TABLE = Object.freeze([
  { match: new RegExp(`^gpt-6-astra${SNAPSHOT}`), effort: "low" },
  { match: new RegExp(`^gpt-6\\.1-sol${SNAPSHOT}`), effort: "low" },
  { match: new RegExp(`^gpt-6\\.1-terra${SNAPSHOT}`), effort: "none" },
  { match: new RegExp(`^gpt-6-luna${SNAPSHOT}`), effort: "none" },
  { match: new RegExp(`^gpt-5\\.6(?:-sol)?${SNAPSHOT}`), effort: "none" },
  { match: new RegExp(`^gpt-5\\.5${SNAPSHOT}`), effort: "none" },
]);

export interface OpenAiModelTraits {
  readonly known: boolean;
  readonly effort: string;
  readonly structuredOutputs: boolean;
  readonly reasoning: boolean;
}

export function openAiModelTraits(model: string | null | undefined): OpenAiModelTraits {
  const id = String(model || "").toLowerCase();
  const entry = OPENAI_MODEL_TABLE.find((item) => item.match.test(id));
  return {
    known: Boolean(entry),
    effort: entry?.effort || "",
    structuredOutputs: Boolean(entry),
    reasoning: isOpenAiReasoningModel(id),
  };
}

// thinking 不是 OpenAI 标准参数，发给不认识它的服务可能被拒，
// 只在地址指向 DeepSeek（沿用了 Anthropic 的形状）时才加。
export function vendorExtras(baseUrl: unknown): { thinking?: { readonly type: string } } {
  try {
    // 精确到域名本身或其子域：endsWith 会把 mydeepseek.com 这类形近
    // 域名也放进来，严格网关收到未知参数 thinking 会直接 400。
    const host = new URL(String(baseUrl)).hostname;
    if (host === "deepseek.com" || host.endsWith(".deepseek.com")) {
      return { thinking: THINKING_DISABLED };
    }
  } catch {
    // 地址非法时交给调用方校验，这里不额外加字段。
  }
  return {};
}
