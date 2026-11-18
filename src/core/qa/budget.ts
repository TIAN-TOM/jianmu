// 问答一次送给模型多少字幕：先按大预算送，模型装不下时缩到小预算再发一次（core/ai/too-long.ts 认「装不下」）。

/** 一次提问最多送这么多字的字幕；整份装得下就整份送。 */
export const QA_BUDGET_CHARS = 60_000;

/** 被嫌太长以后缩到这么多字再发一次。上下文较小的模型也装得下。 */
export const QA_FALLBACK_BUDGET_CHARS = 12_000;
