// 传输层给用户看的说明，繁体这份。形状由简体那份（text.ts）定，少一条、多一条或签名不一样，类型检查就报错。
// 模块顶层只放字面量和函数。
import type { TransportText } from "./text.ts";

export const TRANSPORT_HANT: TransportText = {
  notConfigured: (reasons) => `AI 還沒設定好：${reasons}`,
  idleTimeout: "回應傳到一半斷了，請重試。",
  hardTimeout: (seconds) => `請求超過 ${seconds} 秒上限，可能是服務忙碌或這一段太長。概覽可以在設定頁把「概覽分塊」改成「較短」再試。`,
  network: (baseUrl) => `連不上 ${baseUrl}。請檢查網址是否正確、服務是否在執行，以及是否已在設定頁授權。`,
  tooLarge: "回應超過 2 MiB 上限。",
  incomplete: "AI 回應不完整，請重試。",
  canceled: "任務已取消。",
  refusedWith: (reason) => `模型拒絕了這次請求：${reason}`,
  refused: "模型拒絕了這次請求。可以換一個模型再試。",
  badKey: "服務拒絕了這把金鑰，請在設定裡檢查金鑰和網址是否相符。",
  localOriginRejected:
    "本機的服務拒絕了來自瀏覽器擴充功能的請求，和金鑰無關。用的是 Ollama 的話，在啟動它的環境裡把 OLLAMA_ORIGINS 設成 chrome-extension://*，再重新啟動 Ollama。",
  notFound: "服務傳回 404，多半是模型名稱寫錯或 API 網址不對，請到設定頁核對。",
  rateLimited: "服務限流了，稍等一下再試。",
  serviceError: (status, detail) => `AI 服務出錯（HTTP ${status}）：${detail}`,
  serviceBusy: (status) => `AI 服務暫時忙碌或出錯（HTTP ${status}），請稍後再試。`,
  failed: "AI 請求失敗。",
  retrying: (limited, seconds) => `${limited ? "服務限流" : "服務忙碌"}，${seconds} 秒後重試…`,
};
