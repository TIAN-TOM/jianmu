// 测试用的设置：和设置规整同一口径取协议和地址，其余字段原样带上。
import { presetById, resolveEndpoint, type EndpointSource } from "../../src/core/ai/provider/endpoint.ts";
import type { AiSettings } from "../../src/core/ai/provider/index.ts";

interface SettingsInput extends EndpointSource {
  readonly aiApiKey: string;
  readonly aiModel: string;
}

export function normalizeAiSettings(input: SettingsInput): AiSettings {
  const { protocol, aiBaseUrl } = resolveEndpoint(input);
  return {
    presetId: presetById(input.presetId)?.id ?? "anthropic",
    protocol,
    aiApiKey: input.aiApiKey,
    aiBaseUrl,
    aiModel: input.aiModel,
  };
}
