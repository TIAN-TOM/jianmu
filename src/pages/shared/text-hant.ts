// 几个页面共用的界面文案，繁体这份。形状由简体那份（text-zh.ts）定，少一条、多一条或者函数签名不一样，类型检查就报错。
// 模块顶层只放字面量和函数。
import type { SharedText } from "./text-zh.ts";

export const SHARED_HANT: SharedText = {
  close: "關閉",
  back: "返回",
  serviceSaid: "服務的原話",
  jumpTo: (time) => `跳到 ${time}`,

  modes: { label: "模式", skim: "速讀", study: "精讀" },

  chapters: {
    label: "章節",
    key: "重點",
    heading: (count, keyCount) => (keyCount > 0 ? `章節 ${count}，重點 ${keyCount}` : `章節 ${count}`),
    total: (time) => `全長 ${time}`,
  },

  verdict: {
    stars: (stars: number, name: string) => `5 星中的 ${stars} 星，${name}`,
    label: "一句話結論",
    stale: "根據舊字幕",
    incomplete: "不完整",
    basis: {
      transcript: "根據字幕",
      "official-summary": "根據 B 站官方總結，沒有通讀字幕",
      "title-description": "根據標題和簡介",
      "legacy-unknown": "根據不明（舊版）",
    },
  },

  activation: {
    sections: { read: "會讀取什麼", purpose: "用來做什麼", store: "本機存什麼" },
    title: "先看看簡幕會讀取什麼",
    titleUpdated: "簡幕要多讀取一樣東西",
    confirm: "啟用簡幕",
    confirmUpdated: "繼續使用簡幕",
    saving: "正在啟用",
    footnote: "啟用後只在本機讀取和處理。要傳送給模型服務，得另外在設定頁同意。",
    showFull: "查看完整說明",
  },

  stale: {
    title: "簡幕需要重新載入",
    impact: "簡幕的檔案更新了，背景程式還在執行舊版本，這個頁面暫時無法使用。重新載入後筆記和概覽都還在；沒選「在這台電腦上記住金鑰」的話，要再填一次金鑰。",
    reload: "重新載入簡幕",
    note: "開著的簡幕頁面會關掉，再打開就好",
  },

  autoPaused: {
    reasons: {
      quota: "額度用完了，「打開就出結論」先停了",
      key: "金鑰被拒，「打開就出結論」先停了",
      "local-origin": "本機的服務不接受瀏覽器擴充功能的請求，「打開就出結論」先停了",
    },
    resume: "恢復",
  },

  setup: {
    notice: {
      key: "API 金鑰隨瀏覽器重新啟動或擴充功能更新清空了，要在設定頁重新填寫；勾選「在這台電腦上記住金鑰」就不用每次填",
      consent: "字幕不用設定就能看；概覽和問答要先在設定頁勾選資料說明",
      none: "字幕不用設定就能看；概覽和問答要先設定 AI 服務",
    },
    reason: {
      key: "先在設定頁重新填寫 API 金鑰",
      consent: "先在設定頁勾選資料說明",
      none: "先在設定頁設定 AI 服務",
    },
    card: {
      key: "API 金鑰隨瀏覽器重新啟動或擴充功能更新清空了，生成概覽要先到設定頁重新填寫；勾選「在這台電腦上記住金鑰」就不用每次填。",
      consent: "生成概覽要先到設定頁勾選資料說明。",
      none: "還沒設定 AI 服務，生成概覽要先填寫服務商和金鑰。",
    },
    action: {
      key: "重新填寫金鑰",
      consent: "去看資料說明",
      none: "設定 AI 服務",
    },
  },
};
