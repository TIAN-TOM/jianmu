// 传输层的黄金样本重放：按样本的响应走完整链路，错误码、文案和发送次数编码后和 result 逐字节比。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  aiErrorResponse,
  createAiTransport,
  type TransportError,
} from "../../../../src/core/ai/transport/index.ts";
import * as SETTINGS from "../../../../src/shared/settings-schema.ts";

interface Sample {
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

interface ChainCase {
  readonly protocol: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly sample: Sample;
}

interface GoldenCase {
  readonly id: string;
  readonly label: string;
  readonly fn: string;
  readonly args: readonly unknown[];
  readonly note: string;
  readonly result: unknown;
}

// 样本的 note：stub fetch 按 sample 回复，sleep 不等，random 固定 0.5。
async function throughTransport({ protocol, baseUrl, model, sample }: ChainCase): Promise<unknown> {
  const settings = SETTINGS.normalize({
    presetId: "custom",
    protocol,
    aiApiKey: "sk-golden-fake",
    aiBaseUrl: baseUrl,
    aiModel: model,
    ...SETTINGS.DATA_CONSENT_CONFIRMED,
  });
  let calls = 0;
  const transport = createAiTransport({
    getSettings: async () => settings,
    ensureHostPermission: async () => {},
    settingsRules: SETTINGS.settingsRules,
    sleep: async () => {},
    random: () => 0.5,
    fetch: async () => {
      calls += 1;
      return {
        ok: sample.status >= 200 && sample.status < 300,
        status: sample.status,
        headers: { get: (name) => sample.headers[name.toLowerCase()] ?? null },
        text: async () => sample.body,
      };
    },
  });
  try {
    const result = await transport.requestAiCompletion({ messages: [{ role: "user", content: "搭架子" }], maxTokens: 100 });
    return { calls, result: { text: result.text ?? null, truncated: result.truncated ?? false, attempts: null } };
  } catch (error) {
    const failure = error as TransportError;
    return {
      calls,
      error: { code: failure.code ?? null, status: failure.status ?? null, noAutoRetry: failure.noAutoRetry ?? false },
      response: aiErrorResponse(failure),
    };
  }
}

// 入参是带 code、status 的 Error。
function translated({ message, ...fields }: { readonly message: string }): unknown {
  return aiErrorResponse(Object.assign(new Error(message), fields));
}

const REPLAY: Readonly<Record<string, (arg: never) => unknown>> = {
  requestAiCompletion: throughTransport,
  aiErrorResponse: translated,
};

// 样本里的结果只有普通对象和基本类型，键按字典序。
function encode(value: unknown): unknown {
  if (value === undefined) return { $undefined: true };
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(encode);
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
  return Object.fromEntries(entries.map(([key, item]) => [key, encode(item)]));
}

const { cases } = JSON.parse(
  readFileSync(new URL("../../../fixtures/golden/transport-errors.json", import.meta.url), "utf8"),
) as { cases: GoldenCase[] };

test("样本覆盖全部用例和函数", () => {
  assert.equal(cases.length, 92);
  assert.deepEqual([...new Set(cases.map((item) => item.fn))].sort(), Object.keys(REPLAY).sort());
});

for (const item of cases) {
  test(`黄金样本 ${item.id} ${item.label}`.trim(), async () => {
    const replay = REPLAY[item.fn];
    assert.ok(replay, `样本里有没接上的函数：${item.fn}`);
    const actual = await replay(item.args[0] as never);
    assert.equal(JSON.stringify(encode(actual)), JSON.stringify(item.result));
  });
}
