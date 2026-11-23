// 模式切换：「速读　精读」两个词组成的单选组，方向键切换，只有选中的那个在 Tab 顺序里。
import { useRef } from "preact/hooks";
import type { Mode } from "../../../core/mode/types.ts";
import { sharedText } from "../text.ts";
import { rovingTarget } from "./keys.ts";

export const MODE_OPTIONS: readonly Mode[] = ["skim", "study"];

export interface ModeSwitchProps {
  readonly value: Mode;
  readonly onChange: (mode: Mode) => void;
}

export function ModeSwitch({ value, onChange }: ModeSwitchProps) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const t = sharedText().modes;
  const current = MODE_OPTIONS.indexOf(value);
  const onKeyDown = (event: KeyboardEvent): void => {
    const next = rovingTarget(event.key, current, MODE_OPTIONS.length, "both");
    const option = next === null ? undefined : MODE_OPTIONS[next];
    if (next === null || !option) return;
    event.preventDefault();
    buttons.current[next]?.focus();
    if (option !== value) onChange(option);
  };
  return (
    <div class="modes" role="radiogroup" aria-label={t.label} onKeyDown={onKeyDown}>
      {MODE_OPTIONS.map((option, index) => {
        const checked = option === value;
        return (
          <button
            key={option}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            class="mode"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => {
              if (!checked) onChange(option);
            }}
          >
            {t[option]}
          </button>
        );
      })}
    </div>
  );
}
