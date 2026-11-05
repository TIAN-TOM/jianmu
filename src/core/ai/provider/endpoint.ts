// 三种协议的名字和对话、模型列表请求的地址。选了具体厂商时协议和地址由预设决定。

// 三种协议：「OpenAI 兼容」即 Chat Completions，是各家兼容服务的事实标准；
// OpenAI 官方另用它自家较新的 Responses 接口，结构化输出和推理档位都在那边；
// Anthropic 是唯一值得单独适配的例外。
export const PROTOCOLS = Object.freeze({
  OPENAI: "openai",
  RESPONSES: "openai-responses",
  ANTHROPIC: "anthropic",
} as const);

export type Protocol = (typeof PROTOCOLS)[keyof typeof PROTOCOLS];

export interface EndpointPreset {
  readonly id: string;
  readonly protocol: Protocol;
  readonly baseUrl: string;
}

// 第一项是默认服务商，认不出的预设都落到它。
const DEFAULT_PRESET: EndpointPreset = {
  id: "anthropic",
  protocol: PROTOCOLS.ANTHROPIC,
  baseUrl: "https://api.anthropic.com",
};
const CUSTOM_PRESET_ID = "custom";

const PRESETS: readonly EndpointPreset[] = Object.freeze([
  DEFAULT_PRESET,
  // 官方走 Responses。想用 Chat Completions 可以选「自定义」填同一个地址。
  { id: "openai", protocol: PROTOCOLS.RESPONSES, baseUrl: "https://api.openai.com/v1" },
  { id: "deepseek", protocol: PROTOCOLS.OPENAI, baseUrl: "https://api.deepseek.com" },
  { id: "gemini", protocol: PROTOCOLS.OPENAI, baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  // 国际版是 api.moonshot.ai，两边的密钥不通用，要用国际版就选「自定义」。
  { id: "moonshot", protocol: PROTOCOLS.OPENAI, baseUrl: "https://api.moonshot.cn/v1" },
  { id: "zhipu", protocol: PROTOCOLS.OPENAI, baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  // 北京地域的通用域名：密钥按地域分开，别的地域建的配不上这个地址。
  // 官方另推按业务空间分配的域名，要用就选「自定义」。
  { id: "dashscope", protocol: PROTOCOLS.OPENAI, baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "siliconflow", protocol: PROTOCOLS.OPENAI, baseUrl: "https://api.siliconflow.cn/v1" },
  { id: "openrouter", protocol: PROTOCOLS.OPENAI, baseUrl: "https://openrouter.ai/api/v1" },
  { id: CUSTOM_PRESET_ID, protocol: PROTOCOLS.OPENAI, baseUrl: "" },
]);

export const presetById = (id: unknown): EndpointPreset | null =>
  PRESETS.find((preset) => preset.id === id) || null;

export type BaseUrlCheck =
  | { readonly ok: true; readonly url: string; readonly origin: string }
  | { readonly ok: false; readonly error: string };

// 密钥会随请求发到这个地址，所以只认 https，本机地址也一样。
export function validateBaseUrl(input: unknown, protocol: Protocol = PROTOCOLS.OPENAI): BaseUrlCheck {
  const text = String(input || "").trim();
  if (!text) return { ok: false, error: "请填写 API 地址。" };

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, error: "API 地址不是合法的 URL。" };
  }

  if (parsed.protocol !== "https:") {
    return {
      ok: false,
      error: "API 地址要以 https:// 开头，本机地址（如本地 Ollama）也不能用 http://。",
    };
  }
  // Chrome 的 match pattern 不支持 IPv6 字面量，这类地址申请不到访问权限。
  if (parsed.hostname.includes(":")) {
    return { ok: false, error: "Chrome 的权限系统不支持 IPv6 字面量地址，请改用域名。" };
  }

  // 用户常常直接把文档里的完整端点粘进来。与其报错，不如把它还原成 base。
  let pathname = parsed.pathname.replace(/\/+$/, "");
  // /responses 只在 Responses 协议下剥：别的协议的地址恰好以它结尾时不该被改。
  const suffixes = ["/chat/completions", "/v1/messages", "/messages"];
  if (protocol === PROTOCOLS.RESPONSES) suffixes.push("/responses");
  for (const suffix of suffixes) {
    if (pathname.endsWith(suffix)) {
      pathname = pathname.slice(0, -suffix.length);
      break;
    }
  }
  // Anthropic 的端点自带 /v1，base 里再留一个会拼成 /v1/v1/messages。
  if (protocol === PROTOCOLS.ANTHROPIC && pathname.endsWith("/v1")) {
    pathname = pathname.slice(0, -3);
  }

  return { ok: true, url: `${parsed.origin}${pathname}`, origin: `${parsed.origin}/` };
}

export interface EndpointSource {
  readonly presetId?: string | undefined;
  readonly protocol?: string | undefined;
  readonly aiBaseUrl?: string | undefined;
}

const isProtocol = (value: unknown): value is Protocol =>
  (Object.values(PROTOCOLS) as readonly unknown[]).includes(value);

/**
 * 这组设置实际要用的协议和地址。选了具体厂商时协议和地址完全由预设说了算：
 * 厂商换域名时跟着升级走，而不是被存储里的旧值钉死。
 * 地址整理不通过就原样保留，由调用方报错。
 */
export function resolveEndpoint(input: EndpointSource = {}): { protocol: Protocol; aiBaseUrl: string } {
  const source: EndpointSource = input && typeof input === "object" ? input : {};
  const preset = presetById(source.presetId) || DEFAULT_PRESET;
  const isCustom = preset.id === CUSTOM_PRESET_ID;
  const protocol = !isCustom
    ? preset.protocol
    : isProtocol(source.protocol)
      ? source.protocol
      : preset.protocol;
  const rawBaseUrl = !isCustom
    ? preset.baseUrl
    : typeof source.aiBaseUrl === "string" && source.aiBaseUrl.trim()
      ? source.aiBaseUrl.trim()
      : preset.baseUrl;
  const checked = validateBaseUrl(rawBaseUrl, protocol);
  return { protocol, aiBaseUrl: checked.ok ? checked.url : rawBaseUrl };
}

// 对话请求的端点。名字沿用 Chat Completions 时代，三种协议都从这里取。
export function chatCompletionsUrl(settings: EndpointSource): string | null {
  const { aiBaseUrl, protocol } = resolveEndpoint(settings);
  const base = validateBaseUrl(aiBaseUrl, protocol);
  if (!base.ok) return null;
  if (protocol === PROTOCOLS.ANTHROPIC) return `${base.url}/v1/messages`;
  if (protocol === PROTOCOLS.RESPONSES) return `${base.url}/responses`;
  return `${base.url}/chat/completions`;
}

export function modelsUrl(settings: EndpointSource): string | null {
  const { aiBaseUrl, protocol } = resolveEndpoint(settings);
  const base = validateBaseUrl(aiBaseUrl, protocol);
  if (!base.ok) return null;
  return protocol === PROTOCOLS.ANTHROPIC
    ? `${base.url}/v1/models`
    : `${base.url}/models`;
}
