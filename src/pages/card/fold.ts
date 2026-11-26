// 卡片展开还是收起：跟着本标签页的观看会话和本窗口的侧边栏。用户在这个视频里手动展开收起过的为准；
// 否则侧边栏关着、又在速读才展开。侧边栏开着时同一份结论和章节已经摆在那边，卡片让位；精读也收起（短视频进精读，所以默认收起）。
// 播满时长自动切到的精读不算：卡片照速读摆，不在人看视频的时候自己收起来。
// 新视频的会话要等内容脚本报了时长才有：先收着等它定模式，等不到再按速读展开，短视频就不会先展开、读一次、再收起。
import type { CardOverride, SessionView } from "../../core/mode/types.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { PageApi } from "../shared/api.ts";
import type { CardTimers } from "./timers.ts";

/** 新视频的模式最多等这么久，等不到按速读展开。 */
export const SESSION_WAIT_MS = 2_000;

export interface FoldDeps {
  readonly api: Pick<PageApi, "send" | "on">;
  readonly after: CardTimers["after"];
  /** 卡片这会儿认的视频。 */
  readonly video: () => VideoKey | null;
  /** 卡片所在的窗口，还不知道时是 null。 */
  readonly windowId: () => number | null;
  /** 卡片这会儿是不是收着。 */
  readonly collapsed: () => boolean;
  /** 定下来了：按这个摆，展开的话接着读。 */
  readonly place: (collapsed: boolean) => void;
  /** 本窗口的侧边栏开了或关了。 */
  readonly panel: (open: boolean) => void;
}

export function createFold({ api, after, video, windowId, collapsed, place, panel }: FoldDeps) {
  // 这个视频的手动展开收起和模式，从会话里读。
  let override: CardOverride | null = null;
  // 让卡片收起的精读：自己选的、频道记住的、短视频的；播满时长自动切的不算。
  let study = false;
  let sessionAsk = 0;
  // 本窗口的侧边栏开着。问到之前当关着。
  let panelOpen = false;
  let panelAsk = 0;
  // 正在等新视频的会话定模式：这里是「不等了」的收尾，没在等时是 null。
  let stopWaiting: (() => void) | null = null;

  const wanted = (): boolean => (override ? override === "collapsed" : panelOpen || study);

  /** 按现在知道的模式、侧边栏和手动展开收起定下来。 */
  function decide(): void {
    stopWaiting?.();
    place(wanted());
  }

  function applySession(session: SessionView | null): void {
    if (!session || session.video !== video()) return;
    override = session.cardOverride ?? null;
    study = session.mode === "study" && session.modeSource !== "auto";
    if (!stopWaiting && wanted() === collapsed()) return;
    decide();
  }

  /** 读本标签页的会话：卡片只读得到自己所在的标签页。 */
  async function readSession(): Promise<void> {
    sessionAsk += 1;
    const asked = sessionAsk;
    const current = video();
    const reply = await api.send("session.get", {});
    if (asked !== sessionAsk || current !== video() || !reply.ok) return;
    applySession(reply.value.session);
  }

  function setPanelOpen(open: boolean): void {
    if (open === panelOpen) return;
    panelOpen = open;
    panel(open);
    // 还在等新视频的会话：等它定下来时一起算。
    if (video() && !stopWaiting && wanted() !== collapsed()) decide();
  }

  const subscriptions = [
    // 本视频的模式变了（侧边栏里切的、撤销自动切换的）：重读自己标签页的会话，别的标签页同一视频的不算。
    api.on("session.changed", ({ session }) => {
      if (session.video === video()) void readSession();
    }),
    // 本窗口的侧边栏开了或关了；别的窗口的不算。
    api.on("panel.changed", ({ windowId: changed, open }) => {
      if (changed !== windowId()) return;
      panelAsk += 1;
      setPanelOpen(open);
    }),
  ];

  return {
    /** 换了视频：手动展开收起和模式只管原来那个视频，都作废；还在等的也不等了。 */
    reset(): void {
      override = null;
      study = false;
      stopWaiting?.();
    },
    /** 新视频：先收着问会话，有了就按它的模式定；一直没有就等够了按现在知道的定。 */
    wait(): void {
      place(true);
      const cancel = after(SESSION_WAIT_MS, () => decide());
      stopWaiting = () => {
        cancel();
        stopWaiting = null;
      };
      void readSession();
    },
    /** 用户点了标题栏：以这一下为准，记进会话，直到换视频。 */
    async toggle(): Promise<void> {
      // 还在等会话时点了就不等了；在途的会话回复问的时候还没有这一下，也不算数。
      stopWaiting?.();
      sessionAsk += 1;
      const next = !collapsed();
      override = next ? "collapsed" : "expanded";
      place(next);
      const current = video();
      if (current) await api.send("card.setOverride", { video: current, value: override });
    },
    /** 问本窗口的侧边栏开没开，问不到当关着。等回复时来过广播、又问了一次，就不拿这次的回复盖：它可能是旧的。 */
    async readPanel(): Promise<void> {
      panelAsk += 1;
      const asked = panelAsk;
      const reply = await api.send("panel.state", {});
      if (asked === panelAsk) setPanelOpen(reply.ok && reply.value.open);
    },
    stop(): void {
      stopWaiting?.();
      for (const off of subscriptions) off();
    },
  };
}
