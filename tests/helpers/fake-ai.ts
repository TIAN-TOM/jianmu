// 模型服务接线的替身，给后台各服务的测试用：按功能回预设的回复，可以把某项功能挂住，记下每次请求。
// 不发任何网络请求；挂住的请求在取消信号中止时按取消收尾，和真实的传输层一样。
import type { AiWiring, TaskAi } from "../../src/background/ai.ts";
import type { CompletionRequest, CompletionResult } from "../../src/core/ai/transport/index.ts";
import { taskCanceledError } from "../../src/core/ai/transport/index.ts";
import { fail, ok } from "../../src/core/errors.ts";
import type { FrozenGen } from "../../src/core/tasks.ts";
import type { ConfigCheckView } from "../../src/shared/messages/ai.ts";
import { normalize } from "../../src/shared/settings-schema.ts";
import { deferred, type Deferred } from "./deferred.ts";

/** 一项功能的回复：固定文字、按请求算出来的文字，或者要抛出的错误。 */
export type FakeReply = string | Error | ((request: CompletionRequest) => string | Promise<string>);

export interface FakeAiOptions {
  /** 按功能名给回复；"*" 是没单独给的功能共用的。 */
  readonly replies?: Readonly<Record<string, FakeReply>>;
  /** 没指定功能时用的模型，也是 configCheck 的那份配置里的模型。 */
  readonly model?: string;
  readonly config?: ConfigCheckView;
  readonly models?: readonly string[];
  readonly prompts?: Readonly<Record<string, string>>;
}

export interface FakeAiCall {
  readonly feature: string | undefined;
  /** 经 forTask 发的，记下冻结的模型。 */
  readonly frozen?: FrozenGen;
  readonly request: CompletionRequest;
}

export interface FakeAi {
  readonly ai: AiWiring;
  readonly calls: FakeAiCall[];
  /** 这项功能之后的请求都停在发出之后，直到调用返回的函数放行。 */
  readonly hold: (feature: string) => () => void;
  /** 发过几次；不给功能名时数全部。 */
  readonly count: (feature?: string) => number;
}

function untilAborted(signal: AbortSignal | undefined): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(taskCanceledError());
    signal.addEventListener("abort", () => reject(taskCanceledError()), { once: true });
  });
}

export function createFakeAi(options: FakeAiOptions = {}): FakeAi {
  const calls: FakeAiCall[] = [];
  const held = new Map<string, Deferred>();
  const model = options.model ?? "fake-model";
  const settings = normalize({ presetId: "custom", aiBaseUrl: "https://ai.example.test/v1", aiModel: model });

  async function complete(request: CompletionRequest, frozen?: FrozenGen): Promise<CompletionResult> {
    const feature = request.feature;
    calls.push(frozen ? { feature, frozen, request } : { feature, request });
    if (request.signal?.aborted) throw taskCanceledError();
    const gate = held.get(feature ?? "");
    if (gate) await Promise.race([gate.promise, untilAborted(request.signal)]);
    const reply = options.replies?.[feature ?? ""] ?? options.replies?.["*"];
    if (reply === undefined) throw new Error(`替身没给「${feature ?? "默认"}」准备回复`);
    if (reply instanceof Error) throw reply;
    const text = typeof reply === "function" ? await reply(request) : reply;
    return { text, settings: { ...settings, aiModel: frozen?.model ?? model }, sends: 1 };
  }

  const ai: AiWiring = {
    configCheck: async () => options.config ?? { ready: true, errors: [] },
    requestAiCompletion: (request) => complete(request),
    freeze: async (feature) => ({ feature, baseUrl: settings.aiBaseUrl, model, effort: "off", promptVersion: "fake-prompt" }),
    forTask: (frozen): TaskAi => ({ requestAiCompletion: (request) => complete({ ...request, feature: frozen.feature }, frozen) }),
    listModels: async () => ok({ ids: [...(options.models ?? [model])] }),
    async testConnection(feature) {
      try {
        const result = await complete({ feature, messages: [{ role: "user", content: "测试" }], maxTokens: 16 });
        return ok({ model: result.settings.aiModel, reply: result.text });
      } catch {
        return fail("AI_REQUEST_FAILED");
      }
    },
    prompt(file) {
      const text = options.prompts?.[file];
      if (text === undefined) throw new Error(`没有这份提示词：${file}`);
      return text;
    },
  };

  return {
    ai,
    calls,
    hold(feature) {
      const gate = deferred();
      held.set(feature, gate);
      return () => {
        held.delete(feature);
        gate.resolve();
      };
    },
    count: (feature) => calls.filter((call) => feature === undefined || call.feature === feature).length,
  };
}
