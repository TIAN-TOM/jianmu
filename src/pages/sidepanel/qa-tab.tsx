// 问答页签：针对当前视频提问，回答里的时间点能点就跳过去，下面列出引用的原句；历史可以删。
import { useState } from "preact/hooks";
import { splitAnswerByTimestamps } from "../../core/qa/citations.ts";
import type { QaRecord } from "../../core/notes/records.ts";
import { formatTimestamp } from "../../core/transcript/segment.ts";
import { Button, IconButton } from "../shared/ui/button.tsx";
import { StateBlock } from "../shared/ui/state-block.tsx";
import type { Panel } from "./panel.ts";

function Answer({ panel, entry }: { readonly panel: Panel; readonly entry: QaRecord }) {
  const clickable = new Set(entry.clickable);
  return (
    <p class="qa-answer">
      {splitAnswerByTimestamps(entry.answer).map((part, index) =>
        part.seconds !== undefined && clickable.has(part.seconds) ? (
          <button key={index} type="button" class="stamp" aria-label={`跳到 ${formatTimestamp(part.seconds)}`} onClick={() => void panel.seek(part.seconds ?? 0)}>
            {part.text}
          </button>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </p>
  );
}

function Entry({ panel, entry, unsaved }: { readonly panel: Panel; readonly entry: QaRecord; readonly unsaved: boolean }) {
  return (
    <li class="qa-entry" data-id={entry.id}>
      <div class="qa-question">
        <span>{entry.question}</span>
        <IconButton icon="trash" label="删除这条问答" onClick={() => void panel.qa.remove(entry.id)} />
      </div>
      <Answer panel={panel} entry={entry} />
      {entry.truncated ? <p class="note-line">回答被截断了，可能不完整。</p> : null}
      {unsaved ? <p class="note-line">这条回答没能存进问答历史。</p> : null}
      {entry.citations.length > 0 ? (
        <ul class="citations" aria-label="引用的字幕">
          {entry.citations.map((citation) => (
            <li key={citation.startSeconds}>
              <button type="button" class="stamp" aria-label={`跳到 ${formatTimestamp(citation.startSeconds)}`} onClick={() => void panel.seek(citation.startSeconds)}>
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
  const transcriptReady = panel.transcript.state.value.state === "ready";
  const reason = !ready ? "先在设置页设置 AI 服务" : !transcriptReady ? "要先读到字幕" : "";
  const submit = (event: Event): void => {
    event.preventDefault();
    if (reason || !question.trim()) return;
    void panel.qa.ask(question);
    setQuestion("");
  };
  return (
    <div class="qa">
      <form class="qa-form" onSubmit={submit}>
        <input class="search-input" type="text" placeholder="针对这个视频提问，Enter 发送" aria-label="提问" value={question} onInput={(event) => setQuestion(event.currentTarget.value)} />
        <Button type="submit" variant="primary" disabled={Boolean(reason) || !question.trim()} {...(reason ? { disabledReason: reason } : {})}>
          提问
        </Button>
      </form>
      <p class="qa-hint">每个问题单独回答，不带上前面的问答。追问时把问题写完整。</p>
      {state.error ? (
        <p class="error-line" role="alert">
          {state.error}
        </p>
      ) : null}
      <ol class="qa-list">
        {state.pending.map((item) => (
          <li key={item.taskId} class="qa-entry" data-pending="true" role="status">
            <div class="qa-question">
              <span>{item.question}</span>
            </div>
            <p class="qa-answer">正在字幕里找相关内容并回答…</p>
          </li>
        ))}
        {state.entries.map((entry) => (
          <Entry key={entry.id} panel={panel} entry={entry} unsaved={state.unsavedId === entry.id} />
        ))}
      </ol>
      {state.loaded && state.entries.length === 0 && state.pending.length === 0 ? (
        <StateBlock title="还没有问答" impact="模型先在字幕里找相关内容再回答，关键结论带时间点，点一下就跳回原处。" />
      ) : null}
    </div>
  );
}
