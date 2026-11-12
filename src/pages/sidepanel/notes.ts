// 笔记页签的数据：本视频或全部笔记，跟着笔记广播重读；编辑、删除、从概览的金句存一条。
// 换了视频，旧视频的列表回复作废。
import { signal, type ReadonlySignal } from "@preact/signals";
import { describe } from "../../core/errors.ts";
import type { VideoKey } from "../../core/video-ref.ts";
import type { NoteItemView } from "../../shared/messages/notes.ts";
import type { PageApi } from "../shared/api.ts";

export type NotesScope = "video" | "all";

export interface NotesState {
  readonly video: VideoKey | null;
  readonly scope: NotesScope;
  readonly loaded: boolean;
  readonly notes: readonly NoteItemView[];
  readonly error: string;
}

export interface NotesStore {
  readonly state: ReadonlySignal<NotesState>;
  bind(video: VideoKey | null): void;
  setScope(scope: NotesScope): void;
  /** 存一条已经整理好的笔记（不再过模型）；回一句给用户看的结果。 */
  save(atSec: number, text: string): Promise<string>;
  update(id: string, text: string): Promise<string>;
  remove(id: string): Promise<string>;
  stop(): void;
}

/** 本视频的笔记按时间点排，全部笔记按最近改过的排。 */
export function sortNotes(notes: readonly NoteItemView[], scope: NotesScope): NoteItemView[] {
  return [...notes].sort(scope === "video" ? (a, b) => a.atSec - b.atSec : (a, b) => b.updatedAt - a.updatedAt);
}

export function createNotesStore({ api }: { readonly api: Pick<PageApi, "send" | "on"> }): NotesStore {
  const state = signal<NotesState>({ video: null, scope: "video", loaded: false, notes: [], error: "" });
  let generation = 0;
  const off = api.on("notes.changed", ({ video }) => {
    const now = state.peek();
    if (now.scope === "all" || video === undefined || video === now.video) void reload();
  });

  async function reload(): Promise<void> {
    generation += 1;
    const asked = generation;
    const { video, scope } = state.peek();
    if (scope === "video" && !video) {
      state.value = { ...state.peek(), loaded: true, notes: [], error: "" };
      return;
    }
    const reply = await api.send("notes.list", scope === "video" && video ? { video } : {});
    if (asked !== generation) return;
    state.value = reply.ok
      ? { ...state.peek(), loaded: true, notes: sortNotes(reply.value.notes, scope), error: "" }
      : { ...state.peek(), loaded: true, error: describe(reply.code, reply.detail) };
  }

  return {
    state,
    bind(video) {
      if (video === state.peek().video) return;
      state.value = { ...state.peek(), video, loaded: false, notes: state.peek().scope === "video" ? [] : state.peek().notes };
      void reload();
    },
    setScope(scope) {
      if (scope === state.peek().scope) return;
      state.value = { ...state.peek(), scope, loaded: false, notes: [] };
      void reload();
    },
    async save(atSec, text) {
      const video = state.peek().video;
      if (!video) return "";
      const reply = await api.send("notes.save", { video, atSec: Math.max(0, Math.floor(atSec)), text });
      if (!reply.ok) return describe(reply.code, reply.detail);
      void reload();
      return reply.value.duplicate ? "这个时间点已经有一条笔记" : "已存为笔记";
    },
    async update(id, text) {
      const reply = await api.send("notes.update", { id, text });
      if (!reply.ok) return describe(reply.code, reply.detail);
      void reload();
      return "";
    },
    async remove(id) {
      const reply = await api.send("notes.delete", { id });
      if (!reply.ok) return describe(reply.code, reply.detail);
      void reload();
      return "";
    },
    stop() {
      generation += 1;
      off();
    },
  };
}
