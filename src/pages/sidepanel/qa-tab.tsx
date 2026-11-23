// 问答页签：针对当前视频提问，回答里的时间点能点就跳过去，下面列出引用的原句；历史可以删。换过字幕时，依据旧字幕的回答标「基于旧字幕」。
import { useState } from "preact/hooks";
import { splitAnswerByTimestamps } from "../../core/qa/citations.ts";
import { onOldTranscript, transcriptFingerprintOf, type QaRecord } from "../../core/notes/records.ts";
import { formatTimestamp } from "../../core/transcript/segment.ts";
import { Button, IconButton } from "../shared/ui/button.tsx";
import { ServiceSaid } from "../shared/ui/notice.tsx";
import { StateBlock } from "../shared/ui/state-block.tsx";
import { StaleTranscriptLine } from "../shared/ui/verdict-block.tsx";
import { answerCopyText, copyText } from "./copy.ts";
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
        <span class="toolbar-actions">
          <IconButton icon="copy" label={t.copyAnswer} onClick={() => void copyText(panel, answerCopyText(entry.answer))} />
          <IconButton icon="trash" label={t.delete} onClick={() => void panel.qa.remove(entry.id)} />
        </span>
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

/** 眼下不能提问的原因：AI 服务没设置好、还没读到字幕；能问时是空串。底部的提问框和问答抽屉共用这一份判断。 */
export function askReason(panel: Panel): string {
  const config = panel.config.state.value;
  if (!(config.state === "checked" && config.view.ready)) return setupReason(config, uiLang.value) ?? "";
  return panel.transcript.state.value.state === "ready" ? "" : panelText().skim.needTranscript;
}

/** 这个问题眼下发得出去：没有不能问的原因，问题也不是空的。 */
export const canSend = (reason: string, question: string): boolean => !reason && Boolean(question.trim());

export function QaTab({ panel }: { readonly panel: Panel }) {
  const [question, setQuestion] = useState("");
  const state = panel.qa.state.value;
  const transcript = panel.transcript.state.value;
  const current = transcript.state === "ready" ? transcript.view.transcript.ref.fingerprint : null;
  const t = panelText().qa;
  const reason = askReason(panel);
  const submit = (event: Event): void => {
    event.preventDefault();
    if (!canSend(reason, question)) return;
    void panel.qa.ask(question);
    setQuestion("");
  };
  return (
    <div class="qa">
      <form class="qa-form" onSubmit={submit}>
        {/* 抽屉打开时焦点直接进这个框，不停在关闭按钮上。 */}
        <input class="search-input" type="text" autoFocus placeholder={t.placeholder} aria-label={t.ask} value={question} onInput={(event) => setQuestion(event.currentTarget.value)} />
        <Button type="submit" variant="primary" disabled={!canSend(reason, question)} {...(reason ? { disabledReason: reason } : {})}>
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
        <StateBlock title={t.emptyTitle} />
      ) : null}
    </div>
  );
}
