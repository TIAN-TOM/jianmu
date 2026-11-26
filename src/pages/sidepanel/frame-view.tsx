// 侧边栏里解释当前画面的按钮和结果：只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进包，只从 app.tsx 的开关分支引用。
// 结果排在模式内容上面，两种模式都看得到（播放页图标点出来时侧边栏可能停在速读），新的一条出来时滚进视野；按钮只在精读的底部工具条上。
// 失败按原因、影响、下一步三段写，要去设置页的给一个按钮：共用的码表，加上只有这里会报的模型不能看图。
import { errorCopy } from "../../core/errors.ts";
import { fixedInSettings } from "../../core/errors/settings-codes.ts";
import { formatTimestamp } from "../../core/transcript/segment.ts";
import type { FrameEntryView } from "../../shared/messages/frame.ts";
import { useEffect, useRef } from "preact/hooks";
import { Button } from "../shared/ui/button.tsx";
import { StateBlock } from "../shared/ui/state-block.tsx";
import { uiLang } from "../shared/ui-lang.ts";
import { frameText } from "./frame-text.ts";
import type { FrameStore } from "./frame.ts";
import type { Panel } from "./panel.ts";

function FrameCard({ panel, frame, entry }: { readonly panel: Panel; readonly frame: FrameStore; readonly entry: FrameEntryView }) {
  const time = entry.atSec === undefined ? null : formatTimestamp(entry.atSec);
  const copy = entry.error ? errorCopy(entry.error.code, entry.error.detail, uiLang.value) : null;
  const t = frameText(uiLang.value);
  return (
    <article class="frame-card" data-id={entry.id} aria-busy={entry.state === "running"}>
      <header class="frame-card-head">
        <span class="frame-card-title">{t.title}</span>
        {time !== null && entry.atSec !== undefined ? (
          <button type="button" class="stamp" aria-label={t.jumpBack(time)} onClick={() => void panel.seek(entry.atSec ?? 0)}>
            {time}
          </button>
        ) : null}
        <button type="button" class="frame-card-close" aria-label={t.dismiss} onClick={() => frame.dismiss(entry.id)}>
          ×
        </button>
      </header>
      {entry.state === "running" ? (
        <p class="frame-card-status" role="status">
          {t.phases[entry.phase]}
        </p>
      ) : null}
      {entry.state === "done" ? <p class="frame-card-text">{entry.explanation}</p> : null}
      {copy && entry.error ? (
        <StateBlock
          title={copy.cause}
          impact={copy.impact}
          next={copy.next}
          {...(fixedInSettings(entry.error.code) || entry.error.code === "AI_IMAGE_UNSUPPORTED" ? { primary: { label: t.openSettings, onClick: () => panel.openSettingsAt("ai-service") } } : {})}
        />
      ) : null}
    </article>
  );
}

/**
 * 结果排在页面上方：新的一条出来时把它滚进视野，字幕停下跟随，不然在精读里看着字幕的人以为什么都没发生。
 * 打开侧边栏时已经有的、切过来时读到的旧结果都不算新的，不滚。
 */
export function FrameResults({ panel, frame }: { readonly panel: Panel; readonly frame: FrameStore }) {
  const entries = frame.entries.value;
  const section = useRef<HTMLElement>(null);
  const seen = useRef<ReadonlySet<string> | null>(null);
  const ids = entries.map((entry) => entry.id).join("\n");
  useEffect(() => {
    const before = seen.current;
    seen.current = new Set(entries.map((entry) => entry.id));
    // 只认还在跑的：切标签页、重读时冒出来的旧结果不算新的。
    const fresh = before ? entries.find((entry) => entry.state === "running" && !before.has(entry.id)) : undefined;
    if (!fresh) return;
    panel.holdFollow();
    const card = [...(section.current?.querySelectorAll<HTMLElement>(".frame-card") ?? [])].find((node) => node.dataset["id"] === fresh.id);
    card?.scrollIntoView({ block: "nearest" });
  }, [ids]);
  if (entries.length === 0) return null;
  return (
    <section class="frame-results" ref={section} aria-label={frameText(uiLang.value).label}>
      {entries.map((entry) => (
        <FrameCard key={entry.id} panel={panel} frame={frame} entry={entry} />
      ))}
    </section>
  );
}

export function FrameButton({ panel, frame }: { readonly panel: Panel; readonly frame: FrameStore }) {
  return (
    <Button variant="text" onClick={() => void frame.explain().then(panel.say)}>
      {frameText(uiLang.value).button}
    </Button>
  );
}
