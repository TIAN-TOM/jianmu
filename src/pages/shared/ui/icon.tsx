// 界面图标和判断标记。都是装饰：意思由旁边的文字或按钮的无障碍名称说，读屏跳过图形。
import { ICON_GRID, ICONS, MARK_SET_NAMES, MARK_SETS, type IconName, type IconPart } from "./icons.ts";
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
      return (
        <rect
          x={part.x}
          y={part.y}
          width={part.width}
          height={part.height}
          rx={part.rx}
          class={part.off ? "mark-off" : undefined}
          fill={part.solid ? "currentColor" : undefined}
          stroke={part.solid || part.off ? "none" : undefined}
          stroke-dasharray={part.dash === undefined ? undefined : `${part.dash} ${part.dash}`}
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

/**
 * 判断标记。档位名总在旁边用文字写出来，标记本身不进读屏。三套画法都画出来，主题样式表按 html 上的主题只显示其中一套，
 * 换主题时已经打开的页面马上跟着换；大小也由样式表按字号定。
 */
export function VerdictMark({ shape }: { readonly shape: MarkShape }) {
  return (
    <span class="verdict-mark" data-shape={shape} aria-hidden="true">
      {MARK_SET_NAMES.map((set) => {
        const drawing = MARK_SETS[set][shape];
        return (
          <svg
            key={set}
            class="mark-set"
            data-set={set}
            viewBox={`0 0 ${drawing.width} ${drawing.height}`}
            width={drawing.width}
            height={drawing.height}
            fill="none"
            stroke="currentColor"
            stroke-width={drawing.stroke}
            stroke-linecap="round"
            stroke-linejoin="round"
            focusable="false"
          >
            {drawing.parts.map((part, index) => (
              <Part key={index} part={part} />
            ))}
          </svg>
        );
      })}
    </span>
  );
}
