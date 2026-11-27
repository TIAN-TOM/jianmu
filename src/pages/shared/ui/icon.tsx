// 界面图标和判断标记。都是装饰：意思由旁边的文字或按钮的无障碍名称说，读屏跳过图形。
import { ICON_GRID, ICONS, STAR_PATH, type IconName, type IconPart } from "./icons.ts";
import type { VerdictRating } from "../../../core/ai/verdict.ts";

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
        />
      );
    case "rect":
      return (
        <rect
          x={part.x}
          y={part.y}
          width={part.width}
          height={part.height}
          rx={part.rx}
          fill={part.solid ? "currentColor" : undefined}
          stroke={part.solid ? "none" : undefined}
        />
      );
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

/** 星数只由实心、空心区分。整组的读屏名称由旁边的短词组件提供。 */
export function VerdictStars({ stars }: { readonly stars: Extract<VerdictRating, number> }) {
  return (
    <svg class="verdict-stars" viewBox="0 0 80 16" width="80" height="16" stroke="currentColor" stroke-width={1.5} stroke-linejoin="round" aria-hidden="true" focusable="false">
      {[1, 2, 3, 4, 5].map((position) => (
        <path key={position} d={STAR_PATH} transform={`translate(${(position - 1) * ICON_GRID} 0)`} fill={position <= stars ? "currentColor" : "none"} />
      ))}
    </svg>
  );
}
