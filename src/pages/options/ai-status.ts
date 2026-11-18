// 设置页「AI 服务」一节的状态行：同一时间只有一条，带着落点，点哪里结果就写在哪里。
// 保存以后那句「存好了／还差什么」跟着数据同意的勾选重算，换成别的提示以后不再管；密钥框下面那句「还没有密钥」开始填就收起。
import { signal, type ReadonlySignal } from "@preact/signals";
import type { LoadedSettings } from "../../platform/settings-store.ts";
import { validate } from "../../shared/settings-schema.ts";

export type Tone = "ok" | "warn" | "error";

export interface Status {
  readonly text: string;
  readonly tone: Tone;
}

/**
 * 状态行落在哪个控件下面，不用滚到这一节最底下找。
 * actions 是「保存并授权」「测试连接」那一排按钮下面，也是别处没有专门位置时的落点。
 */
export type AiPlace = "key" | "remember" | "model" | "probe" | "efforts" | "chunk" | "actions";

export interface PlacedStatus extends Status {
  readonly at: AiPlace;
}

export interface AiStatus {
  readonly current: ReadonlySignal<PlacedStatus | null>;
  say(at: AiPlace, text: string, tone: Tone): void;
  /** 保存以后那句：都齐了说存好了，还差什么就说差什么。 */
  saySaved(at: AiPlace, written: LoadedSettings): void;
  /** 同意的勾选变了：眼前还是保存以后那句的话，按新的设置重算，不留着「请勾选我已了解」这种过时的话。 */
  consentChanged(written: LoadedSettings): void;
  /** 密钥框下面那句「还没有密钥」。 */
  sayKeyMissing(): void;
  /** 开始填密钥了：眼前还是那句「还没有密钥」的话就收起。 */
  keyTyped(): void;
  clear(): void;
}

export function createAiStatus(): AiStatus {
  const current = signal<PlacedStatus | null>(null);
  // 眼前这条是保存以后那句时，记着它的落点。
  let savedAt: AiPlace | null = null;
  // 眼前这条是密钥框下面那句「还没有密钥」。
  let keyNotice = false;

  function say(at: AiPlace, text: string, tone: Tone): void {
    savedAt = null;
    keyNotice = false;
    current.value = { text, tone, at };
  }

  function clear(): void {
    savedAt = null;
    keyNotice = false;
    current.value = null;
  }

  function saySaved(at: AiPlace, written: LoadedSettings): void {
    const ready = validate(written);
    if (ready.ok) say(at, written.rememberApiKey ? "已保存并授权，密钥已记在这台电脑上。" : "已保存并授权。", "ok");
    else say(at, `已保存并授权，但 AI 功能暂时用不了：${ready.errors.join(" ")}`, "warn");
    savedAt = at;
  }

  return {
    current,
    say,
    saySaved,
    consentChanged(written) {
      if (savedAt) saySaved(savedAt, written);
    },
    sayKeyMissing() {
      say("key", "这里还没有密钥：没勾「在这台电脑上记住密钥」时，重启浏览器或更新扩展以后要重新填。", "warn");
      keyNotice = true;
    },
    keyTyped() {
      if (keyNotice) clear();
    },
    clear,
  };
}
