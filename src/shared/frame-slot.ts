// 解释当前画面的功能槽和提示词文件名：只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进包，只从开关分支引用。
// 画面分析单独选模型（同一服务商、同一把密钥），设置页按功能选模型那一节多出这一项。

export const FRAME_SLOT = { id: "frame", label: "画面分析" } as const;

export const FRAME_PROMPT_FILE = "study/frame-explain.md";
