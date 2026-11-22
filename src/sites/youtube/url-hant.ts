// 简幕替 YouTube 字幕轨起的名字，繁体这份：没写名字的轨和来源未确认的轨。标识里照旧是简体那份，只在显示时换。
// 只从 url.ts 引用，跟它一起只在构建开关 FEATURE_YOUTUBE 打开时进包。模块顶层只放字面量。
export const TRACK_NAMES_HANT = {
  unnamed: "YouTube 轉錄稿",
  unconfirmed: "YouTube 轉錄稿（來源未確認）",
};
