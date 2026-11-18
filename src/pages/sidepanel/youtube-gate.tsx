// 没认出视频时的说明，YouTube 构建里用这一份：没在 YouTube 上启用时带「在 YouTube 上启用」按钮。
// 授权前扩展看不到标签页地址，分不出是不是 YouTube 页面，所以认不出视频的页面都带这个按钮。
// 只从构建开关的分支引用，开关关着时整个模块不进包。
import { useEffect, useMemo, useState } from "preact/hooks";
import { createYoutubeAccess } from "../shared/youtube-access.ts";
import { StateBlock } from "../shared/ui/state-block.tsx";
import type { Panel } from "./panel.ts";

const TITLE = "打开一个 B 站或 YouTube 视频";
const READY = "在视频播放页打开侧边栏，就能读字幕、生成概览、提问和记笔记。";

export function YoutubeNoVideo({ panel }: { readonly panel: Panel }) {
  const access = useMemo(() => createYoutubeAccess(), []);
  const [failed, setFailed] = useState<string | null>(null);
  const granted = access.granted.value;
  useEffect(() => () => access.stop(), [access]);
  // 在别处启用了（设置页、扩展管理页），也重新认一次当前标签页。
  useEffect(() => {
    if (granted) void panel.follow.refresh();
  }, [granted]);

  if (granted !== false) return <StateBlock title={TITLE} impact={READY} />;
  const enable = (): void => {
    // 授权框要在点击里直接弹，前面不能有等待。
    void access.enable().then((outcome) => {
      if (outcome === "granted") {
        setFailed(null);
        void panel.follow.refresh();
      } else if (outcome === "declined") {
        setFailed("没有授权，YouTube 上暂时用不了。授权框没弹出来的话，到设置页启用。");
      } else {
        setFailed("这里弹不出授权框，请到设置页启用。");
        panel.openSettingsAt("youtube");
      }
    });
  };
  return (
    <StateBlock
      title={TITLE}
      impact="B 站视频页直接能用。YouTube 要先启用，简幕才读得到它的页面。"
      {...(failed ? { next: failed } : {})}
      primary={{ label: "在 YouTube 上启用", onClick: enable }}
      {...(failed ? { secondary: [{ label: "到设置页启用", onClick: () => panel.openSettingsAt("youtube") }] } : {})}
    />
  );
}
