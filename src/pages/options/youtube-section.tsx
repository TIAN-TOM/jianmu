// 设置页「YouTube」一节：启用就是授予 YouTube 站点的访问权限，停用就是收回。停用以后已开的 YouTube 页面里简幕撤下，本机资料不动。
// 只从构建开关的分支引用，开关关着时整个模块不进包。
import { useEffect, useId, useMemo, useState } from "preact/hooks";
import { createYoutubeAccess } from "../shared/youtube-access.ts";
import { Button } from "../shared/ui/button.tsx";
import { Confirmable, StatusLine } from "./controls.tsx";
import type { Status } from "./state.ts";

export function YoutubeSection() {
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
          ? { text: "已启用。已经开着的 YouTube 页面不用刷新。", tone: "ok" }
          : outcome === "declined"
            ? { text: "没有授权，YouTube 上暂时用不了。", tone: "error" }
            : { text: "没能弹出授权框，请稍后再试。", tone: "error" },
      );
    });
  };
  const disable = async (): Promise<void> => {
    const removed = await access.disable();
    setStatus(removed ? { text: "已停用。", tone: "ok" } : { text: "没能停用，请稍后再试。", tone: "error" });
  };

  return (
    <section class="card" id="youtube" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>YouTube</h2>
      <p class="hint">启用后，简幕在 YouTube 的观看页上读字幕和视频信息。不自动生成，要你在侧边栏点。</p>
      {granted === null ? null : granted ? (
        <Confirmable label="停用" question="停用以后，已开的 YouTube 页面里简幕会撤下，本机的笔记和概览不删。" confirmLabel="停用" onConfirm={() => void disable()} />
      ) : (
        <Button variant="primary" onClick={enable}>
          在 YouTube 上启用
        </Button>
      )}
      <StatusLine status={status} />
    </section>
  );
}
