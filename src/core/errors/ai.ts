// 模型服务的错误码和给用户看的一句话。传输层的回执按这张表归类，具体原因放在结果的 detail 里。

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
  | "TASK_CANCELED"
  | "AI_REQUEST_FAILED";

export const AI_ERROR_TEXT: Readonly<Record<AiErrorCode, string>> = {
  NO_AI_CONFIG: "AI 服务还没设置好，先到设置页填好密钥和模型。",
  NO_DATA_CONSENT: "要先在设置页读一下数据说明，勾选「我已了解」。",
  NEED_HOST_PERMISSION: "扩展还没有访问这个 API 地址的权限，先到设置页点「保存并授权」。",
  INVALID_BASE_URL: "API 地址不对，到设置页检查一下。",
  INVALID_AI_KEY: "服务拒绝了这个密钥，到设置页检查密钥和地址是否匹配。",
  MODEL_OR_ENDPOINT_NOT_FOUND: "找不到这个模型或接口，到设置页核对模型名和 API 地址。",
  AI_RATE_LIMITED: "AI 服务限流了，稍等一会儿再试。",
  AI_SERVICE_BUSY: "AI 服务暂时繁忙或出错，稍后再试。",
  AI_SERVICE_ERROR: "AI 服务出错了。",
  AI_NETWORK_ERROR: "连不上 AI 服务，检查一下网络和 API 地址。",
  AI_REDIRECT_BLOCKED: "API 地址把请求转到了别处，为了不带出密钥没有跟过去。",
  ANTHROPIC_WORKSPACE_REQUIRED: "这把密钥没有限定工作区，要换一把限定了工作区的密钥。",
  AI_HARD_TIMEOUT: "模型太久没有回应，这次请求停下了。",
  AI_IDLE_TIMEOUT: "模型的回复中途断了，这次请求停下了。",
  AI_REFUSED: "模型拒绝了这次请求。",
  EMPTY_AI_RESPONSE: "模型没有写出内容。",
  AI_RESPONSE_TOO_LARGE: "模型的回复太大，没有收下。",
  AI_RESPONSE_TRUNCATED: "模型的回复不完整。",
  TASK_CANCELED: "已经停下了。",
  AI_REQUEST_FAILED: "AI 请求没有成功。",
};
