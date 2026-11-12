// 稍后再看粗筛页：读取列表、第一步取官方总结、第二步写一句话结论、按判断分组筛选、导出 Markdown。
// 没确认启用时只说去侧边栏或设置页启用，这一页不能确认。状态和动作都在 state.ts，这里只渲染。
import { hasOfficialContent, isOfficialDone } from "../../core/triage/batch.ts";
import { formatDuration, progressText } from "../../core/triage/export.ts";
import { GROUPS, groupItems, groupKeyOf, hasVerdict, type TriageVerdict } from "../../core/triage/groups.ts";
import type { TriageItem } from "../../core/triage/state.ts";
import type { Activation } from "../shared/activation.ts";
import { Button } from "../shared/ui/button.tsx";
import { StateBlock } from "../shared/ui/state-block.tsx";
import { VerdictBlock } from "../shared/ui/verdict-block.tsx";
import { officialRecordText, type Filter, type Status, type TriageState } from "./state.ts";

function StatusLine({ status }: { readonly status: Status | null }) {
  return (
    <p class="status" role="status" data-tone={status?.tone}>
      {status?.text ?? ""}
    </p>
  );
}

function Confirm({ state }: { readonly state: TriageState }) {
  const ask = state.pending.value;
  if (!ask) return null;
  return (
    <div class="confirm" role="group" aria-label="开始前确认" data-step={ask.step}>
      {ask.lines.map((line) => (
        <p class="confirm-question" key={line}>
          {line}
        </p>
      ))}
      <div class="actions">
        <Button variant="primary" onClick={() => state.confirm()}>
          现在开始
        </Button>
        <Button variant="text" onClick={() => state.cancel()}>
          取消
        </Button>
      </div>
    </div>
  );
}

function StepActions({ state, step }: { readonly state: TriageState; readonly step: "official" | "verdict" }) {
  const running = state.running.value;
  const busy = running !== null || state.pending.value !== null;
  return (
    <div class="actions">
      {running === step ? (
        <Button disabled={state.stopping.value} onClick={() => state.stop()}>
          {state.stopping.value ? "正在停止…" : "停止"}
        </Button>
      ) : (
        <Button variant="primary" disabled={busy} onClick={() => (step === "official" ? state.askOfficial() : void state.askVerdicts())}>
          {step === "official" ? "开始取官方总结" : "开始写结论"}
        </Button>
      )}
    </div>
  );
}

function Steps({ state }: { readonly state: TriageState }) {
  const pending = state.pending.value;
  return (
    <section class="card" id="triage-steps">
      <div class="step" id="step-official">
        <h2>第一步：取 B 站官方总结</h2>
        <p class="hint">不调模型，不花 API 额度。一次一个，每两次请求之间至少隔 1.5 秒；已经取到结果的视频会跳过，被 B 站限流或接连要登录时停下。</p>
        <StepActions state={state} step="official" />
        {pending?.step === "official" ? <Confirm state={state} /> : null}
        <StatusLine status={state.officialStatus.value} />
      </div>
      <div class="step" id="step-verdict">
        <h2>第二步：写一句话结论</h2>
        <p class="hint">
          会花 API 额度。只给有官方总结、还没有结论的视频写，每个视频发一次小请求，会把标题、简介、UP 主名、时长和官方总结发给你设置的模型服务，不发字幕和观看进度。没有官方总结的视频不在这里写，它旁边有去视频页的链接，要不要生成完整概览由你决定。
        </p>
        <StepActions state={state} step="verdict" />
        {pending?.step === "verdict" ? <Confirm state={state} /> : null}
        <StatusLine status={state.verdictStatus.value} />
      </div>
      <p class="hint note">
        关掉这个页面就不再开始新的视频；已经发出去的请求会照常收尾，可能照样计费。已经取到的官方总结和写好的结论都会保存，重新打开能直接看到，再点开始会跳过它们。
      </p>
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
  const outline = (record?.outline ?? [])
    .map((section) => String((section as { readonly title?: unknown } | null)?.title ?? "").trim())
    .filter(Boolean)
    .join("；");
  const meta = [
    item.ownerName,
    item.duration ? formatDuration(item.duration) : "",
    progressText(item),
    (item.pageCount ?? 1) > 1 ? `共 ${item.pageCount} P，只看第 1 P` : "",
    item.available === false ? "已失效" : "",
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
          <p class="video-line">{[verdict.value ? `核心价值：${verdict.value}` : "", verdict.reason ? `理由：${verdict.reason}` : ""].filter(Boolean).join(" ")}</p>
        ) : null}
        <p class="video-official" data-status={hasContent ? "ok" : "none"}>
          {hasContent ? (
            <>
              <span class="label">B 站官方总结：</span>
              {String(record?.summary ?? "").trim() || outline}
            </>
          ) : (
            officialRecordText(record, item)
          )}
        </p>
        {isOfficialDone(record) && !hasContent && !hasVerdict(verdict) ? (
          <p class="video-note">
            <a href={url} target="_blank" rel="noopener noreferrer">
              去视频页生成概览 ↗
            </a>
            （在侧边栏里生成，会花 API 额度）
          </p>
        ) : null}
        {error ? <p class="video-error">{error}</p> : null}
      </div>
    </li>
  );
}

function Results({ state }: { readonly state: TriageState }) {
  const items = state.items.value;
  const verdicts = state.snapshot.value?.verdicts ?? {};
  const groups = groupItems(items, verdicts);
  const filter = state.filter.value;
  const entries: { readonly key: Filter; readonly label: string; readonly count: number }[] = [
    { key: "all", label: "全部", count: items.length },
    ...GROUPS.map((group) => ({ key: group.key, label: group.label, count: groups[group.key].length })),
  ];
  const shown = filter === "all" ? items : groups[filter];
  return (
    <section class="card" id="triage-results">
      <div class="results-head">
        <h2>结果</h2>
        <Button disabled={items.length === 0} onClick={() => state.exportMarkdown()}>
          导出 Markdown
        </Button>
      </div>
      <div class="filters" role="group" aria-label="按判断筛选">
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
        <p class="hint">{items.length ? "这一组还没有视频。" : "稍后再看是空的。"}</p>
      )}
    </section>
  );
}

export function App({ state, activation, optionsUrl }: { readonly state: TriageState; readonly activation: Activation; readonly optionsUrl: string }) {
  const view = activation.view.value;
  const hasList = state.snapshot.value?.list != null;
  const loadFailure = state.loadFailure.value;
  return (
    <main class="page triage-page">
      <header class="page-head">
        <h1>稍后再看粗筛</h1>
        <a class="back-link" href={optionsUrl}>
          ← 返回设置
        </a>
      </header>
      <p class="lede">先用 B 站官方总结快速看每个视频讲了什么，再决定要不要花 API 额度写一句话结论。只读取你自己的稍后再看列表，不改动 B 站上的任何数据。</p>
      {view.state === "loading" ? <p class="hint">正在读取启用状态……</p> : null}
      {view.state === "failed" ? (
        <StateBlock title="读不到启用状态" impact="刷新这一页再试。" primary={{ label: "重试", onClick: () => void activation.load() }} />
      ) : null}
      {view.state === "needed" ? (
        <StateBlock title="还没启用简幕" impact="先在侧边栏或设置页读一下启用说明，点「启用简幕」，再回到这一页。" />
      ) : null}
      {activation.enabled.value ? (
        <>
          {loadFailure ? <StateBlock title="读不出粗筛的结果" impact={loadFailure} primary={{ label: "重试", onClick: () => void state.load() }} /> : null}
          <section class="card" id="triage-list">
            <h2>读取列表</h2>
            <p class="hint">
              要先在这个浏览器里登录 B 站。点一次只读一次列表，包括每个视频的观看进度，这一步不调模型。读到的列表和官方总结只存在这台电脑上，存 30 天，过期后重新读取；观看进度只在本机显示和导出，不发给模型服务。
            </p>
            <div class="actions">
              <Button variant="primary" disabled={state.running.value !== null} onClick={() => state.readList()}>
                {state.running.value === "list" ? "正在读取" : "读取我的稍后再看"}
              </Button>
            </div>
            <StatusLine status={state.listStatus.value} />
          </section>
          {hasList ? (
            <>
              <Steps state={state} />
              <Results state={state} />
            </>
          ) : null}
        </>
      ) : null}
    </main>
  );
}
