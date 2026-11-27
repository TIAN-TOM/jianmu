// 页面和导出共用的繁体星级短词。
export const VERDICT_HANT = {
  5: "推薦看", 4: "值得看", 3: "挑著看", 2: "可略過", 1: "可跳過", unknown: "資訊不足",
};

// 旧版结论中的繁体写法，只在读存着的记录时认。
export const LEGACY_RATINGS_HANT = {
  推薦看: 5,
  可跳過: 1,
  值得看完整視頻: 5,
  值得看完整影片: 5,
  可以跳過: 1,
  看概覽就夠: 2,
} as const;
