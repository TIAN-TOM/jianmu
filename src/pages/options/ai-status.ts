// 设置页「AI 服务」一节的状态行：同一时间只有一条，带着落点，点哪里结果就写在哪里。
// 保存以后那句「存好了／还差什么」跟着数据同意的勾选重算，换成别的提示以后不再管；密钥框下面那句「还没有密钥」开始填就收起。
import { signal, type ReadonlySignal } from "@preact/signals";
import type { LoadedSettings } from "../../platform/settings-store.ts";
import { validate } from "../../shared/settings-schema.ts";
import type { UiLang } from "../shared/ui-lang.ts";
import { textOf } from "./text.ts";

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
  /** 拉模型列表以后那句：拉取先保存过，照实说存好了没有、拉到几个；模型框里的型号不在列表里就提醒一句，不拦着用。 */
  sayFetched(at: AiPlace, written: LoadedSettings, ids: readonly string[]): void;
  /** 同意的勾选变了：眼前还是保存以后那句的话，按新的设置重算，不留着「请勾选我已了解」这种过时的话。 */
  consentChanged(written: LoadedSettings): void;
  /** 密钥框下面那句「还没有密钥」。 */
  sayKeyMissing(): void;
  /** 开始填密钥了：眼前还是那句「还没有密钥」的话就收起。 */
  keyTyped(): void;
  clear(): void;
}

/** lang：状态写出来时用哪种语言，缺省中文。 */
export function createAiStatus(lang: () => UiLang = () => "zh"): AiStatus {
  const t = () => textOf(lang()).status;
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
    const ready = validate(written, lang());
    if (ready.ok) say(at, written.rememberApiKey ? t().savedRemembered : t().saved, "ok");
    else say(at, t().savedNotReady(ready.errors.join(" ")), "warn");
    savedAt = at;
  }

  function sayFetched(at: AiPlace, written: LoadedSettings, ids: readonly string[]): void {
    if (!ids.length) {
      say(at, t().fetchedNone, "warn");
      return;
    }
    const head = t().fetchedHead(ids.length);
    const model = written.aiModel;
    if (!model) {
      say(at, t().fetchedPick(head), "warn");
      return;
    }
    const notes: string[] = [];
    if (!listed(ids, model)) notes.push(t().notListed(model));
    const ready = validate(written, lang());
    if (!ready.ok) notes.push(t().notReady(ready.errors.join(" ")));
    say(at, t().fetchedReady(head, notes), notes.length ? "warn" : "ok");
  }

  return {
    current,
    say,
    saySaved,
    sayFetched,
    consentChanged(written) {
      if (savedAt) saySaved(savedAt, written);
    },
    sayKeyMissing() {
      say("key", t().keyMissing, "warn");
      keyNotice = true;
    },
    keyTyped() {
      if (keyNotice) clear();
    },
    clear,
  };
}

// 同一个型号有带 models/ 前缀和不带两种写法，大小写也不讲究：只为提醒，宁可少报。
function listed(ids: readonly string[], model: string): boolean {
  const plain = (id: string): string => id.replace(/^models\//i, "").toLowerCase();
  const wanted = plain(model);
  return ids.some((id) => plain(id) === wanted);
}
