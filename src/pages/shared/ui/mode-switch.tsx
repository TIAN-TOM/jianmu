// 模式切换：「速览　精读」两个词组成的单选组，方向键切换，只有选中的那个在 Tab 顺序里。
import { useRef } from "preact/hooks";
import type { Mode } from "../../../core/mode/types.ts";
import { rovingTarget } from "./keys.ts";

export const MODE_OPTIONS: readonly { readonly value: Mode; readonly label: string }[] = [
  { value: "skim", label: "速览" },
  { value: "study", label: "精读" },
];

export interface ModeSwitchProps {
  readonly value: Mode;
  readonly onChange: (mode: Mode) => void;
}

export function ModeSwitch({ value, onChange }: ModeSwitchProps) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const current = MODE_OPTIONS.findIndex((option) => option.value === value);
  const onKeyDown = (event: KeyboardEvent): void => {
    const next = rovingTarget(event.key, current, MODE_OPTIONS.length, "both");
    const option = next === null ? undefined : MODE_OPTIONS[next];
    if (next === null || !option) return;
    event.preventDefault();
    buttons.current[next]?.focus();
    if (option.value !== value) onChange(option.value);
  };
  return (
    <div class="modes" role="radiogroup" aria-label="模式" onKeyDown={onKeyDown}>
      {MODE_OPTIONS.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            class="mode"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            onClick={() => {
              if (!checked) onChange(option.value);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
