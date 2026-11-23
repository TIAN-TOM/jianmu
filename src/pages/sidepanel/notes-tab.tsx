// 笔记页签：本视频或全部笔记，按关键词筛；点时间跳过去（别的视频的笔记在新标签页打开），能改、能删、能导出 Markdown。
import { useState } from "preact/hooks";
import { hasMatch, splitMatches } from "../../core/highlight.ts";
import { formatTimestamp } from "../../core/transcript/segment.ts";
import type { NoteItemView } from "../../shared/messages/notes.ts";
import { Button } from "../shared/ui/button.tsx";
import { Menu } from "../shared/ui/menu.tsx";
import { StateBlock } from "../shared/ui/state-block.tsx";
import { copyText } from "./copy.ts";
import { downloadText, notesExport } from "./files.ts";
import type { NotesScope } from "./notes.ts";
import type { Panel } from "./panel.ts";
import { sharedText } from "../shared/text.ts";
import { uiLang } from "../shared/ui-lang.ts";
import { panelText } from "./text.ts";

const SCOPES: readonly NotesScope[] = ["video", "all"];

function matches(note: NoteItemView, needle: string): boolean {
  if (!needle) return true;
  return [note.text, note.quote ?? "", note.snapshot.title, note.snapshot.author].some((field) => hasMatch(splitMatches(field, needle)));
}

function highlighted(text: string, query: string) {
  return query ? splitMatches(text, query).map((part, index) => part.hit ? <mark key={index}>{part.text}</mark> : part.text) : text;
}

function NoteItem({ panel, note, showVideo, query }: { readonly panel: Panel; readonly note: NoteItemView; readonly showVideo: boolean; readonly query: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const here = note.video === panel.follow.target.value.video;
  const time = formatTimestamp(note.atSec);
  const p = panelText();
  const t = p.notes;
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
          <button type="button" class="stamp" aria-label={sharedText().jumpTo(time)} onClick={() => void panel.seek(note.atSec)}>
            {time}
          </button>
        ) : (
          <a class="stamp" href={note.url} target="_blank" rel="noreferrer">
            {time}
          </a>
        )}
        {showVideo && note.snapshot.title ? <span class="note-video" title={note.snapshot.title}>{highlighted(note.snapshot.title, query)}</span> : null}
        {showVideo && note.snapshot.author ? <span class="note-author" title={note.snapshot.author}>{highlighted(note.snapshot.author, query)}</span> : null}
        {note.polishing ? <span class="note-flag">{t.polishing}</span> : null}
        <Menu
          label={t.actions}
          items={[
            { label: t.copyText, onSelect: () => void copyText(panel, note.text) },
            { label: t.copyLink, onSelect: () => void copyText(panel, note.url) },
            { label: t.edit, onSelect: () => setDraft(note.text) },
            { label: t.delete, hint: t.deleteHint, danger: true, onSelect: () => void panel.notes.remove(note.id).then((problem) => panel.say(problem || panelText().notes.deleted)) },
          ]}
        />
      </div>
      {draft === null ? (
        <p class="note-text">{highlighted(note.text, query)}</p>
      ) : (
        <div class="note-edit">
          <textarea class="note-input" aria-label={t.content} value={draft} onInput={(event) => setDraft(event.currentTarget.value)} rows={4} />
          <span class="state-actions">
            <Button variant="primary" disabled={saving || !draft.trim()} onClick={() => void save()}>
              {t.save}
            </Button>
            <Button variant="text" onClick={() => setDraft(null)}>
              {p.cancel}
            </Button>
          </span>
        </div>
      )}
      {note.quote && note.quote !== note.text ? <blockquote class="note-quote">{highlighted(note.quote, query)}</blockquote> : null}
    </li>
  );
}

export function NotesTab({ panel }: { readonly panel: Panel }) {
  const [query, setQuery] = useState("");
  const state = panel.notes.state.value;
  const needle = query.trim();
  const shown = state.notes.filter((note) => matches(note, needle));
  const p = panelText();
  const t = p.notes;
  const exportNotes = (): void => {
    const title = state.scope === "video" ? (shown[0]?.snapshot.title ?? "") : t.allNotes;
    const file = notesExport(shown, { grouped: state.scope === "all", title }, uiLang.peek());
    if (!file) return panel.say(t.nothingToExport);
    downloadText(file.fileName, file.markdown, "text/markdown");
  };
  return (
    <div class="notes">
      <div class="toolbar">
        <span class="segmented" role="group" aria-label={t.scopeLabel}>
          {SCOPES.map((id) => (
            <button key={id} type="button" class="segment" aria-pressed={state.scope === id} onClick={() => panel.notes.setScope(id)}>
              {t.scopes[id]}
            </button>
          ))}
        </span>
        <span class="toolbar-actions">
          <span class="toolbar-count">{state.loaded ? t.count(shown.length) : ""}</span>
          <Button variant="text" onClick={exportNotes} disabled={shown.length === 0}>
            {t.exportMarkdown}
          </Button>
        </span>
      </div>
      <div class="search-row">
        <input class="search-input" type="search" placeholder={t.searchPlaceholder} aria-label={t.searchLabel} value={query} onInput={(event) => setQuery(event.currentTarget.value)} />
      </div>
      {state.error ? (
        <p class="error-line" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.loaded && shown.length === 0 ? (
        needle ? (
          <p class="empty-line">{p.notFound(needle)}</p>
        ) : (
          <StateBlock title={t.emptyTitle} impact={t.emptyImpact} />
        )
      ) : (
        <ol class="note-list">
          {shown.map((note) => (
            <NoteItem key={note.id} panel={panel} note={note} showVideo={state.scope === "all"} query={needle} />
          ))}
        </ol>
      )}
    </div>
  );
}
