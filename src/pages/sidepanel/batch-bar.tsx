// 本窗口全部生成：窗口级的，切视频时不跟着换。
// 平时只是速读里那排按钮中的一个（BatchStart），和「重新生成」「导出学习稿」放在一起，AI 服务没设置好时不摆；
// 清点中、等确认、生成中、有失败要列出时，这一条（BatchBar）回到速读最上面：写清本窗口几个视频、跳过几个、要新生成几个，等用户确认；
// 生成中有进度条和「全部停止」，失败和停掉的逐个列出、可以单独重试，做完点「知道了」收掉。
import { describe as describeFailure } from "../../core/errors.ts";
import { AI_CONCURRENCY } from "../../shared/settings-schema.ts";
import { Button } from "../shared/ui/button.tsx";
import { busyOf, confirmText, countsOf, progressText, RETRYABLE } from "./batch.ts";
import type { Panel } from "./panel.ts";
import { setupReason } from "../shared/config.ts";
import { sharedText } from "../shared/text.ts";
import { uiLang } from "../shared/ui-lang.ts";
import { panelText } from "./text.ts";

export function BatchBar({ panel, ready }: { readonly panel: Panel; readonly ready: boolean }) {
  const { batch } = panel;
  const state = batch.state.value;
  const error = batch.error.value;
  const lang = uiLang.value;
  const p = panelText();
  const t = p.batch;
  const notReady = ready ? {} : { disabledReason: setupReason(panel.config.state.value, lang) ?? sharedText().setup.reason.none };

  if (state.phase === "idle") {
    // 平时按钮在速读那排按钮里；这里只在上一次没做成时说一句。
    return error ? (
      <section key="idle" class="batch-bar" data-phase="idle" aria-label={t.label}>
        <p class="batch-error" role="alert">{error}</p>
      </section>
    ) : null;
  }

  if (state.phase === "counting") {
    return (
      <section key="busy" class="batch-bar" data-phase="counting" aria-label={t.label}>
        <p class="batch-status" role="status">
          {t.counting}
        </p>
      </section>
    );
  }

  if (state.phase === "confirm") {
    const todo = state.items.filter((item) => item.state === "to-generate").length;
    return (
      <section key="busy" class="batch-bar" data-phase="confirm" aria-label={t.label}>
        <p class="batch-status" role="status">
          {confirmText(state.items, lang)}
        </p>
        {todo ? (
          <p class="batch-notice">{t.notice(AI_CONCURRENCY)}</p>
        ) : null}
        <div class="batch-actions">
          {todo ? (
            <Button variant="primary" disabled={!ready} {...notReady} onClick={() => batch.confirm()}>
              {t.start(todo)}
            </Button>
          ) : null}
          <Button variant="text" onClick={() => batch.dismiss()}>
            {todo ? p.cancel : t.gotIt}
          </Button>
        </div>
        {error ? <p class="batch-error" role="alert">{error}</p> : null}
      </section>
    );
  }

  const { run } = state;
  const counts = countsOf(run);
  const busy = busyOf(run);
  const settled = counts.completed + counts.failed + counts.canceled;
  const total = counts.total - counts.skipped;
  const retryable = run.entries.filter((entry) => RETRYABLE.has(entry.status));
  const partial = run.entries.filter((entry) => entry.status === "completed" && entry.partial);
  return (
    <section key="busy" class="batch-bar" data-phase="active" aria-label={t.label}>
      <p class="batch-status" role="status">
        {progressText(run, lang)}
      </p>
      {/* 和卡片上的一样是一道细条，往前走一截时滑过去。 */}
      <div class="batch-progress" role="progressbar" aria-label={t.progressLabel} aria-valuemin={0} aria-valuemax={Math.max(1, total)} aria-valuenow={settled}>
        <div class="batch-progress-fill" style={{ transform: `scaleX(${settled / Math.max(1, total)})` }} />
      </div>
      <div class="batch-actions">
        {busy ? (
          <Button disabled={run.stopping} onClick={() => batch.stopAll()}>
            {run.stopping ? t.stopping : t.stopAll}
          </Button>
        ) : (
          <Button variant="text" onClick={() => batch.dismiss()}>
            {t.gotIt}
          </Button>
        )}
      </div>
      {retryable.length ? (
        <ul class="batch-failures">
          {retryable.map((entry) => (
            <li key={entry.video} class="batch-failure" data-status={entry.status} data-video={entry.video}>
              <span class="batch-failure-text">
                <span class="batch-failure-title" title={entry.title}>
                  {entry.title}
                </span>
                <span class="batch-failure-reason">{entry.status === "canceled" ? t.canceled : entry.failure ? describeFailure(entry.failure.code, undefined, lang) : t.failed}</span>
              </span>
              <Button variant="text" disabled={!ready} {...notReady} onClick={() => batch.retry(entry.video)}>
                {p.retry}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {partial.length ? (
        <ul class="batch-failures" aria-label={t.partialLabel}>
          {partial.map((entry) => (
            <li key={entry.video} class="batch-failure" data-status="partial" data-video={entry.video}>
              <span class="batch-failure-text">
                <span class="batch-failure-title" title={entry.title}>
                  {entry.title}
                </span>
                <span class="batch-failure-reason">{t.partialReason}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p class="batch-error" role="alert">{error}</p> : null}
    </section>
  );
}

/** 平时的入口：速读那排按钮里的一个。只在空闲时摆，清点、确认和生成中都在上面那一条里。 */
export function BatchStart({ panel, ready }: { readonly panel: Panel; readonly ready: boolean }) {
  const { batch } = panel;
  if (batch.state.value.phase !== "idle") return null;
  const notReady = ready ? {} : { disabledReason: setupReason(panel.config.state.value, uiLang.value) ?? sharedText().setup.reason.none };
  return (
    <span class="batch-start">
      <Button variant="text" disabled={!ready} {...notReady} onClick={() => batch.count()}>
        {panelText().batch.label}
      </Button>
    </span>
  );
}
