// 库名、仓库名和存储键集中定义在这里。新加的要同时在 storage-plan.ts 登记。
export const DATABASE_NAME = "jianmu";

export const STORE_NAMES = ["notes", "overviews", "qa", "cache", "translations", "imports", "channels"] as const;
export type StoreName = (typeof STORE_NAMES)[number];

export const SETTINGS_STORAGE_KEY = "jianmu_settings";
export const TRIAGE_STORAGE_KEY = "jianmu_triage";
export const CAPABILITY_STORAGE_KEY = "jianmu_model_caps";
export const RELAX_STORAGE_KEY = "jianmu_relaxed_params";
// 画面分析的模型能不能看图，探测过的结果。只有打开解释当前画面的构建会写，清除时照样要认得。
export const IMAGE_PROBE_STORAGE_KEY = "jianmu_image_probe";
// 解释当前画面的结果（只有文字，没有截图），在会话存储里，同样只有打开这项功能的构建会写。
export const FRAME_RESULTS_KEY = "jianmu_frame_results";
export const API_KEY_SESSION_KEY = "jianmu_api_key";
export const API_KEY_LOCAL_KEY = "jianmu_api_key_local";
export const SETTINGS_REVISION_KEY = "jianmu_settings_revision";
export const AUTO_LEDGER_KEY = "jianmu_auto_ledger";
export const WATCH_SESSIONS_KEY = "jianmu_watch_sessions";
export const APPEARANCE_CACHE_KEY = "jianmu_appearance";
export const SITE_BACKOFF_KEY = "jianmu_site_backoff";
/** 文件换了自己重新加载的记录：对着哪个新标识重载过几次，防止文件没换全时来回重载。 */
export const SELF_RELOAD_KEY = "jianmu_self_reload";
/** 每项功能最近一次模型请求服务回报的用量，只在会话存储里。 */
export const USAGE_STORAGE_KEY = "jianmu_usage";
/** 哪些窗口开着侧边栏，只在会话存储里。 */
export const OPEN_PANELS_KEY = "jianmu_open_panels";

// 扩展自己的页面，相对扩展根目录，不带前导斜杠；认发送方时拼成完整地址再比。
export const PAGE_PATHS = Object.freeze({
  sidepanel: "pages/sidepanel.html",
  options: "pages/options.html",
  triage: "pages/triage.html",
  card: "pages/card.html",
} as const);

// 设置页「关于」一节的五个链接：公开仓库的发布页、源码，隐私政策和反馈问题的页面，以及 README 里的赞助一节（中英两份 README 各一个地址）。
export const RELEASES_URL = "https://github.com/TIAN-TOM/jianmu/releases";
export const SOURCE_URL = "https://github.com/TIAN-TOM/jianmu";
export const PRIVACY_POLICY_URL = "https://github.com/TIAN-TOM/jianmu/blob/main/PRIVACY.md";
export const ISSUES_URL = "https://github.com/TIAN-TOM/jianmu/issues";
export const SPONSOR_URLS = Object.freeze({
  zh: "https://github.com/TIAN-TOM/jianmu#赞助",
  en: "https://github.com/TIAN-TOM/jianmu/blob/main/README.en.md#sponsor",
} as const);

// 注入视频网站页面的节点标识，和页面、卡片之间互发消息的标记，一律以 jianmu- 开头。
export const INJECTED = {
  overlay: "jianmu-overlay",
  noteButton: "jianmu-note-button",
  noteLabel: "jianmu-note-label",
  frameButton: "jianmu-frame-button",
  frameLabel: "jianmu-frame-label",
  cardFrame: "jianmu-card",
  cardMessage: "jianmu-card-message",
  hostMessage: "jianmu-card-host",
  instance: "jianmu-content-instance",
  // 扩展重新加载以后新注入的一份看不到旧的全局变量，用这个页面事件叫旧的撤下。
  contentRetire: "jianmu-content-retire",
  // YouTube 页面主世界的只读小桥和内容脚本之间的页面事件：问、答，和新注入的一份叫旧的停下。
  tracksAsk: "jianmu-tracks-ask",
  tracksAnswer: "jianmu-tracks-answer",
  bridgeRetire: "jianmu-bridge-retire",
  // 同一座小桥上问播放器取回的字幕：问、答。
  captionsAsk: "jianmu-captions-ask",
  captionsAnswer: "jianmu-captions-answer",
  // 内容脚本接上时叫小桥开始接字幕，撤下时叫它停下、把接住的清掉。
  captionsSwitch: "jianmu-captions-switch",
} as const;

// 工具栏图标右键菜单里简幕自己的几项，以 jianmu- 开头。
export const ACTION_MENU = {
  triage: "jianmu-menu-triage",
  inPageCard: "jianmu-menu-in-page-card",
  autoOverview: "jianmu-menu-auto-overview",
} as const;

// 卡片的明暗跟着所在的页面：内容脚本插入卡片时写在卡片地址 # 后面的参数名，和之后页面换了明暗时发给卡片的消息类型。
export const CARD_TONE = { param: "tone", message: "tone" } as const;

// 设置读写用的 Web Locks 锁名，不是存储键，不用登记。
export const SETTINGS_LOCK_NAME = "jianmu_settings";

export const STORAGE_KEYS = [
  SETTINGS_STORAGE_KEY,
  TRIAGE_STORAGE_KEY,
  CAPABILITY_STORAGE_KEY,
  RELAX_STORAGE_KEY,
  IMAGE_PROBE_STORAGE_KEY,
  FRAME_RESULTS_KEY,
  API_KEY_SESSION_KEY,
  API_KEY_LOCAL_KEY,
  SETTINGS_REVISION_KEY,
  AUTO_LEDGER_KEY,
  WATCH_SESSIONS_KEY,
  APPEARANCE_CACHE_KEY,
  SITE_BACKOFF_KEY,
  SELF_RELOAD_KEY,
  USAGE_STORAGE_KEY,
  OPEN_PANELS_KEY,
] as const;
export type StorageKey = (typeof STORAGE_KEYS)[number];
