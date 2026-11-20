// 问答页签：针对当前视频提问，回答里的时间点能点就跳过去，下面列出引用的原句；历史可以删。换过字幕时，依据旧字幕的回答标「基于旧字幕」。
import { useState } from "preact/hooks";
import { splitAnswerByTimestamps } from "../../core/qa/citations.ts";
import { onOldTranscript, transcriptFingerprintOf, type QaRecord } from "../../core/notes/records.ts";
import { formatTimestamp } from "../../core/transcript/segment.ts";
import { Button, IconButton } from "../shared/ui/button.tsx";
import { ServiceSaid } from "../shared/ui/notice.tsx";
import { StateBlock } from "../shared/ui/state-block.tsx";
import { StaleTranscriptLine } from "../shared/ui/verdict-block.tsx";
import type { Panel } from "./panel.ts";
import { setupReason } from "../shared/config.ts";
import { sharedText } from "../shared/text.ts";
import { uiLang } from "../shared/ui-lang.ts";
import { panelText } from "./text.ts";

function Answer({ panel, entry }: { readonly panel: Panel; readonly entry: QaRecord }) {
  const clickable = new Set(entry.clickable);
  return (
    <p class="qa-answer">
      {splitAnswerByTimestamps(entry.answer).map((part, index) =>
        part.seconds !== undefined && clickable.has(part.seconds) ? (
          <button key={index} type="button" class="stamp" aria-label={sharedText().jumpTo(formatTimestamp(part.seconds))} onClick={() => void panel.seek(part.seconds ?? 0)}>
            {part.text}
          </button>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </p>
  );
}

function Entry({ panel, entry, unsaved, current }: { readonly panel: Panel; readonly entry: QaRecord; readonly unsaved: boolean; readonly current: string | null }) {
  const t = panelText().qa;
  return (
    <li class="qa-entry" data-id={entry.id}>
      <div class="qa-question">
        <span>{entry.question}</span>
        <IconButton icon="trash" label={t.delete} onClick={() => void panel.qa.remove(entry.id)} />
      </div>
      {onOldTranscript(transcriptFingerprintOf(entry.derived), current) ? <StaleTranscriptLine /> : null}
      <Answer panel={panel} entry={entry} />
      {entry.truncated ? <p class="note-line">{t.truncated}</p> : null}
      {unsaved ? <p class="note-line">{t.unsaved}</p> : null}
      {entry.citations.length > 0 ? (
        <ul class="citations" aria-label={t.citations}>
          {entry.citations.map((citation) => (
            <li key={citation.startSeconds}>
              <button type="button" class="stamp" aria-label={sharedText().jumpTo(formatTimestamp(citation.startSeconds))} onClick={() => void panel.seek(citation.startSeconds)}>
                {formatTimestamp(citation.startSeconds)}
              </button>
              <span class="citation-text">{citation.quote}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function QaTab({ panel }: { readonly panel: Panel }) {
  const [question, setQuestion] = useState("");
  const state = panel.qa.state.value;
  const config = panel.config.state.value;
  const ready = config.state === "checked" && config.view.ready;
  const transcript = panel.transcript.state.value;
  const transcriptReady = transcript.state === "ready";
  const current = transcript.state === "ready" ? transcript.view.transcript.ref.fingerprint : null;
  const p = panelText();
  const t = p.qa;
  const reason = !ready ? (setupReason(config, uiLang.value) ?? "") : !transcriptReady ? p.skim.needTranscript : "";
  const submit = (event: Event): void => {
    event.preventDefault();
    if (reason || !question.trim()) return;
    void panel.qa.ask(question);
    setQuestion("");
  };
  return (
    <div class="qa">
      <form class="qa-form" onSubmit={submit}>
        <input class="search-input" type="text" placeholder={t.placeholder} aria-label={t.ask} value={question} onInput={(event) => setQuestion(event.currentTarget.value)} />
        <Button type="submit" variant="primary" disabled={Boolean(reason) || !question.trim()} {...(reason ? { disabledReason: reason } : {})}>
          {t.ask}
        </Button>
      </form>
      <p class="qa-hint">{t.hint}</p>
      {state.error ? (
        <p class="error-line" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.error ? <ServiceSaid said={state.errorSaid} /> : null}
      <ol class="qa-list">
        {state.pending.map((item) => (
          <li key={item.taskId} class="qa-entry" data-pending="true" role="status">
            <div class="qa-question">
              <span>{item.question}</span>
            </div>
            <p class="qa-answer">{t.answering}</p>
          </li>
        ))}
        {state.entries.map((entry) => (
          <Entry key={entry.id} panel={panel} entry={entry} unsaved={state.unsavedId === entry.id} current={current} />
        ))}
      </ol>
      {state.loaded && state.entries.length === 0 && state.pending.length === 0 ? (
        <StateBlock title={t.emptyTitle} impact={t.emptyImpact} />
      ) : null}
    </div>
  );
}
