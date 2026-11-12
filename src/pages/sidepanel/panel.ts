// 侧边栏的各块数据拼在一起：启用、配置、跟随的标签页、播放器，四个页签的数据。
// 启用以后才跟着当前视频读取；换了视频，各页签一起换，没启用或没有视频时全部清空。
import { computed, effect, signal, type Signal } from "@preact/signals";
import type { PageApi } from "../shared/api.ts";
import { createActivation, type Activation } from "../shared/activation.ts";
import { createConfigWatch, type ConfigWatch } from "../shared/config.ts";
import { createWindowBatch, type WindowBatchStore } from "./batch.ts";
import { createFollow, type Follow } from "./follow.ts";
import { createNotesStore, type NotesStore } from "./notes.ts";
import { createOverviewStore, type OverviewStore } from "./overview.ts";
import { createPlayer, playerFailureText, type Player } from "./player.ts";
import { createQaStore, type QaStore } from "./qa.ts";
import { createTranscriptStore, type TranscriptStore } from "./transcript.ts";
import { createTranslation, type Translation } from "./translate.ts";

export type TabId = "transcript" | "overview" | "notes" | "qa";

export interface Toast {
  readonly id: number;
  readonly text: string;
}

export interface Panel {
  readonly api: PageApi;
  readonly activation: Activation;
  readonly config: ConfigWatch;
  readonly follow: Follow;
  readonly player: Player;
  readonly transcript: TranscriptStore;
  readonly translation: Translation;
  readonly overview: OverviewStore;
  readonly notes: NotesStore;
  readonly qa: QaStore;
  /** 本窗口全部生成。 */
  readonly batch: WindowBatchStore;
  readonly tab: Signal<TabId>;
  readonly toast: Signal<Toast | null>;
  /** 一闪而过的一句提示：存好了、导出了、跳转失败的原因。 */
  say(text: string): void;
  /** 跳到当前视频的这一秒；跳不了时提示原因。 */
  seek(atSec: number): Promise<void>;
  openOptions(): void;
  stop(): void;
}

const TOAST_MS = 4000;

export function createPanel(api: PageApi, storageChanged?: Parameters<typeof createConfigWatch>[0]["storageChanged"]): Panel {
  const activation = createActivation({ api });
  const config = createConfigWatch({ api, enabled: activation.enabled, ...(storageChanged ? { storageChanged } : {}) });
  const follow = createFollow({ api, enabled: activation.enabled });
  const player = createPlayer();
  const transcript = createTranscriptStore({ api });
  const translation = createTranslation({ api });
  const overview = createOverviewStore({ api });
  const notes = createNotesStore({ api });
  const qa = createQaStore({ api });
  const batch = createWindowBatch({ api });
  const tab = signal<TabId>("transcript");
  const toast = signal<Toast | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let toastId = 0;

  const say = (text: string): void => {
    if (!text) return;
    toastId += 1;
    toast.value = { id: toastId, text };
    if (toastTimer !== null) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.value = null), TOAST_MS);
  };

  // 当前视频：没启用时一律当没有视频，不读取。只改了标题不算换视频。
  const current = computed(() => {
    const { tabId, video } = follow.target.value;
    return activation.enabled.value ? `${tabId ?? ""}\n${video ?? ""}` : "";
  });

  const disposers = [
    effect(() => {
      const enabled = current.value !== "";
      const { tabId, video } = follow.target.peek();
      const active = enabled ? video : null;
      player.watch(enabled ? tabId : null, active);
      overview.bind(active);
      notes.bind(active);
      qa.bind(active);
      if (active) void transcript.load(active, tabId);
      else transcript.clear();
    }),
    // 字幕换了版本，译文跟着作废。
    effect(() => {
      const now = transcript.state.value;
      if (now.state === "ready") translation.bind(now.video, now.view.transcript.ref.fingerprint);
      else if (now.state !== "loading") translation.bind(null, null);
    }),
    // 启用以后才连上批次端口，接上本窗口已有的一批。
    effect(() => batch.setEnabled(activation.enabled.value)),
    // 字幕页签开着时才每秒问一次播放位置。
    effect(() => {
      player.setPolling(activation.enabled.value && tab.value === "transcript" && transcript.state.value.state === "ready");
    }),
  ];

  void activation.load().then(() => follow.refresh());

  return {
    api,
    activation,
    config,
    follow,
    player,
    transcript,
    translation,
    overview,
    notes,
    qa,
    batch,
    tab,
    toast,
    say,
    async seek(atSec) {
      const { tabId, video } = follow.target.peek();
      if (tabId === null || video === null) return;
      const reply = await player.send(tabId, "player.seek", { video, atSec: Math.max(0, atSec) });
      if (!reply.ok) say(playerFailureText(reply.code));
    },
    openOptions() {
      void api.send("options.open", {}).then((reply) => {
        if (!reply.ok) say("打不开设置页，可以在扩展管理里打开简幕的选项。");
      });
    },
    stop() {
      for (const dispose of disposers) dispose();
      activation.stop();
      config.stop();
      follow.stop();
      player.stop();
      translation.stop();
      overview.stop();
      notes.stop();
      qa.stop();
      batch.stop();
      api.stop();
    },
  };
}
