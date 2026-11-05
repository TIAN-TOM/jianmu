// 笔记搜索：匹配正文、标题、作者、时间点和视频编号，不分大小写。
import { formatTimestamp } from "../transcript/segment.ts";
import { noteList, videoIdOf, type NoteFields, type NoteList } from "./records.ts";

export function filterNotes<T extends NoteFields>(notes: NoteList<T>, query: string | null | undefined): T[] {
  const list = noteList(notes);
  const needle = String(query || "").trim().toLowerCase();
  if (!needle) return list;
  return list.filter((note) => {
    const hay = [note.text, note.snapshot?.title, note.snapshot?.author, formatTimestamp(note.atSec), videoIdOf(note.video)]
      .map((value) => String(value || "").toLowerCase())
      .join("\n");
    return hay.includes(needle);
  });
}
