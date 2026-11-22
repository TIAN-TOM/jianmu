// 沿用同意那一行和列表的简体、英文文案，繁体那份在 carried-hant.ts，形状由简体这份定。
// 只从 carried.tsx 引用，跟它一起只在构建开关 FEATURE_KEEP_CONSENT 打开时进包。模块顶层只放字面量。
export const CARRIED_ZH = {
  notice: "说明更新了，多了几项，照旧在用",
  show: "看看多了什么",
  label: "说明新增的内容",
  read: "在本机多读的",
  send: "多发给模型服务的",
  done: "知道了",
};

export type CarriedText = typeof CARRIED_ZH;

export const CARRIED_EN: CarriedText = {
  notice: "The notices were updated with a few new items. Jianmu keeps working as before",
  show: "See what's new",
  label: "What's new in the notices",
  read: "Also read on this computer",
  send: "Also sent to the model service",
  done: "Got it",
};
