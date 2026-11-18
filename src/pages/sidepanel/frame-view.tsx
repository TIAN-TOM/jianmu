// 侧边栏里解释当前画面的按钮和结果：只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进包，只从 app.tsx 的开关分支引用。
// 结果排在模式内容上面，两种模式都看得到（播放页图标点出来时侧边栏可能停在速览）；按钮只在精读的底部工具条上。
// 失败按原因、影响、下一步三段写，要去设置页的给一个按钮。
import { errorCopy, type ErrorCode } from "../../core/errors.ts";
import { formatTimestamp } from "../../core/transcript/segment.ts";
import type { FrameEntryView } from "../../shared/messages/frame.ts";
import { Button } from "../shared/ui/button.tsx";
import { StateBlock } from "../shared/ui/state-block.tsx";
import type { FrameStore } from "./frame.ts";
import type { Panel } from "./panel.ts";

const PHASE_TEXT: Readonly<Record<FrameEntryView["phase"], string>> = {
  checking: "正在查模型能不能看图…",
  capturing: "正在截取画面…",
  thinking: "正在请模型看图…",
  finished: "",
};

// 这几种要到设置页去改。
const NEEDS_SETTINGS: ReadonlySet<ErrorCode> = new Set<ErrorCode>(["AI_IMAGE_UNSUPPORTED", "NO_AI_CONFIG", "NO_DATA_CONSENT", "NEED_HOST_PERMISSION", "INVALID_AI_KEY"]);

function FrameCard({ panel, frame, entry }: { readonly panel: Panel; readonly frame: FrameStore; readonly entry: FrameEntryView }) {
  const time = entry.atSec === undefined ? null : formatTimestamp(entry.atSec);
  const copy = entry.error ? errorCopy(entry.error.code, entry.error.detail) : null;
  return (
    <article class="frame-card" aria-busy={entry.state === "running"}>
      <header class="frame-card-head">
        <span class="frame-card-title">画面</span>
        {time !== null && entry.atSec !== undefined ? (
          <button type="button" class="stamp" aria-label={`跳回这一帧 ${time}`} onClick={() => void panel.seek(entry.atSec ?? 0)}>
            {time}
          </button>
        ) : null}
        <button type="button" class="frame-card-close" aria-label="关掉这条解释" onClick={() => frame.dismiss(entry.id)}>
          ×
        </button>
      </header>
      {entry.state === "running" ? (
        <p class="frame-card-status" role="status">
          {PHASE_TEXT[entry.phase]}
        </p>
      ) : null}
      {entry.state === "done" ? <p class="frame-card-text">{entry.explanation}</p> : null}
      {copy && entry.error ? (
        <StateBlock
          title={copy.cause}
          impact={copy.impact}
          next={copy.next}
          {...(NEEDS_SETTINGS.has(entry.error.code) ? { primary: { label: "打开设置", onClick: () => panel.openSettingsAt("ai-service") } } : {})}
        />
      ) : null}
    </article>
  );
}

export function FrameResults({ panel, frame }: { readonly panel: Panel; readonly frame: FrameStore }) {
  const entries = frame.entries.value;
  if (entries.length === 0) return null;
  return (
    <section class="frame-results" aria-label="画面解释">
      {entries.map((entry) => (
        <FrameCard key={entry.id} panel={panel} frame={frame} entry={entry} />
      ))}
    </section>
  );
}

export function FrameButton({ panel, frame }: { readonly panel: Panel; readonly frame: FrameStore }) {
  return (
    <Button variant="text" onClick={() => void frame.explain().then(panel.say)}>
      解释画面
    </Button>
  );
}
