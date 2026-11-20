// 卡片收起的那一行上写什么：播放到的章节（隔一会儿问一次本页的播放器），和临时说的一句话（播满时长自动收起时说为什么）。
// 只在收着、侧边栏关着、已经有章节时才问播放位置，标签页不在前台时不问；那句话只在看得见时计时。
import { chapterAt, type ChapterStart } from "../shared/ui/chapters.ts";
import type { CardTimers } from "./timers.ts";

/** 收着时隔多久问一次播放位置：只用来写当前章节，到章这一级就够。 */
export const GLANCE_POLL_MS = 2_000;
/** 收起那一行上的一句话留多久。 */
export const HEAD_NOTE_MS = 6_000;
export const AUTO_FOLD_NOTE = "开始看了，先收起";
export const PANEL_REFUSED_NOTE = "请点工具栏上的简幕图标";

export interface GlanceState {
  /** 播放到的那一章在按开始时间排好的章节里的序号；不知道时是 null。 */
  readonly chapterNow: number | null;
  /** 临时说的一句话，没有时是空串。 */
  readonly headNote: string;
}

export interface GlanceDeps {
  readonly timers: Pick<CardTimers, "every" | "after">;
  /** 卡片所在的标签页在不在前台；不给时当一直在前台。 */
  readonly visible: () => boolean;
  /** 本页的播放器播到第几秒；问不到时是 null。不给就不写当前章节。 */
  readonly position: (() => Promise<number | null>) | null;
  /** 这会儿要不要写当前章节：收着、侧边栏关着。 */
  readonly wanted: () => boolean;
  /** 按开始时间排好的章节。 */
  readonly chapters: () => readonly ChapterStart[];
  readonly state: () => GlanceState;
  readonly set: (next: Partial<GlanceState>) => void;
}

export function createGlance({ timers, visible, position, wanted, chapters, state, set }: GlanceDeps) {
  let stopPolling: (() => void) | null = null;
  let asks = 0;
  let cancelNote: (() => void) | null = null;
  // 说话时、或者到点时标签页不在前台：回到前台再从头数。
  let noteWaitsForSight = false;

  async function read(): Promise<void> {
    if (!position || !visible()) return;
    asks += 1;
    const asked = asks;
    const at = await position();
    if (asked !== asks || !stopPolling) return;
    const index = chapterAt(chapters(), at);
    const next = index >= 0 ? index : null;
    if (next !== state().chapterNow) set({ chapterNow: next });
  }

  function say(text: string): void {
    cancelNote?.();
    cancelNote = null;
    noteWaitsForSight = false;
    if (text !== state().headNote) set({ headNote: text });
    if (!text) return;
    if (!visible()) {
      noteWaitsForSight = true;
      return;
    }
    cancelNote = timers.after(HEAD_NOTE_MS, () => {
      cancelNote = null;
      // 说完以后标签页切到了后台，到点时还没回来：这句话没被看够，先留着。
      if (!visible()) {
        noteWaitsForSight = true;
        return;
      }
      set({ headNote: "" });
    });
  }

  return {
    /** 卡片的样子变了：该问播放位置就开始问，不该问了就停、把当前章节抹掉。 */
    sync(): void {
      const want = position !== null && wanted() && chapters().length > 0;
      if (want === (stopPolling !== null)) return;
      if (want) {
        stopPolling = timers.every(GLANCE_POLL_MS, () => void read());
        void read();
        return;
      }
      stopPolling?.();
      stopPolling = null;
      asks += 1;
      if (state().chapterNow !== null) set({ chapterNow: null });
    },
    /** 在收起的那一行上说一句，过一会儿自己收回；空串是马上收回。 */
    say,
    /** 标签页回到前台：等着的那句话从现在开始数，当前章节马上问一次。 */
    seen(): void {
      if (noteWaitsForSight) say(state().headNote);
      if (stopPolling) void read();
    },
    stop(): void {
      stopPolling?.();
      stopPolling = null;
      cancelNote?.();
      cancelNote = null;
    },
  };
}
