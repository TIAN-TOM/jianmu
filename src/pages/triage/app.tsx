// 稍后再看粗筛页：读取列表、第一步取官方总结、第二步写一句话结论、按判断分组筛选、导出 Markdown。
// 没确认启用时给一个去设置页启用的按钮，这一页不能确认。状态和动作都在 state.ts，这里只渲染。
// 第二步没有可写的视频时不摆按钮，只说为什么；「关掉这个页面……」是费用提示，只在有步骤在跑或在等确认时显示。
import { hasOfficialContent, isOfficialDone } from "../../core/triage/batch.ts";
import { formatDuration, progressText } from "../../core/triage/export.ts";
import { GROUPS, groupItems, groupKeyOf, groupName, hasVerdict, type TriageVerdict } from "../../core/triage/groups.ts";
import type { TriageItem } from "../../core/triage/state.ts";
import type { Activation } from "../shared/activation.ts";
import { Button } from "../shared/ui/button.tsx";
import { ServiceSaid } from "../shared/ui/notice.tsx";
import { StateBlock } from "../shared/ui/state-block.tsx";
import { stateCopy } from "../shared/ui/state.ts";
import { VerdictBlock } from "../shared/ui/verdict-block.tsx";
import { uiLang } from "../shared/ui-lang.ts";
import type { OptionsSection } from "../../shared/messages/core.ts";
import { officialRecordText, type Filter, type Status, type TriageState } from "./state.ts";
import { triageText } from "./text.ts";

/** 打开设置页；后台打不开时就在这个标签页里转过去。 */
function openSettings(state: TriageState, optionsUrl: string, section?: OptionsSection): void {
  void state.openSettings(section).then((opened) => {
    if (!opened) location.assign(optionsUrl);
  });
}

function StatusLine({ status, onSettings }: { readonly status: Status | null; readonly onSettings?: () => void }) {
  return (
    <>
      <p class="status" role="status" data-tone={status?.tone}>
        {status?.text ?? ""}
      </p>
      {status?.settings && onSettings ? (
        <div class="actions">
          <Button onClick={onSettings}>{triageText().openSettings}</Button>
        </div>
      ) : null}
    </>
  );
}

function Confirm({ state }: { readonly state: TriageState }) {
  const ask = state.pending.value;
  if (!ask) return null;
  const t = triageText();
  return (
    <div class="confirm" role="group" aria-label={t.confirmLabel} data-step={ask.step}>
      {ask.lines.map((line) => (
        <p class="confirm-question" key={line}>
          {line}
        </p>
      ))}
      <div class="actions">
        <Button variant="primary" onClick={() => state.confirm()}>
          {t.confirm}
        </Button>
        <Button variant="text" onClick={() => state.cancel()}>
          {t.cancel}
        </Button>
      </div>
    </div>
  );
}

function StepActions({ state, step }: { readonly state: TriageState; readonly step: "official" | "verdict" }) {
  const running = state.running.value;
  const busy = running !== null || state.pending.value !== null;
  const t = triageText();
  return (
    <div class="actions">
      {running === step ? (
        <Button disabled={state.stopping.value} onClick={() => state.stop()}>
          {state.stopping.value ? t.stopping : t.stop}
        </Button>
      ) : (
        <Button variant="primary" disabled={busy} onClick={() => (step === "official" ? state.askOfficial() : void state.askVerdicts())}>
          {step === "official" ? t.official.start : t.verdict.start}
        </Button>
      )}
    </div>
  );
}

function Steps({ state, optionsUrl }: { readonly state: TriageState; readonly optionsUrl: string }) {
  const pending = state.pending.value;
  const running = state.running.value;
  const idle = state.verdictIdle.value;
  const t = triageText();
  return (
    <section class="card" id="triage-steps">
      <div class="step" id="step-official">
        <h2>{t.official.title}</h2>
        <p class="hint">{t.official.hint}</p>
        <StepActions state={state} step="official" />
        {pending?.step === "official" ? <Confirm state={state} /> : null}
        <StatusLine status={state.officialStatus.value} />
      </div>
      <div class="step" id="step-verdict">
        <h2>{t.verdict.title}</h2>
        <p class="hint">{t.verdict.hint}</p>
        {idle ? <p class="hint">{idle === "all-written" ? t.allWritten : t.noneToWrite}</p> : <StepActions state={state} step="verdict" />}
        {pending?.step === "verdict" ? <Confirm state={state} /> : null}
        <StatusLine status={state.verdictStatus.value} onSettings={() => openSettings(state, optionsUrl, "ai-service")} />
      </div>
      {running === "official" || running === "verdict" || pending ? <p class="hint note">{t.closeNote}</p> : null}
    </section>
  );
}

const sourceOf = (verdict: TriageVerdict) => (verdict.source === "official" ? "official-summary" : "transcript");

function Row({ state, item }: { readonly state: TriageState; readonly item: TriageItem }) {
  const snapshot = state.snapshot.value;
  const record = snapshot?.official[item.videoKey];
  const verdict = snapshot?.verdicts[item.videoKey];
  const url = state.videoUrl(item);
  const error = state.errors.value[item.videoKey];
  const hasContent = hasOfficialContent(record);
  const lang = uiLang.value;
  const t = triageText();
  const outline = (record?.outline ?? [])
    .map((section) => String((section as { readonly title?: unknown } | null)?.title ?? "").trim())
    .filter(Boolean)
    .join(t.outlineJoin);
  const meta = [
    item.ownerName,
    item.duration ? formatDuration(item.duration) : "",
    progressText(item, lang),
    (item.pageCount ?? 1) > 1 ? t.pages(item.pageCount ?? 1) : "",
    item.available === false ? t.unavailable : "",
  ].filter(Boolean);
  return (
    <li class="video" data-video={item.videoKey} data-group={groupKeyOf(verdict)}>
      <a class="cover" href={url} target="_blank" rel="noopener noreferrer" tabIndex={-1} aria-hidden="true">
        {item.cover ? <img src={item.cover} alt="" loading="lazy" referrerpolicy="no-referrer" /> : null}
        {item.duration ? <span class="cover-duration">{formatDuration(item.duration)}</span> : null}
      </a>
      <div class="video-body">
        <a class="video-title" href={url} target="_blank" rel="noopener noreferrer">
          {item.title || item.videoKey}
        </a>
        <p class="video-meta">{meta.join(" · ")}</p>
        {hasVerdict(verdict) ? (
          <VerdictBlock label={verdict.verdict ?? ""} text={verdict.summary ?? ""} basis={sourceOf(verdict)} />
        ) : null}
        {hasVerdict(verdict) && (verdict.value || verdict.reason) ? (
          <p class="video-line">{[verdict.value ? t.value(verdict.value) : "", verdict.reason ? t.reason(verdict.reason) : ""].filter(Boolean).join(" ")}</p>
        ) : null}
        <p class="video-official" data-status={hasContent ? "ok" : "none"}>
          {hasContent ? (
            <>
              <span class="label">{t.officialLabel}</span>
              {String(record?.summary ?? "").trim() || outline}
            </>
          ) : (
            officialRecordText(record, item, lang)
          )}
        </p>
        {isOfficialDone(record) && !hasContent && !hasVerdict(verdict) ? (
          <p class="video-note">
            <a href={url} target="_blank" rel="noopener noreferrer">
              {t.goGenerate}
            </a>
            {t.goGenerateNote}
          </p>
        ) : null}
        {error ? <p class="video-error">{error.text}</p> : null}
        {error ? <ServiceSaid said={error.said} /> : null}
      </div>
    </li>
  );
}

function Results({ state }: { readonly state: TriageState }) {
  const items = state.items.value;
  const verdicts = state.snapshot.value?.verdicts ?? {};
  const groups = groupItems(items, verdicts);
  const filter = state.filter.value;
  const t = triageText();
  const entries: { readonly key: Filter; readonly label: string; readonly count: number }[] = [
    { key: "all", label: t.all, count: items.length },
    // 旧判断只在真有的时候列出来，新装的用户看不到这一组。
    ...GROUPS.filter((group) => group.key !== "legacy" || groups.legacy.length > 0).map((group) => ({ key: group.key, label: groupName(group.key, uiLang.value), count: groups[group.key].length })),
  ];
  const shown = filter === "all" ? items : groups[filter];
  return (
    <section class="card" id="triage-results">
      <div class="results-head">
        <h2>{t.results}</h2>
        <Button disabled={items.length === 0} onClick={() => state.exportMarkdown()}>
          {t.exportMarkdown}
        </Button>
      </div>
      <div class="filters" role="group" aria-label={t.filterLabel}>
        {entries.map((entry) => (
          <button key={entry.key} type="button" class="filter" data-group={entry.key} aria-pressed={filter === entry.key} onClick={() => state.setFilter(entry.key)}>
            {entry.label} {entry.count}
          </button>
        ))}
      </div>
      {shown.length ? (
        <ul class="video-list">
          {shown.map((item) => (
            <Row key={item.videoKey} state={state} item={item} />
          ))}
        </ul>
      ) : (
        <p class="hint">{items.length ? t.emptyGroup : t.emptyList}</p>
      )}
    </section>
  );
}

export function App({ state, activation, optionsUrl }: { readonly state: TriageState; readonly activation: Activation; readonly optionsUrl: string }) {
  const view = activation.view.value;
  const hasList = state.snapshot.value?.list != null;
  const loadFailure = state.loadFailure.value;
  const t = triageText();
  return (
    <main class="page triage-page">
      <header class="page-head">
        <h1>{t.heading}</h1>
        <a class="back-link" href={optionsUrl}>
          {t.back}
        </a>
      </header>
      <p class="lede">{t.lede}</p>
      {view.state === "loading" ? <p class="hint">{t.activationLoading}</p> : null}
      {view.state === "failed" ? (
        <StateBlock {...stateCopy(view.failure.code, view.failure.detail, uiLang.value)} primary={{ label: t.retry, onClick: () => void activation.load() }} />
      ) : null}
      {view.state === "needed" ? (
        <StateBlock title={t.notEnabledTitle} impact={t.notEnabledImpact} primary={{ label: t.enableInSettings, onClick: () => openSettings(state, optionsUrl) }} />
      ) : null}
      {activation.enabled.value ? (
        <>
          {loadFailure ? <StateBlock {...stateCopy(loadFailure.code, loadFailure.detail, uiLang.value)} primary={{ label: t.retry, onClick: () => void state.load() }} /> : null}
          <section class="card" id="triage-list">
            <h2>{t.list.title}</h2>
            <p class="hint">{t.list.hint}</p>
            <div class="actions">
              <Button variant="primary" disabled={state.running.value !== null} onClick={() => state.readList()}>
                {state.running.value === "list" ? t.list.reading : t.list.read}
              </Button>
            </div>
            <StatusLine status={state.listStatus.value} />
          </section>
          {hasList ? (
            <>
              <Steps state={state} optionsUrl={optionsUrl} />
              <Results state={state} />
            </>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
