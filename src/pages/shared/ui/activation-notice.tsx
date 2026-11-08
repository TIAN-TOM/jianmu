// 首次启用说明：确认前侧边栏只有这一页，设置页顶部也是它，确认状态两边共用。
// 说明更新了就只列新增的内容，完整说明收在下面。点按钮由页面去写确认，写入失败时留在这一页说明原因。
import { useId } from "preact/hooks";
import { ACTIVATION_ICON, activationCopy, type ActivationSection } from "./activation.ts";
import { Button } from "./button.tsx";

export type ActivationPhase = "idle" | "saving" | "failed";

export interface ActivationNoticeProps {
  /** 确认过旧版说明，这次只列新增的内容。 */
  readonly updated: boolean;
  readonly sections: readonly ActivationSection[];
  /** 说明更新时可以展开看的完整说明。 */
  readonly fullSections?: readonly ActivationSection[];
  readonly phase: ActivationPhase;
  /** 写入失败的原因，phase 是 failed 时显示。 */
  readonly error?: string;
  readonly onConfirm: () => void;
}

function Sections({ sections, level }: { readonly sections: readonly ActivationSection[]; readonly level: 3 | 4 }) {
  const Heading = level === 3 ? "h3" : "h4";
  return (
    <>
      {sections.map((section) => (
        <section key={section.kind} class="activation-section" data-kind={section.kind}>
          <Heading class="activation-heading">{section.heading}</Heading>
          <ul class="activation-lines">
            {section.lines.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

export function ActivationNotice({ updated, sections, fullSections, phase, error, onConfirm }: ActivationNoticeProps) {
  const id = useId();
  const copy = activationCopy(updated);
  const saving = phase === "saving";
  return (
    <section class="activation" aria-labelledby={`${id}-title`} data-updated={updated ? "true" : undefined}>
      <img class="activation-icon" src={ACTIVATION_ICON} width={32} height={32} alt="" />
      <h2 class="activation-title" id={`${id}-title`}>
        {copy.title}
      </h2>
      <Sections sections={sections} level={3} />
      {updated && fullSections?.length ? (
        <details class="activation-full">
          <summary>{copy.showFull}</summary>
          <Sections sections={fullSections} level={4} />
        </details>
      ) : null}
      <div class="activation-foot">
        {phase === "failed" && error ? (
          <p class="activation-error" role="alert">
            {error}
          </p>
        ) : null}
        <Button variant="primary" wide disabled={saving} onClick={onConfirm}>
          {saving ? copy.saving : copy.confirm}
        </Button>
        <p class="activation-footnote">{copy.footnote}</p>
      </div>
    </section>
  );
}
