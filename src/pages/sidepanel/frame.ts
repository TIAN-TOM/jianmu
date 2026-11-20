// 侧边栏里解释当前画面的数据：只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进包，只从 panel.ts 的开关分支引用。
// 结果记在后台，按标签页取；后台每一步都广播 frame.changed，这里收到就重读。只列当前视频的，新的在前；
// 关掉的那几条只在这个侧边栏里藏起来。播放页图标点出来的结果也在这里看。
import { computed, effect, signal, type ReadonlySignal } from "@preact/signals";
import { describe } from "../../core/errors.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { FrameEntryView } from "../../shared/messages/frame.ts";
import type { PageApi } from "../shared/api.ts";
import type { UiLang } from "../shared/ui-lang.ts";
import { frameText } from "./frame-text.ts";

export interface FrameTarget {
  readonly tabId: number | null;
  readonly video: VideoKey | null;
}

export interface FrameStore {
  /** 当前标签页、当前视频的几次解释，新的在前，不含关掉的。 */
  readonly entries: ReadonlySignal<readonly FrameEntryView[]>;
  /** 截当前一帧去解释；发不出去时回一句给用户看的话，发出去了回空串。 */
  explain(): Promise<string>;
  dismiss(id: string): void;
  stop(): void;
}

export interface FrameStoreDeps {
  readonly api: Pick<PageApi, "send" | "on">;
  readonly target: ReadonlySignal<FrameTarget>;
  readonly enabled: ReadonlySignal<boolean>;
  /** 回给用户的话用哪种语言写，缺省中文。 */
  readonly lang?: () => UiLang;
}

export function createFrameStore({ api, target, enabled, lang = () => "zh" }: FrameStoreDeps): FrameStore {
  const all = signal<readonly FrameEntryView[]>([]);
  const dismissed = signal<ReadonlySet<string>>(new Set());
  let generation = 0;

  async function reload(): Promise<void> {
    generation += 1;
    const asked = generation;
    const { tabId } = target.peek();
    if (!enabled.peek() || tabId === null) {
      all.value = [];
      return;
    }
    const reply = await api.send("frame.recent", { tabId });
    if (asked !== generation) return;
    all.value = reply.ok ? reply.value.entries : [];
  }

  const offChanged = api.on("frame.changed", ({ tabId }) => {
    if (tabId === target.peek().tabId) void reload();
  });
  // 清除了本机数据：后台那边的解释也清掉了，跟着重读。
  const offCleared = api.on("data.cleared", () => void reload());
  // 换标签页或启用状态变了就重读；同一标签页里换视频不用重读，按视频筛就行。
  const tabKey = computed(() => (enabled.value ? target.value.tabId : null));
  const dispose = effect(() => {
    void tabKey.value;
    void reload();
  });

  return {
    entries: computed(() => {
      const { video } = target.value;
      const hidden = dismissed.value;
      return all.value.filter((entry) => entry.video === video && !hidden.has(entry.id));
    }),
    async explain() {
      const { tabId, video } = target.peek();
      if (tabId === null || video === null) return frameText(lang()).noVideo;
      const reply = await api.send("frame.explain", { tabId, video });
      if (!reply.ok) return describe(reply.code, reply.detail, lang());
      void reload();
      return "";
    },
    dismiss(id) {
      dismissed.value = new Set([...dismissed.peek(), id]);
    },
    stop() {
      generation += 1;
      offChanged();
      offCleared();
      dispose();
    },
  };
}
