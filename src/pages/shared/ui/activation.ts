// 首次启用说明的版面和文案：启用说明的条目按「会读取什么」「用来做什么」「本机存什么」分三节。
// 侧边栏和设置页共用。条目先由页面排成给用户看的行（合并显示的几条已经并好），这里只分节。
import type { ActivationKind } from "../../../core/consent.ts";
import { sharedTextOf } from "../text.ts";
import type { UiLang } from "../ui-lang.ts";

export interface ActivationLine {
  readonly kind: ActivationKind;
  readonly text: string;
}

export interface ActivationSection {
  readonly kind: ActivationKind;
  readonly heading: string;
  readonly lines: readonly string[];
}

const SECTIONS: readonly ActivationKind[] = ["read", "purpose", "store"];

/** 按固定顺序分三节，节内保持原来的顺序；没有条目的一节不显示。 */
export function activationSections(lines: readonly ActivationLine[], lang: UiLang): ActivationSection[] {
  const headings = sharedTextOf(lang).activation.sections;
  return SECTIONS.map((kind) => ({
    kind,
    heading: headings[kind],
    lines: lines.filter((line) => line.kind === kind).map((line) => line.text),
  })).filter((section) => section.lines.length > 0);
}

export interface ActivationCopy {
  readonly title: string;
  readonly confirm: string;
  readonly saving: string;
  readonly footnote: string;
  readonly showFull: string;
}

/** updated：确认过旧版说明，这次只列新增的内容。 */
export function activationCopy(updated: boolean, lang: UiLang): ActivationCopy {
  const t = sharedTextOf(lang).activation;
  return {
    title: updated ? t.titleUpdated : t.title,
    confirm: updated ? t.confirmUpdated : t.confirm,
    saving: t.saving,
    footnote: t.footnote,
    showFull: t.showFull,
  };
}

/** 说明顶上的扩展图标，扩展页面都在同一层目录里。 */
export const ACTIVATION_ICON = "../icons/icon-48.png";
