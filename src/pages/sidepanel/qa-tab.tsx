// 问答页签：针对当前视频提问，回答里的时间点能点就跳过去，下面列出引用的原句；复制回答和删除收在每条的「⋯」菜单里，和笔记一样。
// 换过字幕时，依据旧字幕的回答标「基于旧字幕」。删掉的那一条淡掉、收起，下面的跟着顶上来（shared/ui/list-exit.ts）。
// 输入框和底部的提问框共用一份草稿。AI 服务没设置好时，提问按钮的位置是「打开设置」，原因写在它下面。
import { splitAnswerByTimestamps } from "../../core/qa/citations.ts";
import { onOldTranscript, transcriptFingerprintOf, type QaRecord } from "../../core/notes/records.ts";
import { formatTimestamp } from "../../core/transcript/segment.ts";
import { Button } from "../shared/ui/button.tsx";
import { useListExit, type ExitRowProps } from "../shared/ui/list-exit.ts";
import { Menu } from "../shared/ui/menu.tsx";
import { ServiceSaid } from "../shared/ui/notice.tsx";
import { StateBlock } from "../shared/ui/state-block.tsx";
import { StaleTranscriptLine } from "../shared/ui/verdict-block.tsx";
import { answerCopyText, copyText } from "./copy.ts";
import type { Panel } from "./panel.ts";
import { SettingsExit } from "./settings-exit.tsx";
import { needsSetup, setupReason } from "../shared/config.ts";
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

function Entry({ panel, entry, unsaved, current, row, onDelete }: { readonly panel: Panel; readonly entry: QaRecord; readonly unsaved: boolean; readonly current: string | null; readonly row: ExitRowProps; readonly onDelete: () => void }) {
  const t = panelText().qa;
  return (
    <li class="qa-entry" data-id={entry.id} {...row}>
      <div class="qa-question">
        <span>{entry.question}</span>
        <Menu
          label={t.actions}
          items={[
            { label: t.copyAnswer, onSelect: () => void copyText(panel, answerCopyText(entry.answer)) },
            { label: t.delete, hint: panelText().notes.deleteHint, danger: true, onSelect: onDelete },
          ]}
        />
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
  const question = panel.draft.value;
  const state = panel.qa.state.value;
  const transcript = panel.transcript.state.value;
  const current = transcript.state === "ready" ? transcript.view.transcript.ref.fingerprint : null;
  const t = panelText().qa;
  const reason = askReason(panel);
  const setup = needsSetup(panel.config.state.value);
  const exit = useListExit(state.entries, (entry) => entry.id);
  const remove = (id: string): void => {
    exit.expect(id);
    void panel.qa.remove(id).then((removed) => {
      if (!removed) return exit.cancel(id);
      panel.say(panelText().qa.deleted);
    });
  };
  const submit = (event: Event): void => {
    event.preventDefault();
    if (!canSend(reason, question)) return;
    void panel.qa.ask(question);
    panel.draft.value = "";
  };
  return (
    <div class="qa">
      <form class="qa-form" onSubmit={submit}>
        {/* 抽屉打开时焦点直接进这个框，不停在关闭按钮上。 */}
        <input class="search-input" type="text" autoFocus placeholder={t.placeholder} aria-label={t.ask} value={question} onInput={(event) => (panel.draft.value = event.currentTarget.value)} />
        {setup ? (
          <Button variant="primary" note={reason} onClick={() => panel.openSettingsAt("ai-service")}>
            {panelText().openSettings}
          </Button>
        ) : (
          <Button type="submit" variant="primary" disabled={!canSend(reason, question)} {...(reason ? { disabledReason: reason } : {})}>
            {t.ask}
          </Button>
        )}
      </form>
      <p class="qa-hint">{t.hint}</p>
      {state.error ? (
        <p class="error-line" role="alert">
          {state.error}
        </p>
      ) : null}
      {state.error ? <ServiceSaid said={state.errorSaid} /> : null}
      {state.error ? <SettingsExit panel={panel} code={state.errorCode} /> : null}
      <ol class="qa-list exit-list">
        {state.pending.map((item) => (
          <li key={item.taskId} class="qa-entry" data-pending="true" role="status">
            <div class="qa-question">
              <span>{item.question}</span>
            </div>
            <p class="qa-answer">{t.answering}</p>
          </li>
        ))}
        {exit.rows.map((row) => (
          <Entry key={row.key} panel={panel} entry={row.item} unsaved={state.unsavedId === row.key} current={current} row={exit.rowProps(row)} onDelete={() => remove(row.key)} />
        ))}
      </ol>
      {state.loaded && exit.rows.length === 0 && state.pending.length === 0 ? (
        <StateBlock title={t.emptyTitle} />
      ) : null}
    </div>
  );
}
