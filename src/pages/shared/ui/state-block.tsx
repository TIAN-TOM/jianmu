// 取不到内容时替换内容区的状态块：标题写原因，一行写影响，下面是下一步。
// 下一步最多一个主按钮、两个次按钮，按钮写清点了会发生什么。
import { useId } from "preact/hooks";
import { Button } from "./button.tsx";

export interface StateAction {
  readonly label: string;
  readonly onClick: () => void;
  /** 按钮下面一行小字，比如会再花费用。 */
  readonly note?: string;
}

export interface StateBlockProps {
  readonly title: string;
  readonly impact?: string | undefined;
  readonly primary?: StateAction;
  readonly secondary?: readonly [] | readonly [StateAction] | readonly [StateAction, StateAction];
}

export function StateBlock({ title, impact, primary, secondary = [] }: StateBlockProps) {
  const id = useId();
  const hasActions = primary !== undefined || secondary.length > 0;
  return (
    <section class="state-block" aria-labelledby={`${id}-title`}>
      <h2 class="state-title" id={`${id}-title`}>
        {title}
      </h2>
      {impact ? <p class="state-impact">{impact}</p> : null}
      {hasActions ? (
        <div class="state-actions">
          {primary ? (
            <Button variant="primary" onClick={primary.onClick} note={primary.note}>
              {primary.label}
            </Button>
          ) : null}
          {secondary.map((action) => (
            <Button key={action.label} onClick={action.onClick} note={action.note}>
              {action.label}
            </Button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
