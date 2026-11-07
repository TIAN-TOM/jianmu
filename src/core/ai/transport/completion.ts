// 一次模型调用的完整过程：校验配置、查能力、发送，以及空响应、截断、限流各自的自愈。
import { dataConsentGiven } from "../../consent.ts";
import {
  canRaiseBudget,
  createRelaxMemory,
  diagnoseEmptyResponse,
  isTruncated,
  parseChatResponse,
  redactSecret,
  refusalOf,
  sendChatWithRelax,
  type ChatRequest,
  type EmptyDiagnosis,
  type RelaxState,
} from "../provider/index.ts";
import { isRepairedEnvelope } from "./envelope.ts";
import { aiErrorResponse, refusedError, taskCanceledError, throwIfTaskCanceled } from "./errors.ts";
import {
  abortableSleep,
  BUSY_RETRY_MAX_WAIT_MS,
  BUSY_RETRY_MIN_MS,
  BUSY_RETRY_SPREAD_MS,
  BUSY_RETRY_STATUSES,
  ceilingFor,
  MAX_ATTEMPTS,
  raisedBudget,
  TOTAL_OUTPUT_TOKENS_CAP,
  waitSignal,
} from "./policy.ts";
import { createAiSender } from "./send.ts";
import type {
  AiTransport,
  AiTransportDeps,
  CompletionRequest,
  CompletionResult,
  TransportError,
  TransportSettingsRules,
} from "./types.ts";

// 同意的核对靠这几样。缺一样、版本号不是正整数或者指纹是空的，比较就可能恒成立，所以建传输层时就拦下。
function assertSettingsRules(rules: TransportSettingsRules | undefined): void {
  const complete =
    typeof rules?.validate === "function" &&
    typeof rules.normalize === "function" &&
    typeof rules.withFeatureModel === "function" &&
    Number.isInteger(rules.dataConsentVersion) &&
    rules.dataConsentVersion > 0 &&
    Boolean(rules.dataConsentFingerprint) &&
    Boolean(rules.dataConsentError) &&
    rules.timeoutSeconds > 0;
  if (!complete) {
    throw new Error("AI 传输层需要设置规则：校验、规整、按功能换模型、同意版本、指纹和提示、默认超时");
  }
}

export function createAiTransport({
  getSettings,
  ensureHostPermission,
  settingsRules,
  log = () => {},
  timeoutMs,
  idleTimeoutMs,
  maxResponseBytes,
  relaxMemory = createRelaxMemory(),
  getModelCapabilities = async () => null,
  sleep = abortableSleep,
  random = Math.random,
  fetch: fetchImpl,
}: AiTransportDeps): AiTransport {
  if (!getSettings || !ensureHostPermission) {
    throw new Error("AI 传输层需要 getSettings 与 ensureHostPermission");
  }
  assertSettingsRules(settingsRules);
  const { sendAiRequest, readBoundedAiResponse } = createAiSender({
    fetch: fetchImpl,
    timeoutMs: timeoutMs ?? settingsRules.timeoutSeconds * 1000,
    idleTimeoutMs,
    maxResponseBytes,
  });

  // 协议差异由 provider 处理，这里只管自愈：空响应和截断各有能救的成因，
  // 最多三轮。新型号拒绝某个参数时去掉它再发，这种重发不占轮次；
  // 放宽成功后记下来，同一组设置之后的请求直接按放宽后的参数发。
  // 用户给这项功能另选了模型时，之后的参数规则、能力查询和放宽记忆都按实际模型来。
  async function requestAiCompletion({
    feature,
    messages,
    maxTokens,
    temperature,
    responseFormat,
    signal,
    retrySignal,
    onRetry,
    selfRetry = true,
    stillWanted = null,
  }: CompletionRequest): Promise<CompletionResult> {
    throwIfTaskCanceled(signal);
    const configured = await getSettings();
    const check = settingsRules.validate(configured);
    if (!check.ok) {
      const error: TransportError = new Error(`AI 还没配置好：${check.errors.join(" ")}`);
      error.code = "NO_AI_CONFIG";
      throw error;
    }
    const settings = settingsRules.withFeatureModel(configured, feature);
    await ensureHostPermission(settings.aiBaseUrl);
    // 能力只是用来把参数发得更准，查不到不该挡住请求。
    const capabilities = await Promise.resolve()
      .then(() => getModelCapabilities(settings))
      .catch(() => null);
    const ceiling = ceilingFor(capabilities);

    let format = responseFormat;
    let tokens = Math.min(maxTokens, ceiling);
    let diagnosis: EmptyDiagnosis | null = null;
    let relax: RelaxState = {};
    let attempt = 0;
    let spent = 0;
    // 本次调用拿到过的最长的一份截断正文。之后的重发不管因为什么失败（取消除外），
    // 都把它交回去，带上 truncated 标记，由调用方的 JSON 补齐兜底，
    // 不让已经付过费的结果白白丢掉。
    let partial = "";
    // 限流、过载的自动重发每次调用只有一次。
    let busyRetried = false;
    const partialResult = (): CompletionResult => ({ text: partial, settings, truncated: true, sends });
    // 每一次发送都是新的计费请求，首发、参数放宽、加码、限流后重发都一样：异步准备（查能力、
    // 核对同意）全部做完、真正发出之前再看一眼 retrySignal，停止了就不发。参数放宽在
    // sendChatWithRelax 里面重发，不回到下面的循环，所以拦在这里。已经发出的请求不受影响。
    let sends = 0;
    const send = async (request: ChatRequest): Promise<unknown> => {
      await assertConsentStillGiven();
      throwIfTaskCanceled(retrySignal);
      if (stillWanted && !stillWanted()) throw taskCanceledError();
      sends += 1;
      return sendAiRequest(settings, request, signal);
    };
    // 这次调用已经自己重发过（限流后重发、加码、脱掉 JSON 模式、参数放宽）还是失败：
    // 重发的额度用掉了，标上 noAutoRetry，上层（翻译补轮、概览补轮）不再补发。
    const exhausted = (error: TransportError): TransportError => {
      if (sends > 1 && error && typeof error === "object" && error.code !== "TASK_CANCELED") {
        error.noAutoRetry = true;
      }
      return error;
    };

    while (attempt < MAX_ATTEMPTS) {
      throwIfTaskCanceled(signal);
      // 第一次之后的每一次都是新的计费请求（加码、脱掉 JSON 模式、限流后重发）：停止了就不再发，
      // 有截断正文就交回它。
      if ((attempt > 0 || busyRetried) && retrySignal?.aborted) {
        if (partial) return partialResult();
        throwIfTaskCanceled(retrySignal);
      }
      let data: unknown;
      try {
        ({ data, relax } = await sendChatWithRelax({
          settings,
          messages,
          maxTokens: tokens,
          temperature,
          responseFormat: format,
          relax,
          capabilities,
          memory: relaxMemory,
          send,
          onRelax: (next) => log("[jianmu] 模型拒绝了请求参数，放宽后重发：", next),
        }));
      } catch (error) {
        if (signal?.aborted) throw error;
        const failure = error as TransportError;
        // retrySignal 拦下的后续发送：已经付过费的截断正文照样交回。
        if (failure?.code === "TASK_CANCELED" && !(partial && retrySignal?.aborted)) throw error;
        if (partial) {
          log("[jianmu] 加大预算重试失败，交回已有的截断正文：", error);
          return partialResult();
        }
        const delayMs = busyRetried || !selfRetry ? -1 : busyRetryDelay(failure);
        if (delayMs < 0) throw exhausted(failure);
        // 服务在生成之前就拒绝了，这次不计费，也不占自愈轮次。
        busyRetried = true;
        const seconds = Math.max(1, Math.round(delayMs / 1000));
        const notice = {
          status: failure.status,
          delayMs,
          message: `${failure.status === 429 ? "服务限流" : "服务繁忙"}，${seconds} 秒后重试…`,
        };
        log("[jianmu] 服务限流或过载，稍后重发一次：", notice);
        try {
          onRetry?.(notice);
        } catch {
          // 进度提示出错不影响请求本身。
        }
        await sleep(delayMs, waitSignal(signal, retrySignal));
        throwIfTaskCanceled(retrySignal);
        continue;
      }
      attempt += 1;
      spent += tokens;

      const refusal = refusalOf(settings.protocol, data);
      if (refusal !== null) {
        if (partial) return partialResult();
        // 拒答换个时间再问多半还是拒答，上层也不补发。
        const refused = refusedError(redactSecret(refusal, settings.aiApiKey));
        refused.noAutoRetry = true;
        throw refused;
      }

      const text = parseChatResponse(settings.protocol, data);
      if (text.trim()) {
        const cutByProvider = isTruncated(settings.protocol, data);
        // 信封是补齐出来的，也按截断交回：服务商的截断原因多半跟着断掉的那段丢了。
        if (!cutByProvider && !isRepairedEnvelope(data)) return { text, settings, sends };
        if (text.trim().length > partial.trim().length) partial = text;
        // 有正文但被截断：只在加大预算有望补全时再要一次完整的；
        // 补全无望、预算已到顶或轮次用完，就交出已有部分。
        // 只是信封断了的话，加大预算补不回来，不重发。
        const next =
          selfRetry &&
          cutByProvider &&
          attempt < MAX_ATTEMPTS &&
          canRaiseBudget(settings.protocol, data)
            ? raisedBudget(tokens, spent, ceiling)
            : 0;
        if (!next) return partialResult();
        tokens = next;
        log("[jianmu] 正文被截断，放大预算重试：", tokens);
        continue;
      }

      diagnosis = diagnoseEmptyResponse(settings.protocol, data, {
        model: settings.aiModel,
        relax,
        capabilities,
      });

      // 这次重发同样计费，前面加过码时要压到合计预算的余量以内。
      const remaining = TOTAL_OUTPUT_TOKENS_CAP - spent;
      if (selfRetry && format && diagnosis.retryWithoutJsonMode && remaining > 0) {
        log("[jianmu] JSON 模式返回空，脱掉 response_format 重试");
        format = null;
        tokens = Math.min(tokens, remaining);
        continue;
      }

      // 一个字没写就用完了预算，只能是看不见的思考吃掉了，加码重试。
      // 重发是一次新的完整请求，输入和这一轮的生成都要重新计费，
      // 所以单轮和合计预算都有上限。
      const next =
        selfRetry && diagnosis.retryWithMoreTokens ? raisedBudget(tokens, spent, ceiling) : 0;
      if (next) {
        tokens = next;
        log("[jianmu] 输出被截断，放大预算重试：", tokens);
        continue;
      }

      break;
    }

    // 先前拿到过截断正文、后面的重发只换来空响应时，交回那份正文。
    if (partial) return partialResult();
    // Responses 生成失败时，诊断直接用服务给的报错，同样可能回显密钥。
    // 走到这里一定诊断过：没有截断正文，循环只会从空响应那条路出来。
    const error: TransportError = new Error(redactSecret(diagnosis!.message, settings.aiApiKey));
    error.code = "EMPTY_AI_RESPONSE";
    error.reason = diagnosis!.reason;
    throw exhausted(error);
  }

  /**
   * 限流、过载后要不要自动重发、等多久：返回毫秒数，-1 表示不重发。
   * 服务给了 Retry-After 就按它等，超过上限就不等了；没给就随机等 2 到 5 秒。
   * 额度用完、等得比上限还久的在 sendAiRequest 里已经标了 noAutoRetry。
   */
  function busyRetryDelay(error: TransportError): number {
    const status = Number(error?.status);
    if (!BUSY_RETRY_STATUSES.has(status)) return -1;
    if (error.noAutoRetry) return -1;
    const advised = error.retryAfterMs;
    if (advised !== undefined && Number.isFinite(advised)) {
      return advised > BUSY_RETRY_MAX_WAIT_MS ? -1 : Math.max(advised, 1000);
    }
    return BUSY_RETRY_MIN_MS + Math.floor(random() * BUSY_RETRY_SPREAD_MS);
  }

  // 用户可能在请求途中取消了数据说明的确认：已经发出的那次照常等它回来，
  // 之后的加码重试、放宽重发都不再发。开头的校验和第一次请求之间还隔着查模型能力
  // （Anthropic 要联网），所以每次发之前都查一遍，第一次也不例外。
  async function assertConsentStillGiven(): Promise<void> {
    if (dataConsentGiven(settingsRules.normalize(await getSettings()), settingsRules)) return;
    const error: TransportError = new Error(`AI 还没配置好：${settingsRules.dataConsentError}`);
    error.code = "NO_AI_CONFIG";
    throw error;
  }

  return {
    requestAiCompletion,
    sendAiRequest,
    readBoundedAiResponse,
    // 模块级函数一并透出，调用方解构后不用再单独导入。
    aiErrorResponse,
    throwIfTaskCanceled,
    taskCanceledError,
  };
}
