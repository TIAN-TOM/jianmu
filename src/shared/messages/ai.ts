// 模型服务这几条消息的请求和回复：配置检查、拉模型列表、测试连接。回复里都不带密钥。
import type { FeatureSlotId } from "../settings-schema.ts";
import type { EmptyRequest } from "./core.ts";

/** 配置够不够发起一次请求；errors 是给用户看的提示。 */
export interface ConfigCheckView {
  readonly ready: boolean;
  readonly errors: readonly string[];
}

export interface ModelListView {
  readonly ids: readonly string[];
}

/** 不带功能时测默认模型，带了就测这项功能实际要用的模型。 */
export interface TestConnectionRequest {
  readonly feature?: FeatureSlotId;
}

export interface TestConnectionView {
  readonly model: string;
  /** 模型回的头几个字。 */
  readonly reply: string;
  /** 回复被截断：连接是通的，正文不完整。 */
  readonly truncated?: true;
}

export interface AiApi {
  "config.check": { req: EmptyRequest; res: ConfigCheckView };
  "models.list": { req: EmptyRequest; res: ModelListView };
  "ai.testConnection": { req: TestConnectionRequest; res: TestConnectionView };
}
