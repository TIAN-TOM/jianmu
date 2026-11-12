// 设置页各节共用的两个小组件：状态行、就地确认。
import { useState } from "preact/hooks";
import { Button } from "../shared/ui/button.tsx";
import type { Status } from "./state.ts";

export function StatusLine({ status }: { readonly status: Status | null }) {
  return (
    <p class="status" role="status" data-tone={status?.tone}>
      {status?.text ?? ""}
    </p>
  );
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
