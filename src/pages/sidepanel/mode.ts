// 侧边栏的模式：读本标签页的观看会话，跟着后台的会话广播换。适配层读到的时长和频道报给后台，后台据此按频道偏好和时长定模式；
// 回复到之前先按时长显示一个。只有主动点模式切换才发 session.setMode 并记住频道；撤销自动切换另走一条，不记频道。
// 模式的规则不在这里算，这里只在会话没到时用同一条打开规则先顶着。
import { computed, signal, type ReadonlySignal } from "@preact/signals";
import { openingMode } from "../../core/mode/decide.ts";
import type { Mode, ModeSource, SessionView } from "../../core/mode/types.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { PageApi } from "../shared/api.ts";

export interface ModeView {
  readonly mode: Mode;
  readonly source: ModeSource;
  /** 这次观看自动切过，撤销了也算。 */
  readonly autoSwitched: boolean;
}

export interface ModeStore {
  readonly view: ReadonlySignal<ModeView>;
  /** 跟着的标签页和视频；换了就重读会话，没有视频时传 null。 */
  bind(tabId: number | null, video: VideoKey | null): void;
  /** 适配层读到的时长和频道编号：会话还没到时按时长先定模式，同时报给后台；不知道的传 undefined。 */
  describe(durationSec: number | undefined, channelId?: string): void;
  /** 主动切换：立刻换，记进会话并记住频道。回 true 表示记住了这个频道。 */
  choose(mode: Mode, channelId?: string): Promise<boolean>;
  /** 撤销自动切换，回到打开时的模式。 */
  undo(): Promise<void>;
  stop(): void;
}

interface Bound {
  readonly tabId: number;
  readonly video: VideoKey;
}

export function createModeStore({ api }: { readonly api: Pick<PageApi, "send" | "on"> }): ModeStore {
  const bound = signal<Bound | null>(null);
  const session = signal<SessionView | null>(null);
  const duration = signal<number | undefined>(undefined);
  // 刚点的切换：后台的回复到之前先这样显示，后台没存成也照样按用户选的显示。
  const chosen = signal<Mode | null>(null);
  let generation = 0;
  // 收到过几次会话广播：请求发出以后来过广播，回复里的会话可能比广播旧，不拿它盖。
  let updates = 0;
  // 报给后台的视频信息：后台那边会话还是上一个视频时会被拒，等这个视频的会话到了再报一次。
  let described: { readonly durationSec?: number; readonly channelId?: string } | null = null;
  // 后台因为会话还是上一个视频而拒了这次报的信息。
  let describeRejected = false;

  const isCurrent = (tabId: number, view: SessionView): boolean => {
    const now = bound.peek();
    return now !== null && now.tabId === tabId && now.video === view.video;
  };

  const view = computed<ModeView>(() => {
    const picked = chosen.value;
    const current = session.value;
    if (picked) return { mode: picked, source: "manual", autoSwitched: current?.autoSwitched ?? false };
    if (current) return { mode: current.mode, source: current.modeSource, autoSwitched: current.autoSwitched };
    // 会话还没开：播放页还没报时长，或者这一页没连上简幕。频道偏好要等会话开了才知道。
    const opening = openingMode({ durationSec: duration.value });
    return { mode: opening.mode, source: opening.source, autoSwitched: false };
  });

  async function load(target: Bound, asked: number): Promise<void> {
    const reply = await api.send("session.get", { tabId: target.tabId });
    if (asked !== generation || !reply.ok || !reply.value.session) return;
    // 广播比回复先到时以广播为准：回复里的可能是旧的。
    if (session.peek() === null && isCurrent(target.tabId, reply.value.session)) session.value = reply.value.session;
  }

  async function sendDescribe(asked: number): Promise<void> {
    const target = bound.peek();
    const info = described;
    if (!target || !info || (info.durationSec === undefined && info.channelId === undefined)) return;
    const seen = updates;
    const reply = await api.send("session.describe", {
      tabId: target.tabId,
      video: target.video,
      ...(info.durationSec === undefined ? {} : { durationSec: info.durationSec }),
      ...(info.channelId === undefined ? {} : { channel: info.channelId }),
    });
    if (asked !== generation || info !== described) return;
    if (!reply.ok) {
      if (reply.code !== "VIDEO_CHANGED") return;
      // 等的时候这个视频的会话已经到了，马上再报；没到就等它的广播。
      if (seen !== updates) void sendDescribe(asked);
      else describeRejected = true;
      return;
    }
    if (seen === updates && isCurrent(target.tabId, reply.value.session)) session.value = reply.value.session;
  }

  const off = api.on("session.changed", ({ tabId, session: next }) => {
    if (!isCurrent(tabId, next)) return;
    updates += 1;
    session.value = next;
    if (described && describeRejected) {
      describeRejected = false;
      void sendDescribe(generation);
    }
  });

  return {
    view,
    bind(tabId, video) {
      const now = bound.peek();
      const next = tabId !== null && video !== null ? { tabId, video } : null;
      if (now?.tabId === next?.tabId && now?.video === next?.video) return;
      generation += 1;
      bound.value = next;
      session.value = null;
      chosen.value = null;
      duration.value = undefined;
      described = null;
      describeRejected = false;
      if (next) void load(next, generation);
    },
    describe(durationSec, channelId) {
      const known = durationSec !== undefined && Number.isFinite(durationSec) && durationSec > 0 ? durationSec : undefined;
      duration.value = known;
      if (described?.durationSec === known && described?.channelId === channelId) return;
      described = { ...(known === undefined ? {} : { durationSec: known }), ...(channelId === undefined ? {} : { channelId }) };
      describeRejected = false;
      void sendDescribe(generation);
    },
    async choose(mode, channelId) {
      const target = bound.peek();
      if (!target || view.peek().mode === mode) return false;
      const asked = generation;
      const seen = updates;
      chosen.value = mode;
      const reply = await api.send("session.setMode", {
        tabId: target.tabId,
        video: target.video,
        intent: "manual",
        mode,
        ...(channelId ? { channel: channelId } : {}),
      });
      if (asked !== generation || !reply.ok) return false;
      // 后台已经记下这次选的：以后按会话显示。期间来过广播就用广播里的，不拿回复盖。
      if (seen === updates && isCurrent(target.tabId, reply.value.session)) session.value = reply.value.session;
      if (chosen.peek() === mode) chosen.value = null;
      return reply.value.remembered;
    },
    async undo() {
      const target = bound.peek();
      if (!target || view.peek().source !== "auto") return;
      const asked = generation;
      const seen = updates;
      const reply = await api.send("session.setMode", { tabId: target.tabId, video: target.video, intent: "undo-auto" });
      if (asked === generation && seen === updates && reply.ok && isCurrent(target.tabId, reply.value.session)) session.value = reply.value.session;
    },
    stop() {
      off();
    },
  };
}
