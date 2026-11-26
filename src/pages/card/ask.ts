// 卡片上的提问（PRD 第 6.5 节）：针对正在看的视频问一句，回答带能点的时间点。卡片只摆这一次的问答，历史在侧边栏。
// 问题随登记一起交，新起的换到一次性令牌，凭它开始；只认真实的提交。同一个问题别处正在答时接不上结果，照实说。
// 换了视频就作废：迟到的回答不摆。
import { signal } from "@preact/signals";
import { describe } from "../../core/errors.ts";
import type { QaRecord } from "../../core/notes/records.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { PageApi } from "../shared/api.ts";
import type { UiLang } from "../shared/ui-lang.ts";
import { cardTextOf } from "./text.ts";

export interface AskState {
  readonly phase: "idle" | "asking" | "done" | "failed";
  readonly question: string;
  /** 登记上的任务号，停止时用；还没登记上时是空串。 */
  readonly taskId: string;
  readonly canceling: boolean;
  readonly entry: QaRecord | null;
  /** 回答照常摆出来，但没存进问答历史。 */
  readonly unsaved: boolean;
  readonly error: string;
  /** 模型服务报错时自己说的话。 */
  readonly said: string;
}

export const ASK_IDLE: AskState = { phase: "idle", question: "", taskId: "", canceling: false, entry: null, unsaved: false, error: "", said: "" };

export interface CardAskDeps {
  readonly api: Pick<PageApi, "send">;
  /** 卡片这会儿认的视频。 */
  readonly video: () => VideoKey | null;
  readonly lang: () => UiLang;
}

export function createCardAsk({ api, video, lang }: CardAskDeps) {
  const state = signal<AskState>(ASK_IDLE);
  let generation = 0;
  const failed = (question: string, code: Parameters<typeof describe>[0], detail?: string, said?: string): void => {
    // 限频的通用说法写的是「生成」，提问这里换成提问自己的一句。
    const error = code === "CARD_RATE_LIMITED" ? cardTextOf(lang()).askTooFast : describe(code, detail, lang());
    state.value = { ...ASK_IDLE, phase: "failed", question, error, said: said ?? "" };
  };

  return {
    state,
    /** 换了视频、卡片关掉：这一次的问答不留，迟到的回答不摆。 */
    reset(): void {
      generation += 1;
      state.value = ASK_IDLE;
    },
    async ask(raw: string, trusted: boolean): Promise<void> {
      const question = raw.trim();
      const current = video();
      // 花的是用户的额度：卡片嵌在别人的页面里，只认真实的提交。
      if (!trusted || !question || !current || state.peek().phase === "asking") return;
      generation += 1;
      const mine = generation;
      state.value = { ...ASK_IDLE, phase: "asking", question };
      const started = await api.send("task.start", { kind: "qa", video: current, question });
      // 登记期间换了视频：新登记上的就取消掉，不留一个没人认领的任务。
      if (mine !== generation) {
        if (started.ok && !started.value.joined && started.value.token) await api.send("task.cancel", { taskId: started.value.task.id });
        return;
      }
      if (!started.ok) return failed(question, started.code, started.detail, started.said);
      const { task, joined, token } = started.value;
      if (joined || !token) {
        state.value = { ...ASK_IDLE, phase: "failed", question, error: cardTextOf(lang()).askJoined };
        return;
      }
      // 登记的回答回来之前就点了停止：登记上了再取消一次，不开始答。
      if (state.peek().canceling) {
        await api.send("task.cancel", { taskId: task.id });
        if (mine === generation) state.value = ASK_IDLE;
        return;
      }
      state.value = { ...state.peek(), taskId: task.id };
      const reply = await api.send("qa.ask", { video: current, token });
      if (mine !== generation) return;
      if (!reply.ok) {
        if (reply.code === "TASK_CANCELED") state.value = ASK_IDLE;
        else failed(question, reply.code, reply.detail, reply.said);
        return;
      }
      state.value = { ...ASK_IDLE, phase: "done", question, entry: reply.value.entry, unsaved: reply.value.historySaved === false };
    },
    async cancel(): Promise<void> {
      const now = state.peek();
      if (now.phase !== "asking" || now.canceling) return;
      state.value = { ...now, canceling: true };
      if (now.taskId) await api.send("task.cancel", { taskId: now.taskId });
    },
  };
}

export type CardAsk = ReturnType<typeof createCardAsk>;
