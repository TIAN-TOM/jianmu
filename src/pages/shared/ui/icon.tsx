// 界面图标和判断标记。都是装饰：意思由旁边的文字或按钮的无障碍名称说，读屏跳过图形。
import { ICON_GRID, ICONS, MARK_GRID, MARK_PARTS, type IconName, type IconPart } from "./icons.ts";
import type { MarkShape } from "./verdict.ts";

function Part({ part }: { readonly part: IconPart }) {
  switch (part.kind) {
    case "path":
      return <path d={part.d} fill={part.solid ? "currentColor" : undefined} stroke={part.solid ? "none" : undefined} stroke-width={part.weight} />;
    case "circle":
      return (
        <circle
          cx={part.cx}
          cy={part.cy}
          r={part.r}
          fill={part.solid ? "currentColor" : undefined}
          stroke={part.solid ? "none" : undefined}
          stroke-dasharray={part.dash === undefined ? undefined : `${part.dash} ${part.dash}`}
        />
      );
    case "rect":
      return <rect x={part.x} y={part.y} width={part.width} height={part.height} rx={part.rx} />;
  }
}

export function Icon({ name, size = ICON_GRID }: { readonly name: IconName; readonly size?: number }) {
  return (
    <svg
      class="icon"
      data-icon={name}
      viewBox={`0 0 ${ICON_GRID} ${ICON_GRID}`}
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      stroke-width={1.5}
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name].map((part, index) => (
        <Part key={index} part={part} />
      ))}
    </svg>
  );
}

/** 判断标记。档位名总在旁边用文字写出来，标记本身不进读屏。 */
export function VerdictMark({ shape, size = MARK_GRID }: { readonly shape: MarkShape; readonly size?: number }) {
  return (
    <svg
      class="verdict-mark"
      data-shape={shape}
      viewBox={`0 0 ${MARK_GRID} ${MARK_GRID}`}
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      stroke-width={1.5}
      aria-hidden="true"
      focusable="false"
    >
      {MARK_PARTS[shape].map((part, index) => (
        <Part key={index} part={part} />
      ))}
    </svg>
  );
}
