// 库名、仓库名和存储键集中定义在这里。新加的要同时在 storage-plan.ts 登记。
export const DATABASE_NAME = "jianmu";

export const STORE_NAMES = ["notes", "overviews", "qa", "cache", "translations", "imports", "channels"] as const;
export type StoreName = (typeof STORE_NAMES)[number];

export const SETTINGS_STORAGE_KEY = "jianmu_settings";
export const TRIAGE_STORAGE_KEY = "jianmu_triage";
export const CAPABILITY_STORAGE_KEY = "jianmu_model_caps";
export const RELAX_STORAGE_KEY = "jianmu_relaxed_params";
export const API_KEY_SESSION_KEY = "jianmu_api_key";
export const API_KEY_LOCAL_KEY = "jianmu_api_key_local";
export const SETTINGS_REVISION_KEY = "jianmu_settings_revision";
export const AUTO_LEDGER_KEY = "jianmu_auto_ledger";
export const WATCH_SESSIONS_KEY = "jianmu_watch_sessions";
export const APPEARANCE_CACHE_KEY = "jianmu_appearance";
export const SITE_BACKOFF_KEY = "jianmu_site_backoff";

// 扩展自己的页面，相对扩展根目录，不带前导斜杠；认发送方时拼成完整地址再比。
export const PAGE_PATHS = Object.freeze({
  sidepanel: "pages/sidepanel.html",
  options: "pages/options.html",
  triage: "pages/triage.html",
  card: "pages/card.html",
} as const);

// 注入视频网站页面的节点标识，和页面、卡片之间互发消息的标记，一律以 jianmu- 开头。
export const INJECTED = {
  overlay: "jianmu-overlay",
  noteButton: "jianmu-note-button",
  noteLabel: "jianmu-note-label",
  cardFrame: "jianmu-card",
  cardMessage: "jianmu-card-message",
  hostMessage: "jianmu-card-host",
  instance: "jianmu-content-instance",
} as const;

// 设置读写用的 Web Locks 锁名，不是存储键，不用登记。
export const SETTINGS_LOCK_NAME = "jianmu_settings";

export const STORAGE_KEYS = [
  SETTINGS_STORAGE_KEY,
  TRIAGE_STORAGE_KEY,
  CAPABILITY_STORAGE_KEY,
  RELAX_STORAGE_KEY,
  API_KEY_SESSION_KEY,
  API_KEY_LOCAL_KEY,
  SETTINGS_REVISION_KEY,
  AUTO_LEDGER_KEY,
  WATCH_SESSIONS_KEY,
  APPEARANCE_CACHE_KEY,
  SITE_BACKOFF_KEY,
] as const;
export type StorageKey = (typeof STORAGE_KEYS)[number];
