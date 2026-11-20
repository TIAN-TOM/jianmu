// 带密钥的请求：模型调用、模型能力、设置页的测试连接和模型列表共用这几条约定。
import { errorBodyOf, parseErrorMessage } from "./response.ts";
import { bothLangs, withEnglish } from "./text.ts";
import type { AiSettings, ProviderError } from "./types.ts";

/**
 * 带密钥的请求一律不跟随重定向：浏览器跨域重定向时只去掉 Authorization，
 * x-api-key 这类自定义头会跟着发到新地址。用 manual 而不是 error：error 模式下
 * 浏览器只抛一个和连不上一模一样的 TypeError，说不清是重定向；manual 拿到的是
 * opaqueredirect 响应（Node 里是原样的 3xx），能认出来单独报。两种都不会往新地址发请求。
 */
export const KEYED_FETCH_REDIRECT = "manual";

/** 这里只看响应的这几项，真实的 Response 和测试替身都满足。 */
export interface RedirectProbe {
  readonly type?: string;
  readonly status?: number;
  readonly body?: { readonly cancel?: () => unknown } | null;
}

export function isRedirectResponse(response: RedirectProbe | null | undefined): boolean {
  const status = Number(response?.status);
  return response?.type === "opaqueredirect" || (status >= 300 && status < 400);
}

/** 拿到响应先过这一关：是重定向就丢掉响应体，报一句说得清的错。 */
export function rejectRedirect(response: RedirectProbe | null | undefined, baseUrl: string | undefined): void {
  if (!isRedirectResponse(response)) return;
  Promise.resolve(response?.body?.cancel?.()).catch(() => {});
  const { message, messageEn } = bothLangs((text) => text.redirected(String(baseUrl)));
  const error: ProviderError = withEnglish(new Error(message), messageEn);
  error.code = "AI_REDIRECT_BLOCKED";
  throw error;
}

// 太短的密钥不替换：把报错里每一处两三个字符的片段都换掉，报错就没法读了。
const MIN_REDACTED_SECRET_LENGTH = 8;
const REDACTED_SECRET = "[已隐藏的密钥]";

export function redactSecret(text: unknown, secret: unknown): string {
  const value = String(text ?? "");
  const key = String(secret || "").trim();
  return key.length < MIN_REDACTED_SECRET_LENGTH ? value : value.split(key).join(REDACTED_SECRET);
}

// Anthropic 的个人密钥创建时可以不限定工作区，这种密钥的每个请求都要带 anthropic-workspace-id，
// 不带就回 400。扩展没有这个设置项，只能请用户换一把限定了工作区的密钥。
const WORKSPACE_REQUIRED = /not scoped to a workspace|anthropic-workspace-id/i;

interface ParamBody {
  readonly error?: { readonly param?: string };
}

/**
 * 带密钥请求的 HTTP 失败。有的服务会在报错里回显收到的密钥，报错又会进界面、
 * 存下的失败记录和备份，所以先用这次实际发出的密钥脱敏，再构造错误。
 */
export function keyedHttpError(
  data: unknown,
  status: number,
  settings: Partial<Pick<AiSettings, "aiApiKey">> | null | undefined,
): ProviderError {
  const secret = settings?.aiApiKey;
  const raw = redactSecret(parseErrorMessage(data, status), secret);
  if (status === 400 && WORKSPACE_REQUIRED.test(raw)) {
    const { message, messageEn } = bothLangs((text) => text.workspaceRequired);
    const error: ProviderError = withEnglish(new Error(message), messageEn);
    error.status = status;
    error.code = "ANTHROPIC_WORKSPACE_REQUIRED";
    return error;
  }
  const error: ProviderError = new Error(raw);
  error.status = status;
  // OpenAI 把出问题的参数单独放在 param 里，参数放宽要靠它认出是哪一项。
  const param = (errorBodyOf(data) as ParamBody | null | undefined)?.error?.param;
  if (param) error.param = redactSecret(param, secret);
  return error;
}
