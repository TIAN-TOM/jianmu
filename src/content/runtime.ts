/// <reference types="chrome" />
// 内容脚本和扩展之间的消息。请求一律回结果；扩展重新加载以后旧脚本和扩展断了联系，alive() 变成假，由调用方收场。
import { fail, isErrorCode } from "../core/errors.ts";
import type { Api, Reply, RouteName } from "../shared/messages.ts";

type Listener = (message: unknown, sender: { readonly id?: string; readonly tab?: unknown }, reply: (value: unknown) => void) => boolean | void;

/** 内容脚本用到的那几样 chrome.runtime，测试注入替身。 */
export interface RuntimeLike {
  readonly id?: string | undefined;
  getURL(path: string): string;
  sendMessage(message: unknown): Promise<unknown>;
  readonly onMessage: { addListener(listener: Listener): void; removeListener(listener: Listener): void };
}

export interface ContentRuntime {
  /** 和扩展的联系还在：扩展重新加载以后，旧脚本这里一直是假。 */
  readonly alive: () => boolean;
  send<K extends RouteName>(type: K, req: Api[K]["req"]): Promise<Reply<K>>;
  /** 收后台和扩展页面发来的消息，只收本扩展的。回撤销函数。 */
  listen(listener: Listener): () => void;
  /** 扩展页面的完整地址；扩展断了联系时是 null。 */
  url(path: string): string | null;
}

// 后台正在醒、还没挂上监听时会这样报错，重发一次就好；别的错都不重发。
const UNREACHABLE = ["Could not establish connection", "Receiving end does not exist"];
const RETRY_DELAY_MS = 200;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createContentRuntime(runtime: () => RuntimeLike | undefined, sleep: (ms: number) => Promise<void> = delay): ContentRuntime {
  const alive = (): boolean => {
    try {
      return Boolean(runtime()?.id);
    } catch {
      return false;
    }
  };

  async function send<K extends RouteName>(type: K, req: Api[K]["req"]): Promise<Reply<K>> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (!alive()) return fail("BACKGROUND_UNREACHABLE");
      try {
        const raw = (await runtime()?.sendMessage({ type, req })) as { ok?: unknown; code?: unknown } | undefined;
        if (raw?.ok === true || (raw?.ok === false && isErrorCode(raw.code))) return raw as Reply<K>;
        return fail("BACKGROUND_FAILED");
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (attempt === 2 || !UNREACHABLE.some((pattern) => text.includes(pattern))) break;
        await sleep(RETRY_DELAY_MS);
      }
    }
    return fail(alive() ? "BACKGROUND_FAILED" : "BACKGROUND_UNREACHABLE");
  }

  return {
    alive,
    send,
    listen(listener) {
      const filtered: Listener = (message, sender, reply) => {
        if (!alive() || sender?.id !== runtime()?.id) return false;
        return listener(message, sender, reply);
      };
      runtime()?.onMessage.addListener(filtered);
      return () => {
        try {
          runtime()?.onMessage.removeListener(filtered);
        } catch {
          // 扩展已经断了联系，监听跟着失效。
        }
      };
    },
    url(path) {
      if (!alive()) return null;
      try {
        return runtime()?.getURL(path) ?? null;
      } catch {
        return null;
      }
    },
  };
}
