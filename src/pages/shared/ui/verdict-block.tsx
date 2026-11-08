// 结论块：标记加档位名、右边的菜单位置，结论句，依据行。侧边栏和卡片共用。
// 档位名用文字读出来，标记不进读屏；结论句不截断。
import type { ComponentChildren } from "preact";
import { Badge } from "./button.tsx";
import { VerdictMark } from "./icon.tsx";
import { basisText, markOf, type BasisSource } from "./verdict.ts";

export interface VerdictBlockProps {
  /** 判断档位，照数据写；认不出的档位只写结论句，不画标记。 */
  readonly label: string;
  readonly text: string;
  readonly basis?: BasisSource | null;
  /** 换过字幕：这份结论基于旧字幕。 */
  readonly staleTranscript?: boolean;
  /** 概览有失败的块，结论只基于部分内容。 */
  readonly incomplete?: boolean;
  /** 右上角的菜单，由页面放进来。 */
  readonly menu?: ComponentChildren;
}

export function VerdictBlock({ label, text, basis, staleTranscript = false, incomplete = false, menu }: VerdictBlockProps) {
  const shape = markOf(label);
  const name = shape ? label.trim() : "";
  return (
    <section class="verdict" aria-label="一句话结论" data-shape={shape ?? undefined}>
      <div class="verdict-head">
        {shape ? (
          <span class="verdict-label">
            <VerdictMark shape={shape} />
            <span class="verdict-name">{name}</span>
          </span>
        ) : (
          <span class="verdict-label" />
        )}
        {menu ? <span class="verdict-menu">{menu}</span> : null}
      </div>
      <p class="verdict-text">{text}</p>
      {basis || staleTranscript || incomplete ? (
        <p class="verdict-basis">
          {basis ? <span>{basisText(basis)}</span> : null}
          {incomplete ? <Badge tone="warn">不完整</Badge> : null}
          {staleTranscript ? <Badge tone="line">基于旧字幕</Badge> : null}
        </p>
      ) : null}
    </section>
  );
}
