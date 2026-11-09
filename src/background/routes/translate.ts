// 翻译端口：只收侧边栏。发起翻译的消息每条都重查一次启用；页面断开只退订它自己。
import type { PortSpec } from "../router.ts";
import type { TranslateService } from "../services/translate.ts";
import type { TranslateIn } from "../../shared/messages/translate.ts";
import { isVideoKey } from "./validate.ts";

export interface TranslatePortDeps {
  readonly translate: Pick<TranslateService, "start" | "stop" | "leave">;
}

const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const hasOnly = (value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));

const isSecond = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function isTranslateIn(message: unknown): message is TranslateIn {
  if (!isPlainObject(message)) return false;
  if (message.type === "translate.stop") return hasOnly(message, ["type"]);
  if (message.type !== "translate.start" || !isVideoKey(message.video)) return false;
  return Object.hasOwn(message, "fromSec") ? hasOnly(message, ["type", "video", "fromSec"]) && isSecond(message.fromSec) : hasOnly(message, ["type", "video"]);
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
            return translate.start(message.video, { origin: "user", fromSec: message.fromSec, listener });
          },
          onDisconnect: () => translate.leave(port.id),
        };
      },
    },
  };
}
