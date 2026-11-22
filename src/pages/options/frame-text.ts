// 设置页里解释当前画面的文案：只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进包，只从开关分支引用。模块顶层只放字面量和函数。
import { inLang, type UiLang } from "../shared/ui-lang.ts";
import { FRAME_HANT } from "./frame-text-hant.ts";

const FRAME_ZH = {
  slot: "画面分析",
  probeHint: "画面分析要选能看图的模型。",
  probing: "正在检测",
  probe: "检测能不能看图",
  probeFailed: (reason: string) => `画面分析：没探成，${reason}`,
  canSee: (model: string) => `画面分析（${model}）能看图。`,
  cannotSee: (model: string) => `画面分析（${model}）不能看图：在「按功能选模型」里给画面分析换一个能看图的模型。`,
};

export type FrameText = typeof FRAME_ZH;

const FRAME_EN: FrameText = {
  slot: "Frame analysis",
  probeHint: "Frame analysis needs a model that can read images.",
  probing: "Checking…",
  probe: "Check image support",
  probeFailed: (reason) => `Frame analysis: the check didn't work. ${reason}`,
  canSee: (model) => `Frame analysis (${model}) can read images.`,
  cannotSee: (model) => `Frame analysis (${model}) can't read images. Under “Models per feature”, choose a model that can.`,
};

export const frameText = (lang: UiLang = "zh"): FrameText => inLang(lang, FRAME_ZH, FRAME_EN, FRAME_HANT);

export const frameSlotLabel = (lang: UiLang = "zh"): string => frameText(lang).slot;
