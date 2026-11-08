// 按钮、图标按钮和标记。停用的按钮旁边写明原因，不让用户猜为什么点不了。
import type { ComponentChildren } from "preact";
import { useId } from "preact/hooks";
import { Icon } from "./icon.tsx";
import type { IconName } from "./icons.ts";

export type ButtonVariant = "primary" | "secondary" | "text" | "danger";

export interface ButtonProps {
  readonly variant?: ButtonVariant;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  /** 停用时写在按钮旁边的原因，同时挂到按钮的描述上。 */
  readonly disabledReason?: string;
  /** 按钮下面一行小字，比如会不会再花费用。 */
  readonly note?: string;
  readonly type?: "button" | "submit";
  readonly wide?: boolean;
  readonly children: ComponentChildren;
}

export function Button({ variant = "secondary", onClick, disabled = false, disabledReason, note, type = "button", wide = false, children }: ButtonProps) {
  const id = useId();
  const reason = disabled && disabledReason ? disabledReason : "";
  const described = [reason ? `${id}-reason` : "", note ? `${id}-note` : ""].filter(Boolean).join(" ");
  return (
    <span class="control" data-wide={wide ? "true" : undefined}>
      <button type={type} class="button" data-variant={variant} disabled={disabled} aria-describedby={described || undefined} onClick={onClick}>
        {children}
      </button>
      {reason ? (
        <span class="control-reason" id={`${id}-reason`}>
          {reason}
        </span>
      ) : null}
      {note ? (
        <span class="control-note" id={`${id}-note`}>
          {note}
        </span>
      ) : null}
    </span>
  );
}

export interface IconButtonProps {
  readonly icon: IconName;
  /** 无障碍名称，也是悬停提示。图标按钮没有可见文字，必须给。 */
  readonly label: string;
  readonly onClick?: () => void;
  readonly disabled?: boolean;
  readonly pressed?: boolean;
}

export function IconButton({ icon, label, onClick, disabled = false, pressed }: IconButtonProps) {
  return (
    <button type="button" class="icon-button" aria-label={label} title={label} aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      <Icon name={icon} />
    </button>
  );
}

export type BadgeTone = "neutral" | "warn" | "danger" | "ok" | "line";

export function Badge({ tone = "neutral", children }: { readonly tone?: BadgeTone; readonly children: ComponentChildren }) {
  return (
    <span class="badge" data-tone={tone}>
      {children}
    </span>
  );
}
