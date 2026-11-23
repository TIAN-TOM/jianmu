// 模型服务这几条消息的请求和回复：配置检查、拉模型列表、测试连接、推理强度预览（带最近一次的用量）。回复里都不带密钥。
import type { EffortNote, TokenUsage } from "../../core/ai/provider/index.ts";
import type { Effort } from "../../core/notes/records.ts";
import type { FeatureSlotId } from "../settings-schema.ts";
import type { EmptyRequest } from "./core.ts";

/** 打开就出结论为什么停着：额度用完、密钥不对、本机的服务拒绝了来自浏览器扩展的请求。 */
export type AutoPauseReason = "quota" | "key" | "local-origin";

/** 配置够不够发起一次请求；errors 是给用户看的提示。autoPaused：打开就出结论停着，只在停着时带。 */
export interface ConfigCheckView {
  readonly ready: boolean;
  readonly errors: readonly string[];
  readonly autoPaused?: AutoPauseReason;
  /** 没设置好、只差一样时是哪一样：页面据此直接说该补什么。 */
  readonly missing?: "key" | "consent";
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

/** 表单上还没保存的档位；没给的功能按已保存的设置。 */
export interface EffortPreviewRequest {
  readonly efforts?: Readonly<Partial<Record<FeatureSlotId, Effort>>>;
}

export interface EffortPreviewItem {
  readonly feature: FeatureSlotId;
  /** 这项功能实际要用的模型。 */
  readonly model: string;
  readonly requested: Effort;
  readonly effective: Effort;
  /** 实际档位和选的不一样、或者扩展设不了时的原因。 */
  readonly note?: EffortNote;
  /** 这项功能在本次浏览器会话里最近一次请求的用量，没请求过就没有。 */
  readonly lastUsage?: LastUsageView;
}

/** 一次请求服务回报的用量，连同当时实际用的模型和档位。只有数字，不带请求和回复的内容。 */
export interface LastUsageView {
  readonly model: string;
  /** 这次实际按的档位。 */
  readonly effort: Effort;
  /** 和预览一样：note 为 unknown 时档位由服务自己决定，effort 只是占位的关。 */
  readonly note?: EffortNote;
  /** 服务没报的那一项就没有；一项都没报时是空的。 */
  readonly usage: TokenUsage;
}

export interface EffortPreviewView {
  readonly items: readonly EffortPreviewItem[];
}

export interface AiApi {
  "config.check": { req: EmptyRequest; res: ConfigCheckView };
  "models.list": { req: EmptyRequest; res: ModelListView };
  "ai.testConnection": { req: TestConnectionRequest; res: TestConnectionView };
  "ai.effortPreview": { req: EffortPreviewRequest; res: EffortPreviewView };
}
