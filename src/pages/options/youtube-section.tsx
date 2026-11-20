// 设置页「YouTube」一节：启用就是授予 YouTube 站点的访问权限，停用就是收回。停用以后已开的 YouTube 页面里简幕撤下，本机资料不动。
// 只从构建开关的分支引用，开关关着时整个模块不进包。
import { useEffect, useId, useMemo, useState } from "preact/hooks";
import { createYoutubeAccess } from "../shared/youtube-access.ts";
import { Button } from "../shared/ui/button.tsx";
import { Confirmable, StatusLine } from "./controls.tsx";
import type { Status } from "./state.ts";
import { uiLang } from "../shared/ui-lang.ts";
import { youtubeText } from "./youtube-text.ts";

export function YoutubeSection() {
  const t = youtubeText(uiLang.value);
  const id = useId();
  const access = useMemo(() => createYoutubeAccess(), []);
  const [status, setStatus] = useState<Status | null>(null);
  useEffect(() => () => access.stop(), [access]);
  const granted = access.granted.value;

  const enable = (): void => {
    // 授权框要在点击里直接弹，前面不能有等待。
    void access.enable().then((outcome) => {
      setStatus(
        outcome === "granted"
          ? { text: t.granted, tone: "ok" }
          : outcome === "declined"
            ? { text: t.declined, tone: "error" }
            : { text: t.noPrompt, tone: "error" },
      );
    });
  };
  const disable = async (): Promise<void> => {
    const removed = await access.disable();
    setStatus(removed ? { text: t.disabled, tone: "ok" } : { text: t.disableFailed, tone: "error" });
  };

  return (
    <section class="card" id="youtube" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t.title}</h2>
      <p class="hint">{t.hint}</p>
      {granted === null ? null : granted ? (
        <Confirmable label={t.disable} question={t.disableQuestion} confirmLabel={t.disableConfirm} onConfirm={() => void disable()} />
      ) : (
        <Button variant="primary" onClick={enable}>
          {t.enable}
        </Button>
      )}
      <StatusLine status={status} />
    </section>
  );
}
