// 测试用的视频链接：自造的地址前缀加编号，分 P 和起播时间的写法和 B 站的导出一样；别的站不给链接。
import type { VideoLinkOf } from "../../src/core/notes/markdown.ts";

export function linkFromBase(base: string): VideoLinkOf {
  return (ref, atSec) => {
    if (ref.platform !== "bilibili") return "";
    const url = new URL(`${base}${ref.videoId}`);
    const segment = ref.segment ?? 1;
    if (segment > 1) url.searchParams.set("p", String(segment));
    if (atSec > 0) url.searchParams.set("t", String(atSec));
    return url.toString();
  };
}
