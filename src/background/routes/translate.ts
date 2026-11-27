// 翻译端口（整理字幕也走这条）：只收侧边栏。发起翻译的消息每条都重查一次启用；页面断开只退订它自己。
import type { PortSpec } from "../router.ts";
import type { TranslateService } from "../services/translate.ts";
import type { TranslateIn } from "../../shared/messages/translate.ts";
import { hasOnly, isPlainObject, isSeconds, isVideoKey } from "./validate.ts";

export interface TranslatePortDeps {
  readonly translate: Pick<TranslateService, "start" | "stop" | "leave">;
}

function isTranslateIn(message: unknown): message is TranslateIn {
  if (!isPlainObject(message)) return false;
  if (message.type === "translate.stop") return hasOnly(message, ["type"]);
  if (message.type !== "translate.start" || !isVideoKey(message.video)) return false;
  const optional = ["fromSec", "purpose", "storedOnly", "tabId"].filter((key) => Object.hasOwn(message, key));
  return (
    hasOnly(message, ["type", "video", ...optional]) &&
    (!optional.includes("fromSec") || isSeconds(message.fromSec)) &&
    (!optional.includes("purpose") || message.purpose === "tidy") &&
    (!optional.includes("storedOnly") || message.storedOnly === true) &&
    (!optional.includes("tabId") || (Number.isSafeInteger(message.tabId) && Number(message.tabId) >= 0))
  );
}

export function translatePort({ translate }: TranslatePortDeps): { readonly translate: PortSpec<"translate"> } {
  return {
    translate: {
      senders: ["panel"],
      validate: isTranslateIn,
      starts: (message) => message.type === "translate.start",
      onConnect(port) {
        const listener = { id: port.id, post: port.post };
        return {
          onMessage(message) {
            if (message.type === "translate.stop") return translate.stop(port.id);
            return translate.start(message.video, { origin: "user", fromSec: message.fromSec, purpose: message.purpose, storedOnly: message.storedOnly === true, tabId: message.tabId, listener });
          },
          onDisconnect: () => translate.leave(port.id),
        };
      },
    },
  };
}
