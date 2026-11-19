// YouTube 页面主世界的入口，只在构建开关打开时构建，和 YouTube 的内容脚本一起在用户启用以后由后台动态注册。
// 主世界里没有扩展接口，这里只回答内容脚本问播放器上已有哪些字幕轨。
import { startMainBridge } from "../sites/youtube/page/main-bridge.ts";

startMainBridge(document);
