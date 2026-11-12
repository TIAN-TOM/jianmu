// 本窗口全部生成那一条：窗口级的，切视频时不跟着换，排在概览页签最上面。
// 平时一个按钮；清点完写清本窗口几个视频、跳过几个、要新生成几个，等用户确认；生成中有进度条和「全部停止」，
// 失败和停掉的逐个列出、可以单独重试，做完可以收起。
import { describe as describeFailure } from "../../core/errors.ts";
import { AI_CONCURRENCY } from "../../shared/settings-schema.ts";
import { Button } from "../shared/ui/button.tsx";
import { busyOf, confirmText, countsOf, progressText, RETRYABLE } from "./batch.ts";
import type { Panel } from "./panel.ts";

export function BatchBar({ panel, ready }: { readonly panel: Panel; readonly ready: boolean }) {
  const { batch } = panel;
  const state = batch.state.value;
  const error = batch.error.value;
  const notReady = ready ? {} : { disabledReason: "先在设置页设置 AI 服务" };

  if (state.phase === "idle") {
    return (
      <section class="batch-bar" data-phase="idle" aria-label="本窗口全部生成">
        <Button disabled={!ready} {...notReady} onClick={() => batch.count()}>
          本窗口全部生成
        </Button>
        {error ? <p class="batch-error" role="alert">{error}</p> : null}
      </section>
    );
  }

  if (state.phase === "counting") {
    return (
      <section class="batch-bar" data-phase="counting" aria-label="本窗口全部生成">
        <p class="batch-status" role="status">
          正在清点本窗口的视频…
        </p>
      </section>
    );
  }

  if (state.phase === "confirm") {
    const todo = state.items.filter((item) => item.state === "to-generate").length;
    return (
      <section class="batch-bar" data-phase="confirm" aria-label="本窗口全部生成">
        <p class="batch-status" role="status">
          {confirmText(state.items)}
        </p>
        {todo ? (
          <p class="batch-notice">
            确认以后逐个读字幕、交给你设置的模型服务生成概览，会用掉 API 额度；同时进行的请求最多 {AI_CONCURRENCY} 个。关掉侧边栏也会接着做完。
          </p>
        ) : null}
        <div class="batch-actions">
          {todo ? (
            <Button variant="primary" disabled={!ready} {...notReady} onClick={() => batch.confirm()}>
              开始生成 {todo} 个
            </Button>
          ) : null}
          <Button variant="text" onClick={() => batch.dismiss()}>
            {todo ? "取消" : "知道了"}
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
    <section class="batch-bar" data-phase="active" aria-label="本窗口全部生成">
      <p class="batch-status" role="status">
        {progressText(run)}
      </p>
      <progress class="batch-progress" max={Math.max(1, total)} value={settled} aria-label="本窗口的进度" />
      <div class="batch-actions">
        {busy ? (
          <Button disabled={run.stopping} onClick={() => batch.stopAll()}>
            {run.stopping ? "正在停止…" : "全部停止"}
          </Button>
        ) : (
          <Button variant="text" onClick={() => batch.dismiss()}>
            收起
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
                <span class="batch-failure-reason">{entry.status === "canceled" ? "已停止" : entry.failure ? describeFailure(entry.failure.code) : "生成失败"}</span>
              </span>
              <Button variant="text" disabled={!ready} {...notReady} onClick={() => batch.retry(entry.video)}>
                重试
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {partial.length ? (
        <ul class="batch-failures" aria-label="不完整的概览">
          {partial.map((entry) => (
            <li key={entry.video} class="batch-failure" data-status="partial" data-video={entry.video}>
              <span class="batch-failure-text">
                <span class="batch-failure-title" title={entry.title}>
                  {entry.title}
                </span>
                <span class="batch-failure-reason">有分块没生成成功，切到这个视频点「补失败块」</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p class="batch-error" role="alert">{error}</p> : null}
    </section>
  );
}
