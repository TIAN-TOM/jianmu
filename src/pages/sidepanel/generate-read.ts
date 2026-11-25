// YouTube 一步生成：侧边栏上还没读到字幕时，「生成概览」先经视频页读字幕再生成，生成结束以后把读到的字幕从本机摆出来。
// 只从构建开关 FEATURE_YOUTUBE_OPEN_PANEL 的分支引用，开关关着时整个模块不进包，侧边栏照旧要先点「读取字幕」。
import { effect } from "@preact/signals";
import type { Follow } from "./follow.ts";
import type { OverviewStore } from "./overview.ts";
import { readsOnClick, type TranscriptState, type TranscriptStore } from "./transcript.ts";

/** 字幕这块停在这几种情况时，经视频页读一次就能好：还没读过；上次读碰上了广告。 */
const READ_AGAIN = ["NOT_CACHED", "PAGE_ACTION_NEEDED"];

const waitsForPage = (now: TranscriptState): boolean => now.state === "failed" && READ_AGAIN.includes(now.failure.code) && readsOnClick(now.video);

/** 点「生成概览」时要不要带上标签页，让后台先经视频页读字幕。 */
export const readsFirst = (now: TranscriptState, tabId: number | null): boolean => tabId !== null && waitsForPage(now);

/**
 * 概览任务一结束（存好了、模型报错了、用户停了都算），生成路上读到的字幕已经存进本机：字幕这块还停在读取提示上，就从本机摆出来，
 * 本机也没有就照旧摆提示。挂在侧边栏的状态上，不挂在速读视图里：生成途中切到精读，字幕照样补上。按任务结束算，不按点击返回：
 * 接上别处已经在跑的同一个任务时，点击马上返回，字幕那会儿还没读到。用户自己读字幕读到了别的结果，不在上面几种里，不去盖掉。
 */
export function refillAfterGenerate(overview: Pick<OverviewStore, "state">, transcript: Pick<TranscriptStore, "state" | "load">, follow: Pick<Follow, "target">): () => void {
  let lastTask: string | null = null;
  return effect(() => {
    const { task, video } = overview.state.value;
    const ended = lastTask !== null && task === null;
    lastTask = task?.id ?? null;
    if (!ended) return;
    const now = transcript.state.peek();
    const { tabId } = follow.target.peek();
    if (tabId === null || now.state !== "failed" || now.video !== video || !waitsForPage(now)) return;
    void transcript.load(now.video, tabId, { localOnly: true });
  });
}
