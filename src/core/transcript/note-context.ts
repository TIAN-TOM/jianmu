// 笔记上下文：在字幕里定位某个时刻，取出润色所需的前后文（字幕一行往往只是半句话）。
export interface NoteContextEntry {
  readonly start: number;
  readonly text: string;
}

export interface NoteContext {
  index: number;
  targetText: string;
  beforeText: string;
  afterText: string;
  fullContext: string;
}

export function noteContextAt(
  transcript: readonly NoteContextEntry[] | null | undefined,
  timestamp: number | null | undefined,
): NoteContext | null {
  const entries: readonly NoteContextEntry[] = Array.isArray(transcript) ? transcript : [];
  if (!entries.length) return null;

  const target = Math.max(0, Math.floor(Number(timestamp) || 0));
  let index = entries.findIndex((entry, i) => {
    const next = entries[i + 1];
    return entry.start <= target && (!next || next.start > target);
  });
  // findIndex 返回 -1 只发生在目标早于第一句字幕时（晚于结尾能正常命中最后一行），此时落在第一行。
  if (index === -1) index = 0;

  const join = (from: number, to: number): string =>
    entries
      .slice(Math.max(0, from), Math.min(entries.length, to))
      .map((entry) => entry.text)
      .filter(Boolean)
      .join(" ");

  // index 一定在范围内，这一句只为收窄类型。
  const entry = entries[index];
  if (entry === undefined) return null;

  return {
    index,
    targetText: entry.text,
    beforeText: join(index - 2, index),
    afterText: join(index + 1, index + 5),
    fullContext: join(index - 8, index + 13),
  };
}
