// 设置页探一次画面分析的模型能不能看图：只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进包，只从开关分支引用。
// 发的是一张 8×8 的小图，结果记在本机；解释当前画面时说不准也会自己探一次，这里是让用户先知道。
import type { Failure } from "../../core/errors.ts";
import type { PageApi } from "../shared/api.ts";
import type { UiLang } from "../shared/ui-lang.ts";
import { frameText } from "./frame-text.ts";

export interface ProbeStatus {
  readonly text: string;
  readonly tone: "ok" | "warn" | "error";
}

/** 探一次，交回给状态行看的一句话。 */
export async function probeFrameImage(api: Pick<PageApi, "send">, failureText: (failure: Failure) => string, lang: UiLang): Promise<ProbeStatus> {
  const t = frameText(lang);
  const reply = await api.send("ai.probeImage", {});
  if (!reply.ok) return { text: t.probeFailed(failureText(reply)), tone: "error" };
  const { model, imageInput } = reply.value;
  return imageInput
    ? { text: t.canSee(model), tone: "ok" }
    : { text: t.cannotSee(model), tone: "warn" };
}
