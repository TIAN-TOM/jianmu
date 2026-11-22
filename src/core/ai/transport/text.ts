// 传输层给用户看的说明：配置没好、超时、连不上、响应太大或不完整、拒答、按状态码归类的回执、限流后重发的进度。
// 简体那份定形状，英文、繁体那份少一条、多一条或签名不一样，类型检查就报错。错误照旧带简体说明，英文、繁体挂在不可枚举的 messageEn、messageHant 上，
// 回执按语言挑（见 provider/text.ts）。模块顶层只放字面量和函数。
import { inLang, type OutputLang } from "../../output-lang.ts";
import type { LangMessages } from "../provider/text.ts";
import { TRANSPORT_HANT } from "./text-hant.ts";

const TRANSPORT_ZH = {
  notConfigured: (reasons: string) => `AI 还没配置好：${reasons}`,
  idleTimeout: "响应传到一半断了，请重试。",
  hardTimeout: (seconds: number) => `请求超过 ${seconds} 秒上限，可能是服务繁忙或这一段太长。概览可以在设置页把「概览分块」改成「较短」再试。`,
  network: (baseUrl: string) => `连不上 ${baseUrl}。请检查地址是否正确、服务是否在运行，以及是否已在设置页授权。`,
  tooLarge: "响应超过 2 MiB 上限。",
  incomplete: "AI 响应不完整，请重试。",
  canceled: "任务已取消。",
  refusedWith: (reason: string) => `模型拒绝了这次请求：${reason}`,
  refused: "模型拒绝了这次请求。可以换一个模型再试。",
  badKey: "服务拒绝了这个密钥，请在设置里检查密钥和地址是否匹配。",
  notFound: "服务返回 404，多半是模型名写错或 API 地址不对，请到设置页核对。",
  rateLimited: "服务限流了，稍等一会儿再试。",
  serviceError: (status: number, detail: string) => `AI 服务出错（HTTP ${status}）：${detail}`,
  serviceBusy: (status: number) => `AI 服务暂时繁忙或出错（HTTP ${status}），请稍后再试。`,
  failed: "AI 请求失败。",
  retrying: (limited: boolean, seconds: number) => `${limited ? "服务限流" : "服务繁忙"}，${seconds} 秒后重试…`,
};

export type TransportText = typeof TRANSPORT_ZH;

const TRANSPORT_EN: TransportText = {
  notConfigured: (reasons) => `The AI service isn't set up yet: ${reasons}`,
  idleTimeout: "The response cut off partway through. Try again.",
  hardTimeout: (seconds) => `The request went over the ${seconds}-second limit. The service may be busy, or this part may be too long. For overviews, you can set “Overview chunk size” to “Shorter” in settings and try again.`,
  network: (baseUrl) => `Couldn't reach ${baseUrl}. Check that the address is right, that the service is running, and that you've authorised it in settings.`,
  tooLarge: "The response is over the 2 MiB limit.",
  incomplete: "The AI response was incomplete. Try again.",
  canceled: "The task was cancelled.",
  refusedWith: (reason) => `The model refused this request: ${reason}`,
  refused: "The model refused this request. Try a different model.",
  badKey: "The service rejected this key. Check in settings that the key and address match.",
  notFound: "The service returned 404. The model name or API address is most likely wrong, so check them in settings.",
  rateLimited: "The service is limiting requests. Wait a moment and try again.",
  serviceError: (status, detail) => `The AI service ran into an error (HTTP ${status}): ${detail}`,
  serviceBusy: (status) => `The AI service is busy or having problems (HTTP ${status}). Try again later.`,
  failed: "The AI request failed.",
  retrying: (limited, seconds) => `${limited ? "The service is limiting requests" : "The service is busy"}. Retrying in ${seconds} s…`,
};

/** 指定语言那份说明。不传语言时是简体。 */
export const transportText = (lang: OutputLang = "zh"): TransportText => inLang(lang, TRANSPORT_ZH, TRANSPORT_EN, TRANSPORT_HANT);

/** 一句说明的三种语言：pick 从说明表里挑出同一句。 */
export function transportBoth(pick: (text: TransportText) => string): LangMessages {
  return { message: pick(TRANSPORT_ZH), messageEn: pick(TRANSPORT_EN), messageHant: pick(transportText("zh-Hant")) };
}
