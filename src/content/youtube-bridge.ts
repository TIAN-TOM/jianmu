// YouTube 页面主世界的入口，只在构建开关打开时构建，和 YouTube 的内容脚本一起在用户启用以后由后台动态注册，页面一开始加载就装上。
// 主世界里没有扩展接口，这里只回答内容脚本问播放器上已有哪些字幕轨；构建开关打开时还接住播放器自己取回的字幕，供内容脚本来问。
import { startCaptionCatch } from "../sites/youtube/page/caption-catch.ts";
import { startMainBridge } from "../sites/youtube/page/main-bridge.ts";

// 先叫旧的一份停下，再接住字幕：旧的那份把原来的函数还回去以后，新的再包一层。
startMainBridge(document);
// 关掉开关的构建里这一支连同接住字幕的代码一起裁掉。
const catcher = FEATURE_YOUTUBE_CAPTION_CATCH ? startCaptionCatch : null;
catcher?.(globalThis);
