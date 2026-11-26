// 卡片底部的提问：一行输入框，Enter 或「提问」发出；上面摆这一次的问题和回答，回答里落在送给模型的范围内的时间点能点着跳。
// 正在答时可以停止；规则在 ask.ts。
import { useEffect, useRef, useState } from "preact/hooks";
import { splitAnswerByTimestamps } from "../../core/qa/citations.ts";
import { formatTimestamp } from "../../core/transcript/segment.ts";
import { ServiceSaid } from "../shared/ui/notice.tsx";
import type { AskState } from "./ask.ts";
import { cardText } from "./text.ts";

/** 问题最长多少字：再长的不像是在卡片上随手问的。 */
const QUESTION_MAX = 500;

function Answer({ state, onSeek }: { readonly state: AskState; readonly onSeek: (atSec: number) => void }) {
  const entry = state.entry;
  if (!entry) return null;
  const t = cardText();
  const clickable = new Set(entry.clickable);
  return (
    <div class="card-answer" id="card-answer">
      <p class="card-question">{entry.question}</p>
      <p class="card-answer-text">
        {splitAnswerByTimestamps(entry.answer).map((part, index) =>
          part.seconds !== undefined && clickable.has(part.seconds) ? (
            <button key={index} type="button" class="card-stamp" aria-label={t.jumpTo(formatTimestamp(part.seconds))} onClick={() => onSeek(part.seconds ?? 0)}>
              {part.text}
            </button>
          ) : (
            <span key={index}>{part.text}</span>
          ),
        )}
      </p>
      {entry.truncated ? <p class="card-note">{t.answerTruncated}</p> : null}
      {state.unsaved ? <p class="card-note">{t.answerUnsaved}</p> : null}
    </div>
  );
}

export function CardAskBox({
  state,
  onAsk,
  onCancel,
  onSeek,
}: {
  readonly state: AskState;
  readonly onAsk: (question: string, event: { readonly isTrusted: boolean }) => void;
  readonly onCancel: () => void;
  readonly onSeek: (atSec: number) => void;
}) {
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const t = cardText();
  // 没发出去（限频、没设置好、别处在答）：把问题放回框里，不用重打。
  useEffect(() => {
    if (state.phase === "failed" && state.question) setDraft((now) => now || state.question);
  }, [state.phase, state.question]);
  const asking = state.phase === "asking";
  return (
    <section class="card-ask" aria-label={t.askLabel}>
      {state.phase === "done" ? <Answer state={state} onSeek={onSeek} /> : null}
      {asking ? (
        <div class="card-asking" role="status">
          <span>{state.canceling ? t.stopping : t.answering}</span>
          <button type="button" class="button" data-variant="text" disabled={state.canceling} onClick={onCancel}>
            {t.stop}
          </button>
        </div>
      ) : null}
      {state.phase === "failed" ? (
        <>
          <p class="card-status" data-tone="error" role="alert">
            {state.error}
          </p>
          <ServiceSaid said={state.said} />
        </>
      ) : null}
      <form
        class="card-ask-form"
        onSubmit={(event) => {
          event.preventDefault();
          // 只认真实的提交。按框里这会儿的字算：刚输入完马上按 Enter 时，状态里的草稿可能还没跟上，清的时候框也一起清。
          const question = input.current?.value ?? draft;
          if (!event.isTrusted || asking || !question.trim()) return;
          onAsk(question, event);
          setDraft("");
          if (input.current) input.current.value = "";
        }}
      >
        <input
          type="text"
          class="card-ask-input"
          id="card-ask-input"
          ref={input}
          aria-label={t.askLabel}
          placeholder={t.askPlaceholder}
          maxLength={QUESTION_MAX}
          value={draft}
          disabled={asking}
          onInput={(event) => setDraft(event.currentTarget.value)}
        />
        <button type="submit" class="button" data-variant="secondary" disabled={asking || !draft.trim()}>
          {t.ask}
        </button>
      </form>
    </section>
  );
}
