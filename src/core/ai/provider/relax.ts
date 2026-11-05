// 参数放宽：模型因某个参数返回 400 时算出下一轮怎么发，记住放宽项，并把放宽重发收成一个函数。
import { NO_CLEAR_GUARD, type ClearGuard } from "../../clear-guard.ts";
import { RELAX_STORAGE_KEY } from "../../../shared/names.ts";
import { apiVersionFor } from "./anthropic.ts";
import { PROTOCOLS, type Protocol } from "./endpoint.ts";
import { buildChatRequest } from "./request.ts";
import type {
  AiSettings,
  ChatRequestBody,
  RejectedError,
  RelaxMemory,
  RelaxState,
  RelaxStorage,
  RememberOptions,
  SendChatInput,
} from "./types.ts";

// 报错里点名的替代写法。Sonnet 5.5 拒绝 disabled 时的原文是
// To turn thinking off on this model, send "thinking": {"type": "between_tools"} instead of {"type": "disabled"}.
const SUGGESTED_THINKING =
  /send\s+"thinking"\s*:\s*\{\s*"type"\s*:\s*"(\w+)"\s*\}\s*instead of/i;

// 被拒的请求带了结构化输出时，报错提到 schema 就当作是它引起的。
const SCHEMA_REJECTED = /output_config\.format|text\.format|json[_ ]schema|\bschema\b/i;

// JSON 模式缺 "json" 这个词时的报错，原文形如
// Response input messages must contain the word 'json' in some form to use 'text.format' of type 'json_object'.
const JSON_WORD_REQUIRED = /must contain the word ['"`]?json/i;

function sentStructuredOutput(body: ChatRequestBody | null | undefined): boolean {
  return Boolean(body?.output_config?.format || body?.text?.format?.type === "json_schema");
}

/**
 * 模型因为某个参数返回 400 时，算出下一轮该放宽什么。放宽过的再报错就交还给调用方，
 * 不是这几类报错时返回 null。body 是被拒的那个请求体。
 * relax.thinking 为 true 表示不传 thinking（即自适应思考），为字符串表示改传这个类型。
 * 报错点名了替代值就先用它；替代值也被拒，或报错没点名，就退到不传。
 * relax.format 为 true 表示不发结构化输出，退回 JSON 模式加提示词。
 * relax.jsonObject 为 true 表示连 JSON 模式也不发（Responses），只靠提示词约束格式。
 * relax.effort 为 true 表示不发 reasoning.effort（Responses），用型号的默认档。
 * 一路只往不传的方向走，所以重发次数有限。
 * Chat Completions 不放宽：兼容服务商的请求体保持原样。
 */
export function relaxRejectedParams(
  protocol: Protocol,
  error: RejectedError | null | undefined,
  current: RelaxState = {},
  body: ChatRequestBody | null = null,
): RelaxState | null {
  if (protocol === PROTOCOLS.OPENAI || error?.status !== 400) return null;
  // OpenAI 的报错把出问题的参数单独放在 param 里，比如 reasoning.effort。
  const message = [error.message, error.param].filter(Boolean).join(" ");
  const suggested = message.match(SUGGESTED_THINKING)?.[1]?.toLowerCase();
  if (
    protocol === PROTOCOLS.ANTHROPIC &&
    current.thinking !== true &&
    (suggested || /thinking\.type\.\w+.*not supported/i.test(message))
  ) {
    const usable =
      suggested &&
      suggested !== "disabled" &&
      suggested !== "enabled" &&
      suggested !== "adaptive" &&
      suggested !== current.thinking;
    return { ...current, thinking: usable ? suggested : true };
  }
  // 补了说明仍被拒（服务的判法和文档不一样）时，不再发 JSON 模式，靠提示词约束格式。
  // 要排在结构化输出前面：这条报错里也带着 text.format。
  if (
    !current.jsonObject &&
    body?.text?.format?.type === "json_object" &&
    JSON_WORD_REQUIRED.test(message)
  ) {
    return { ...current, jsonObject: true };
  }
  if (!current.format && sentStructuredOutput(body) && SCHEMA_REJECTED.test(message)) {
    return { ...current, format: true };
  }
  // 兼容表里的档位万一被拒（型号改了支持的档位），退回不发，用默认档。
  if (!current.effort && body?.reasoning?.effort && /reasoning/i.test(message)) {
    return { ...current, effort: true };
  }
  if (!current.temperature && /temperature/i.test(message)) {
    return { ...current, temperature: true };
  }
  return null;
}

export { RELAX_STORAGE_KEY };
// 每组设置一条，用户实际切换过的组合不会多；封顶防着异常增长。
const MAX_RELAX_ENTRIES = 50;

/**
 * 记住哪些服务和模型要放宽参数，同一组设置下次直接按放宽后的参数发，
 * 不用每个请求都先挨一次 400。键是协议、API 地址、模型和 API 版本，
 * 任何一项改了都对不上，旧记录自然失效。只在放宽后的请求成功时才记，
 * 一次偶然的报错不该永久降低能力。
 * 传了 storage（后台传会话存储）就同时写进存储：MV3 的后台空闲
 * 半分钟就会被回收，只放内存的话每次醒来都要重新挨 400；session 存储在浏览器
 * 关闭前一直在，重启浏览器后重新学。存储读写失败时退回只用内存。
 *
 * clearGuard：后台传入清除本机数据的闸门。请求开始时记下清除代数，
 * 请求成功后要记放宽项时，这期间清除过缓存就不记，写存储那一段登记在闸门里。
 */
export function createRelaxMemory({
  storage,
  clearGuard = NO_CLEAR_GUARD,
}: { storage?: RelaxStorage; clearGuard?: ClearGuard } = {}): Required<RelaxMemory> {
  const entries = new Map<string, RelaxState>();
  const keyOf = (settings: AiSettings): string =>
    JSON.stringify([
      settings.protocol,
      settings.aiBaseUrl,
      settings.aiModel,
      apiVersionFor(settings),
    ]);
  let loading: Promise<void> | null = null;
  // forget() 加一：清除之前发起、清除之后才读回来的那份存储内容不再填进内存。
  let generation = 0;

  return {
    /**
     * 第一次用时从存储读入，之后以内存为准。放在第一次请求时而不是创建时读：
     * 后台入口的顶层不能做异步工作。读失败下次再试。
     */
    ready() {
      if (!storage) return Promise.resolve();
      if (!loading) {
        const started = generation;
        // 读也登记在清除闸门里：清除要等在途的读取结束，清除进行中才来的读取等清完再读，
        // 不会在「代数已经加了、存储还没删」的那一下读到旧记录。
        loading = clearGuard
          .track(() => storage.get(RELAX_STORAGE_KEY))
          .then((stored) => {
            if (started !== generation) return;
            const saved = stored?.[RELAX_STORAGE_KEY];
            if (!saved || typeof saved !== "object") return;
            for (const [key, relax] of Object.entries(saved)) {
              // 内存里已有的更新，不让旧记录盖掉。
              if (!entries.has(key) && relax && typeof relax === "object") {
                entries.set(key, { ...relax });
              }
            }
          })
          .catch(() => {
            if (started === generation) loading = null;
          });
      }
      return loading;
    },
    recall: (settings) => ({ ...entries.get(keyOf(settings)) }),
    epoch: () => clearGuard.epoch(),
    // since：请求开始时 epoch() 的返回值。这期间清除过缓存就不记。
    remember(settings, relax, { since }: RememberOptions = {}) {
      if (!Object.keys(relax).length) return undefined;
      if (clearGuard.clearedSince(since, "cache")) return undefined;
      const key = keyOf(settings);
      // 放宽项没变就不写存储：成功的请求每次都会走到这里。
      if (JSON.stringify(entries.get(key)) === JSON.stringify(relax)) return undefined;
      entries.delete(key);
      entries.set(key, { ...relax });
      while (entries.size > MAX_RELAX_ENTRIES) entries.delete(entries.keys().next().value as string);
      if (!storage) return undefined;
      return clearGuard
        .track(() => {
          if (clearGuard.clearedSince(since, "cache")) return undefined;
          return storage.set({ [RELAX_STORAGE_KEY]: Object.fromEntries(entries) });
        })
        .catch(() => {});
    },
    // 清除本机数据时连内存里记着的一起清掉；存储里那份由清除本身删。
    forget() {
      generation += 1;
      entries.clear();
      loading = null;
    },
  };
}

/**
 * 构造对话请求并发出；模型因某个参数返回 400 时，按 relaxRejectedParams 放宽后重发。
 * 设置页的测试连接和后台的业务请求都走这里，放宽规则只维护一份。
 * send(request, settings) 由调用方实现，超时和读响应体各管各的：成功返回响应数据，
 * 失败抛出带 status 和 message 的错误（用 keyedHttpError 构造）。返回值里的 relax 是本次实际生效的放宽项，
 * 调用方后续轮次接着传回来，就不用再挨一次 400。传了 memory 就从记住的放宽项
 * 开始发，放宽后请求成功了再记下来。capabilities 是当前模型的能力，没有时传 null。
 */
export async function sendChatWithRelax({
  settings,
  messages,
  maxTokens,
  temperature,
  responseFormat,
  relax = {},
  capabilities = null,
  memory,
  send,
  onRelax = () => {},
}: SendChatInput): Promise<{ data: unknown; relax: RelaxState }> {
  await memory?.ready?.();
  const since = memory?.epoch?.();
  let current: RelaxState = { ...memory?.recall(settings), ...relax };
  for (;;) {
    const request = buildChatRequest({
      settings,
      messages,
      maxTokens,
      temperature,
      responseFormat,
      relax: current,
      capabilities,
    });
    try {
      const data = await send(request, settings);
      await memory?.remember(settings, current, { since });
      return { data, relax: current };
    } catch (error) {
      const next = relaxRejectedParams(settings.protocol, error as RejectedError, current, request.body);
      if (!next) throw error;
      current = next;
      onRelax(current);
    }
  }
}
