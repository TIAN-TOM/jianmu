// 笔记页签：本视频或全部笔记，按关键词筛；点时间跳过去（别的视频的笔记在新标签页打开），能改、能删、能导出 Markdown。
import { useState } from "preact/hooks";
import { hasMatch, splitMatches } from "../../core/highlight.ts";
import { notesAsMarkdown } from "../../core/notes/markdown.ts";
import { formatTimestamp } from "../../core/transcript/segment.ts";
import type { NoteItemView } from "../../shared/messages/notes.ts";
import { Button } from "../shared/ui/button.tsx";
import { Menu } from "../shared/ui/menu.tsx";
import { StateBlock } from "../shared/ui/state-block.tsx";
import { downloadText, safeFileName, videoBaseOf } from "./files.ts";
import type { NotesScope } from "./notes.ts";
import type { Panel } from "./panel.ts";

const SCOPES: readonly { readonly id: NotesScope; readonly label: string }[] = [
  { id: "video", label: "本视频" },
  { id: "all", label: "全部" },
];

function matches(note: NoteItemView, needle: string): boolean {
  if (!needle) return true;
  return [note.text, note.quote ?? "", note.snapshot.title, note.snapshot.author].some((field) => hasMatch(splitMatches(field, needle)));
}

function NoteItem({ panel, note, showVideo }: { readonly panel: Panel; readonly note: NoteItemView; readonly showVideo: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const here = note.video === panel.follow.target.value.video;
  const time = formatTimestamp(note.atSec);
  const save = async (): Promise<void> => {
    if (draft === null) return;
    setSaving(true);
    const problem = await panel.notes.update(note.id, draft);
    setSaving(false);
    if (problem) panel.say(problem);
    else setDraft(null);
  };
  return (
    <li class="note" data-id={note.id}>
      <div class="note-head">
        {here ? (
          <button type="button" class="stamp" aria-label={`跳到 ${time}`} onClick={() => void panel.seek(note.atSec)}>
            {time}
          </button>
        ) : (
          <a class="stamp" href={note.url} target="_blank" rel="noreferrer">
            {time}
          </a>
        )}
        {showVideo ? <span class="note-video">{note.snapshot.title}</span> : null}
        {note.polishing ? <span class="note-flag">正在整理</span> : null}
        <Menu
          label="笔记操作"
          items={[
            { label: "编辑", onSelect: () => setDraft(note.text) },
            { label: "删除", hint: "删了找不回来", danger: true, onSelect: () => void panel.notes.remove(note.id).then((problem) => panel.say(problem || "已删除这条笔记")) },
          ]}
        />
      </div>
      {draft === null ? (
        <p class="note-text">{note.text}</p>
      ) : (
        <div class="note-edit">
          <textarea class="note-input" aria-label="笔记内容" value={draft} onInput={(event) => setDraft(event.currentTarget.value)} rows={4} />
          <span class="state-actions">
            <Button variant="primary" disabled={saving || !draft.trim()} onClick={() => void save()}>
              保存
            </Button>
            <Button variant="text" onClick={() => setDraft(null)}>
              取消
            </Button>
          </span>
        </div>
      )}
      {note.quote && note.quote !== note.text ? <blockquote class="note-quote">{note.quote}</blockquote> : null}
    </li>
  );
}

export function NotesTab({ panel }: { readonly panel: Panel }) {
  const [query, setQuery] = useState("");
  const state = panel.notes.state.value;
  const needle = query.trim();
  const shown = state.notes.filter((note) => matches(note, needle));
  const exportNotes = (): void => {
    const markdown = notesAsMarkdown(shown, videoBaseOf(state.video ?? shown[0]?.video ?? null), { grouped: state.scope === "all" });
    if (!markdown) return panel.say("没有可以导出的笔记");
    const title = state.scope === "video" ? (shown[0]?.snapshot.title ?? "") : "全部笔记";
    downloadText(`${safeFileName(title, "笔记")}.md`, markdown, "text/markdown");
  };
  return (
    <div class="notes">
      <div class="toolbar">
        <span class="segmented" role="group" aria-label="笔记范围">
          {SCOPES.map(({ id, label }) => (
            <button key={id} type="button" class="segment" aria-pressed={state.scope === id} onClick={() => panel.notes.setScope(id)}>
              {label}
            </button>
          ))}
        </span>
        <span class="toolbar-actions">
          <span class="toolbar-count">{state.loaded ? `${shown.length} 条` : ""}</span>
          <Button variant="text" onClick={exportNotes} disabled={shown.length === 0}>
            导出 Markdown
          </Button>
        </span>
      </div>
      <div class="search-row">
        <input class="search-input" type="search" placeholder="搜索笔记、标题或 UP 主" aria-label="搜索笔记" value={query} onInput={(event) => setQuery(event.currentTarget.value)} />
      </div>
      {state.error ? (
        <p class="error-line" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.loaded && shown.length === 0 ? (
        needle ? (
          <p class="empty-line">没有找到「{needle}」</p>
        ) : (
          <StateBlock title="还没有笔记" impact="在概览里把金句存为笔记；视频页上的笔记按钮也会记到这里。" />
        )
      ) : (
        <ol class="note-list">
          {shown.map((note) => (
            <NoteItem key={note.id} panel={panel} note={note} showVideo={state.scope === "all"} />
          ))}
        </ol>
      )}
    </div>
  );
}
