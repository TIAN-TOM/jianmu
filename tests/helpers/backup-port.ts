// 设置页那头的备份传输接到测试后台上：页面的消息客户端经替身端口连到后台的路由，导出、导入走真实的分段传输。
import type { App } from "../../src/background/app.ts";
import type { Backup } from "../../src/core/backup/format.ts";
import { readBackup } from "../../src/core/backup/format.ts";
import type { Result } from "../../src/core/errors.ts";
import type { PortLike } from "../../src/platform/messaging.ts";
import type { BackupImportReply } from "../../src/shared/messages/data.ts";
import { createPageApi, type PageApi } from "../../src/pages/shared/api.ts";
import { receiveBackup, withBackupImport } from "../../src/pages/options/backup-transfer.ts";
import type { MessageSender } from "../../src/background/senders.ts";
import { senders, type createFakeChrome } from "./chrome.ts";

type Fake = ReturnType<typeof createFakeChrome>;

const hooked = new WeakSet<object>();

type Listener = (...args: never[]) => void;

/** 一个设置页的消息客户端：长连接接到这个后台。 */
export function pageApiOver(fake: Fake, app: Pick<App, "connect">, sender: MessageSender = senders.options()): PageApi {
  if (!hooked.has(fake)) {
    hooked.add(fake);
    fake.chrome.runtime.onConnect.addListener(((port: PortLike) => app.connect(port)) as never);
  }
  return createPageApi({
    runtime: {
      id: fake.chrome.runtime.id,
      sendMessage: () => Promise.reject(new Error("这里只走长连接")),
      onMessage: { addListener() {}, removeListener() {} },
      connect({ name }) {
        const onMessage = new Set<Listener>();
        const onDisconnect = new Set<Listener>();
        // 和浏览器一样，后台另起一轮才收到连接；这之前页面发的先排着。
        let port: ReturnType<Fake["connect"]> | null = null;
        let closed = false;
        const pending: unknown[] = [];
        setImmediate(() => {
          if (closed) return;
          port = fake.connect(name, sender, {
            onPost: (message) => onMessage.forEach((listener) => listener(message as never)),
            onDisconnect: () => onDisconnect.forEach((listener) => listener()),
          });
          for (const message of pending.splice(0)) port.send(message);
        });
        return {
          name,
          postMessage(message: unknown) {
            if (closed || (port && !port.send(message))) throw new Error("端口已经断开");
            if (!port) pending.push(message);
          },
          disconnect() {
            closed = true;
            port?.close();
          },
          onMessage: { addListener: (listener: Listener) => void onMessage.add(listener) },
          onDisconnect: { addListener: (listener: Listener) => void onDisconnect.add(listener) },
        } as unknown as PortLike;
      },
    },
  });
}

export const exportOver = (fake: Fake, app: Pick<App, "connect">, sender?: MessageSender): Promise<Result<Backup>> =>
  receiveBackup(pageApiOver(fake, app, sender));

/** 和设置页一样：先认格式，认得出再分段交给后台。 */
export async function importOver(fake: Fake, app: Pick<App, "connect">, payload: unknown, sender?: MessageSender): Promise<Result<BackupImportReply>> {
  return withBackupImport(pageApiOver(fake, app, sender), async (send) => {
    const read = readBackup(payload);
    if (!read.ok) return read;
    return send(read.value);
  });
}
