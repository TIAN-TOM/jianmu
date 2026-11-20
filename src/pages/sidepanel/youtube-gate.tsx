// 没认出视频时的说明，YouTube 构建里用这一份：没在 YouTube 上启用时带「在 YouTube 上启用」按钮。
// 授权前扩展看不到标签页地址，分不出是不是 YouTube 页面，所以认不出视频的页面都带这个按钮。
// 只从构建开关的分支引用，开关关着时整个模块不进包。
import { useEffect, useMemo, useState } from "preact/hooks";
import { createYoutubeAccess } from "../shared/youtube-access.ts";
import { StateBlock } from "../shared/ui/state-block.tsx";
import { uiLang } from "../shared/ui-lang.ts";
import type { Panel } from "./panel.ts";
import { youtubeText } from "./youtube-text.ts";

export function YoutubeNoVideo({ panel }: { readonly panel: Panel }) {
  const access = useMemo(() => createYoutubeAccess(), []);
  const [failed, setFailed] = useState<"declined" | "noPrompt" | null>(null);
  const t = youtubeText(uiLang.value);
  const granted = access.granted.value;
  useEffect(() => () => access.stop(), [access]);
  // 在别处启用了（设置页、扩展管理页），也重新认一次当前标签页。
  useEffect(() => {
    if (granted) void panel.follow.refresh();
  }, [granted]);

  if (granted !== false) return <StateBlock title={t.title} impact={t.ready} />;
  const enable = (): void => {
    // 授权框要在点击里直接弹，前面不能有等待。
    void access.enable().then((outcome) => {
      if (outcome === "granted") {
        setFailed(null);
        void panel.follow.refresh();
      } else if (outcome === "declined") {
        setFailed("declined");
      } else {
        setFailed("noPrompt");
        panel.openSettingsAt("youtube");
      }
    });
  };
  return (
    <StateBlock
      title={t.title}
      impact={t.impact}
      {...(failed ? { next: t[failed] } : {})}
      primary={{ label: t.enable, onClick: enable }}
      {...(failed ? { secondary: [{ label: t.toSettings, onClick: () => panel.openSettingsAt("youtube") }] } : {})}
    />
  );
}
