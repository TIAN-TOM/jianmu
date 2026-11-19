// 模型服务的错误码和给用户看的三段话。传输层的回执按这张表归类，具体原因放在结果的 detail 里。
import type { ErrorCopy } from "./copy.ts";

export type AiErrorCode =
  | "NO_AI_CONFIG"
  | "NO_DATA_CONSENT"
  | "NEED_HOST_PERMISSION"
  | "INVALID_BASE_URL"
  | "INVALID_AI_KEY"
  | "MODEL_OR_ENDPOINT_NOT_FOUND"
  | "AI_RATE_LIMITED"
  | "AI_SERVICE_BUSY"
  | "AI_SERVICE_ERROR"
  | "AI_NETWORK_ERROR"
  | "AI_REDIRECT_BLOCKED"
  | "ANTHROPIC_WORKSPACE_REQUIRED"
  | "AI_HARD_TIMEOUT"
  | "AI_IDLE_TIMEOUT"
  | "AI_REFUSED"
  | "EMPTY_AI_RESPONSE"
  | "AI_RESPONSE_TOO_LARGE"
  | "AI_RESPONSE_TRUNCATED"
  | "AI_THINKING_EXHAUSTED"
  | "AI_THINKING_EXHAUSTED_LOCKED"
  | "TASK_CANCELED"
  | "AI_REQUEST_FAILED";

const NOT_SENT = "这次没有发请求，不花额度。";
const NO_RESULT = "这次没拿到结果，原来存下的内容都还在。";
const MAYBE_BILLED = "这次没拿到结果，请求已经发出去了，可能照样计费；原来存下的内容都还在。";
const THINKING_EXHAUSTED = "模型把输出额度都用在思考上了，还没写出回复。";
const SWITCH_MODEL = "再试一次；老是这样，就到设置页换个模型。";

export const AI_ERROR_TEXT: Readonly<Record<AiErrorCode, ErrorCopy>> = {
  NO_AI_CONFIG: { cause: "AI 服务还没设置好。", impact: NOT_SENT, next: "到设置页填好服务商、密钥和模型，再点「保存并授权」。" },
  NO_DATA_CONSENT: { cause: "还没同意数据说明。", impact: "没有任何内容发给模型服务。", next: "到设置页读一下数据说明，勾上「我已了解」。" },
  NEED_HOST_PERMISSION: {
    cause: "简幕还没拿到访问这个 API 地址的权限。",
    impact: NOT_SENT,
    next: "到设置页点「保存并授权」，浏览器问的时候选允许。",
  },
  INVALID_BASE_URL: { cause: "API 地址不对。", impact: NOT_SENT, next: "到设置页检查一下 API 地址。" },
  INVALID_AI_KEY: { cause: "AI 服务不认这把密钥。", impact: NO_RESULT, next: "到设置页检查密钥，看它和 API 地址是不是同一家服务商的。" },
  MODEL_OR_ENDPOINT_NOT_FOUND: {
    cause: "AI 服务找不到这个模型或接口。",
    impact: NO_RESULT,
    next: "到设置页核对模型名和 API 地址，可以点「拉取模型列表」从里面挑。",
  },
  AI_RATE_LIMITED: { cause: "AI 服务限流了，也可能是账户额度用完了。", impact: NO_RESULT, next: "等几分钟再试；一直这样，就到服务商后台看看额度。" },
  AI_SERVICE_BUSY: { cause: "AI 服务那边暂时繁忙或出错。", impact: NO_RESULT, next: "稍后再试。" },
  AI_SERVICE_ERROR: { cause: "AI 服务那边出错了。", impact: NO_RESULT, next: "稍后再试；一直这样，到设置页点「测试连接」看看具体原因。" },
  // 扩展分不出断网和被防火墙拦下，所以两种都提一句，不替用户猜是哪种。
  AI_NETWORK_ERROR: {
    cause: "连不上 AI 服务。",
    impact: NO_RESULT,
    next: "检查一下网络，再到设置页核对 API 地址；学校、公司的网络可能拦了这个服务，可以换个网络再试。",
  },
  AI_REDIRECT_BLOCKED: {
    cause: "API 地址把请求转去了别的地方。",
    impact: "为了不把密钥带出去，简幕没有跟过去，这次没拿到结果。",
    next: "到设置页把 API 地址改成服务商给的最终地址。",
  },
  ANTHROPIC_WORKSPACE_REQUIRED: {
    cause: "这把密钥没有限定工作区，服务不接受。",
    impact: NO_RESULT,
    next: "到服务商后台建一把限定了工作区的密钥，填到设置页。",
  },
  AI_HARD_TIMEOUT: { cause: "模型太久没有回应，简幕把这次请求停了。", impact: MAYBE_BILLED, next: "稍后再试；老是这样，就到设置页换个快一点的模型。" },
  AI_IDLE_TIMEOUT: { cause: "模型的回复写到一半断了。", impact: MAYBE_BILLED, next: "再试一次。" },
  AI_REFUSED: { cause: "模型拒绝了这次请求。", impact: MAYBE_BILLED, next: "到设置页换个模型再试，同一个模型重试多半还是一样。" },
  EMPTY_AI_RESPONSE: { cause: "模型没有写出内容。", impact: MAYBE_BILLED, next: SWITCH_MODEL },
  AI_RESPONSE_TOO_LARGE: { cause: "模型的回复太大，简幕没有收下。", impact: MAYBE_BILLED, next: SWITCH_MODEL },
  AI_RESPONSE_TRUNCATED: { cause: "模型的回复没写完就停了。", impact: MAYBE_BILLED, next: SWITCH_MODEL },
  // 思考把输出额度用完了：换模型不是唯一的办法，能调低档位的先让人调；调不了的（服务自己决定想多少、已经在最低档）只给换型号。
  AI_THINKING_EXHAUSTED: {
    cause: THINKING_EXHAUSTED,
    impact: MAYBE_BILLED,
    next: "到设置页「推理强度」给这项功能调低一档再试；或者在「按功能选模型」里给它换个型号。",
  },
  AI_THINKING_EXHAUSTED_LOCKED: {
    cause: THINKING_EXHAUSTED,
    impact: MAYBE_BILLED,
    next: "这个型号想多久，简幕调不了；到设置页「按功能选模型」给这项功能换个型号再试。",
  },
  TASK_CANCELED: { cause: "已经停下了。", impact: "已经发出去的请求可能照样计费。" },
  AI_REQUEST_FAILED: { cause: "AI 请求没有成功。", impact: NO_RESULT, next: "稍后再试。" },
};
