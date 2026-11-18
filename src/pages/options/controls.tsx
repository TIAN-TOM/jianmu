// 设置页各节共用的小组件：状态行、「AI 服务」一节跟着控件走的状态行、就地确认。
import { useState } from "preact/hooks";
import { Button } from "../shared/ui/button.tsx";
import type { AiPlace, OptionsState, Status } from "./state.ts";

/** inline：跟在某个控件下面，没有内容时不占地方；不带时留着一行的高度，免得下面的内容跳。 */
export function StatusLine({ status, inline = false, at }: { readonly status: Status | null; readonly inline?: boolean; readonly at?: string }) {
  return (
    <p class={inline ? "status status-inline" : "status"} role="status" data-tone={status?.tone} data-status-at={at}>
      {status ? status.text : null}
    </p>
  );
}

/**
 * 「AI 服务」一节同一时间只有一条状态，显示在它说的那个控件下面。每个位置的状态行一直在页面上，读屏才播得出来；
 * 放在不是弹性布局的容器里，空着的时候不多出间距。
 */
export function AiStatusLine({ state, at }: { readonly state: OptionsState; readonly at: AiPlace }) {
  const status = state.aiStatus.value;
  return <StatusLine status={status?.at === at ? status : null} inline={at !== "actions"} at={at} />;
}

/** 就地确认：点一下换成「确认」和「取消」两个按钮，不弹系统对话框。 */
export function Confirmable(props: {
  readonly label: string;
  readonly question: string;
  readonly confirmLabel: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly onConfirm: () => void;
}) {
  const [asking, setAsking] = useState(false);
  if (!asking) {
    return (
      <Button variant={props.danger ? "danger" : "secondary"} disabled={props.disabled} onClick={() => setAsking(true)}>
        {props.label}
      </Button>
    );
  }
  return (
    <div class="confirm" role="group" aria-label={props.label}>
      <p class="confirm-question">{props.question}</p>
      <div class="actions">
        <Button
          variant={props.danger ? "danger" : "primary"}
          onClick={() => {
            setAsking(false);
            props.onConfirm();
          }}
        >
          {props.confirmLabel}
        </Button>
        <Button variant="text" onClick={() => setAsking(false)}>
          取消
        </Button>
      </div>
    </div>
  );
}
