// 协议层给用户看的说明，繁体这份。形状由简体那份（text.ts）定，少一条、多一条或签名不一样，类型检查就报错。
// 另有遮掉密钥留下的两个占位字的繁体写法。模块顶层只放字面量和函数。
import type { ProviderText } from "./text.ts";

export const PROVIDER_HANT: ProviderText = {
  baseUrlMissing: "請填寫 API 網址。",
  baseUrlNotUrl: "API 網址不是有效的 URL。",
  baseUrlNotHttps: "API 網址要以 https:// 開頭。只有本機網址（localhost、127.0.0.1）可以用 http://。",
  baseUrlIpv6: "Chrome 的權限系統不支援 IPv6 位址常值，請改用網域名稱。",
  baseUrlBad: "API 網址無效，請到設定頁檢查。",
  redirected: (baseUrl) =>
    `${baseUrl} 把請求重新導向到了別的網址。為了不把 API 金鑰帶過去，擴充功能不跟隨重新導向。請在設定頁把 API 網址改成服務實際使用的網址。`,
  workspaceRequired:
    "這把 Anthropic 金鑰沒有限定工作區，每個請求都要另外帶上工作區 ID，本擴充功能不支援。"
    + "請在 Claude Console 新增一把金鑰，建立時選定一個工作區（例如 Default），再填到設定頁。",
  statusOnly: (status) => `服務傳回 ${status}`,
  streamError: "服務在傳回途中報了錯。",
  reasoningOnlyLocked: "模型只輸出了思考過程，沒有正文。這個型號的思考關不掉，可以重試一次，或者在設定頁「按功能選模型」裡替這項功能另選一個型號。",
  reasoningOnly: "模型只輸出了思考過程，沒有正文。建議在設定頁換一個非推理模型。",
  anthropicGotOpenAi: "回應看起來是 OpenAI 格式，但目前選的是 Anthropic 協定。請到設定頁把「API 協定」改成 OpenAI 相容。",
  openAiGotAnthropic: "回應看起來是 Anthropic 格式，但目前選的是 OpenAI 相容協定。請到設定頁把「API 協定」改成 Anthropic。",
  noChoices: "回應裡沒有 choices 欄位，這個網址可能不是 OpenAI 相容端點。請到設定頁核對 API 網址與協定。",
  thinkingTruncatedLocked:
    "模型還沒輸出正文就到了 token 上限，思考佔滿了額度。已經放大預算重試過，仍然不夠。這個型號的思考關不掉，擴充功能已經替你放大過預算。可以在設定頁「按功能選模型」裡替這項功能另選一個型號；生成概覽時，也可以把「概覽分塊」改成「較短」。",
  thinkingTruncated: "模型還沒輸出正文就到了 token 上限，多半是思考佔滿了額度。已經放大預算重試過，仍然不夠，建議換一個非推理模型。",
  truncated: "輸出被 token 上限截斷了，放大預算重試後仍然不夠。可以換一個輸出更簡潔的模型試試。",
  quotaOnThinkingLocked:
    "模型把 token 配額全用在思考上了，沒能輸出正文。已經放大預算重試過，仍然不夠。這個型號的思考關不掉，擴充功能已經替你放大過預算。可以在設定頁「按功能選模型」裡替這項功能另選一個型號；生成概覽時，也可以把「概覽分塊」改成「較短」。",
  quotaOnThinking: "模型把 token 配額全用在思考上了，沒能輸出正文。已經放大預算重試過，仍然不夠，建議換一個非推理模型。",
  empty: "模型傳回了空的內容，請重試。",
  notResponses: "回應不是 Responses 格式，這個網址可能只支援 Chat Completions 或 Anthropic。請到設定頁核對「API 協定」。",
  noOutput: "回應裡沒有 output 欄位，這個網址可能不支援 Responses API。請到設定頁核對 API 網址與協定。",
  quotaOnReasoning: "模型把 token 配額全用在推理上了，沒能輸出正文。已經放大預算重試過，仍然不夠，可以換一個推理較少的型號。",
  contentFiltered: "輸出被服務方的內容過濾擋下了，沒有正文。",
  generationFailed: "模型生成失敗，請重試。",
  generationFailedWith: (said) => `模型生成失敗，服務說：${said}`,
  reasoningOnlyResponses: "模型只做了推理，沒有輸出正文。可以換一個推理較少的型號再試。",
};

/** 遮掉密钥留下的占位字，繁体的说法：密钥本身和像密钥的片段。 */
export const HIDDEN_HANT = { secret: "[已隱藏的金鑰]", words: "[已隱藏]" };
