// 设置页「按功能选模型」下面的看图检测：只在构建开关 FEATURE_FRAME_EXPLAIN 打开时进包，只从 ai-section.tsx 的开关分支引用。
import { Button } from "../shared/ui/button.tsx";
import { AiStatusLine } from "./controls.tsx";
import type { OptionsState } from "./state.ts";

export function ImageProbeButton({ state }: { readonly state: OptionsState }) {
  const busy = state.busy.value;
  return (
    <div>
      <span class="field-hint">
        画面分析要选能看图的模型。
        <Button disabled={busy !== null} onClick={() => void state.probeImage()}>
          {busy === "test" ? "正在检测" : "检测能不能看图"}
        </Button>
      </span>
      <AiStatusLine state={state} at="probe" />
    </div>
  );
}
