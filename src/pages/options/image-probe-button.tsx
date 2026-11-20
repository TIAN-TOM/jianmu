// 设置页「按功能选模型」下面的看图检测：只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进包，只从 ai-section.tsx 的开关分支引用。
import { Button } from "../shared/ui/button.tsx";
import { AiStatusLine } from "./controls.tsx";
import { uiLang } from "../shared/ui-lang.ts";
import { frameText } from "./frame-text.ts";
import type { OptionsState } from "./state.ts";

export function ImageProbeButton({ state }: { readonly state: OptionsState }) {
  const t = frameText(uiLang.value);
  const busy = state.busy.value;
  return (
    <div>
      <span class="field-hint">
        {t.probeHint}
        <Button disabled={busy !== null} onClick={() => void state.probeImage()}>
          {busy === "test" ? t.probing : t.probe}
        </Button>
      </span>
      <AiStatusLine state={state} at="probe" />
    </div>
  );
}
