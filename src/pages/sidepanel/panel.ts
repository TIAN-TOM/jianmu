// 侧边栏的各块数据拼在一起：启用、配置、跟随的标签页、播放器、模式，速览、精读、问答和笔记的数据。
// 启用以后才跟着当前视频读取；换了视频，各块一起换，没启用或没有视频时全部清空。
// 问答抽屉和笔记层的开关和模式是两层：切模式不动抽屉，开抽屉也不切模式。
// 打开就出结论停下或恢复时重问一次配置，顶上那一行跟着变。
import { computed, effect, signal, type Signal } from "@preact/signals";
import type { Mode } from "../../core/mode/types.ts";
import type { PageApi } from "../shared/api.ts";
import { createActivation, type Activation } from "../shared/activation.ts";
import { createConfigWatch, type ConfigWatch } from "../shared/config.ts";
import { createWindowBatch, type WindowBatchStore } from "./batch.ts";
import { createFollow, type Follow } from "./follow.ts";
import { createFrameStore, type FrameStore } from "./frame.ts";
import { createModeStore, type ModeStore } from "./mode.ts";
import { createUndoLine, type UndoLine } from "./undo-line.ts";
import { createNotesStore, type NotesStore } from "./notes.ts";
import { createOverviewStore, type OverviewStore } from "./overview.ts";
import { createPlayer, playerFailureText, type Player } from "./player.ts";
import { createQaStore, type QaStore } from "./qa.ts";
import { createTranscriptStore, type TranscriptStore } from "./transcript.ts";
import { createTidy, createTranslation, type Tidy, type Translation } from "./translate.ts";

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
  readonly mode: ModeStore;
  /** 「已切到精读」那一行。 */
  readonly undoLine: UndoLine;
  /** 侧边栏这会儿在前台、看得见。 */
  readonly pageVisible: Signal<boolean>;
  readonly transcript: TranscriptStore;
  readonly translation: Translation;
  /** 整理字幕：补标点、改同音错字。 */
  readonly tidy: Tidy;
  readonly overview: OverviewStore;
  readonly notes: NotesStore;
  readonly qa: QaStore;
  /** 本窗口全部生成。 */
  readonly batch: WindowBatchStore;
  /** 解释当前画面，只在构建开关打开时有。 */
  readonly frame: FrameStore | null;
  /** 问答抽屉开着。 */
  readonly qaOpen: Signal<boolean>;
  /** 笔记层开着。 */
  readonly notesOpen: Signal<boolean>;
  readonly toast: Signal<Toast | null>;
  /** 主动切换模式：记住这个频道，记住了就说一声。 */
  chooseMode(mode: Mode): Promise<void>;
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
  const mode = createModeStore({ api });
  const undoLine = createUndoLine({ mode: mode.view });
  const pageVisible = signal(typeof document === "undefined" || document.visibilityState === "visible");
  const onVisibility = (): void => void (pageVisible.value = document.visibilityState === "visible");
  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
  const transcript = createTranscriptStore({ api });
  const translation = createTranslation({ api });
  const tidy = createTidy({ api });
  const overview = createOverviewStore({ api });
  const notes = createNotesStore({ api });
  const qa = createQaStore({ api });
  const batch = createWindowBatch({ api });
  const frame = FEATURE_FRAME_EXPLAIN ? createFrameStore({ api, target: follow.target, enabled: activation.enabled }) : null;
  const qaOpen = signal(false);
  const notesOpen = signal(false);
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
      mode.bind(enabled ? tabId : null, active);
      undoLine.bind(enabled && active && tabId !== null ? `${tabId}\n${active}` : null);
      overview.bind(active);
      notes.bind(active);
      qa.bind(active);
      if (active) void transcript.load(active, tabId);
      else transcript.clear();
    }),
    // 字幕换了版本，译文和整理结果跟着作废；整理过的这一版打开就用上。
    effect(() => {
      const now = transcript.state.value;
      if (now.state === "ready") {
        const { tabId } = follow.target.peek();
        translation.bind(now.video, now.view.transcript.ref.fingerprint, tabId);
        tidy.bind(now.video, now.view.transcript.ref.fingerprint, tabId);
      } else if (now.state !== "loading") {
        translation.bind(null, null);
        tidy.bind(null, null);
      }
    }),
    // 启用以后才连上批次端口，接上本窗口已有的一批。
    effect(() => batch.setEnabled(activation.enabled.value)),
    api.on("auto.changed", () => void config.check()),
    // 适配层读到的时长和频道报给观看会话，后台按频道偏好和时长定模式。
    effect(() => {
      const now = transcript.state.value;
      const current = (now.state === "ready" || now.state === "failed") && now.video === follow.target.value.video;
      const info = !current ? undefined : now.state === "ready" ? now.view.info : now.state === "failed" ? now.failure.info : undefined;
      mode.describe(info?.durationSec, info?.channel?.channelId);
    }),
    // 要跟着播放时才每秒问一次播放位置：精读（当前章节和「存笔记」没有字幕也要用），或者速览里还没有概览、下面接着字幕。
    effect(() => {
      const ready = transcript.state.value.state === "ready";
      const skimShowsTranscript = ready && mode.view.value.mode === "skim" && !overview.state.value.task && !overview.state.value.saved?.analysis?.chapters?.length;
      player.setPolling(activation.enabled.value && (mode.view.value.mode === "study" || skimShowsTranscript));
    }),
  ];

  void activation.load().then(() => follow.refresh());

  return {
    api,
    activation,
    config,
    follow,
    player,
    mode,
    undoLine,
    pageVisible,
    transcript,
    translation,
    tidy,
    overview,
    notes,
    qa,
    batch,
    frame,
    qaOpen,
    notesOpen,
    toast,
    say,
    async chooseMode(next) {
      const now = transcript.state.peek();
      const info = now.state === "ready" ? now.view.info : now.state === "failed" ? now.failure.info : undefined;
      const remembered = await mode.choose(next, info?.channel?.channelId);
      if (remembered) say(`已记住：${info?.author ? `${info.author}的视频` : "这个频道的视频"}以后先进${next === "study" ? "精读" : "速览"}`);
    },
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
      frame?.stop();
      activation.stop();
      config.stop();
      follow.stop();
      player.stop();
      mode.stop();
      undoLine.stop();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
      translation.stop();
      tidy.stop();
      overview.stop();
      notes.stop();
      qa.stop();
      batch.stop();
      api.stop();
    },
  };
}
