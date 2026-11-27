// 推理强度的档位：设置、任务、生成配置、备份和协议适配层都认这一张表。不依赖别的 AI 模块。

/** 设置页能选的档位，从低到高。 */
export const EFFORTS = Object.freeze(["off", "low", "medium", "high"] as const);

export type Effort = (typeof EFFORTS)[number];

export const isEffort = (value: unknown): value is Effort => (EFFORTS as readonly unknown[]).includes(value);
