// 设置的读写。密钥只进会话存储，其余设置长期存在本机存储，清除全部数据时两边一起清。
// 一次保存分两步写，失败还要把密钥换回去，交错起来会互相冲掉，所以写都排在同一把独占锁里；
// 读用共享锁，不会读到保存做到一半的状态。
import type { ActivationKind, NoticeStatus } from "../core/consent.ts";
import { API_KEY_SESSION_KEY, SETTINGS_LOCK_NAME, SETTINGS_STORAGE_KEY } from "../shared/names.ts";
import {
  ACTIVATION_CONFIRMED,
  activationStatus,
  normalize,
  type NormalizedSettings,
  type SettingsInput,
} from "../shared/settings-schema.ts";
import { clearTargets } from "../shared/storage-plan.ts";
import type { Locks } from "./locks.ts";
import { readItem, type ExtensionStorage } from "./storage.ts";

export interface SettingsStoreDeps {
  readonly storage: ExtensionStorage;
  readonly locks: Locks;
}

export interface SettingsStore {
  /** 读出完整设置，含会话里的密钥。 */
  readonly load: () => Promise<NormalizedSettings>;
  /** 规整后分开存：密钥进会话，其余进本机。返回规整后的完整设置。 */
  readonly save: (input: unknown) => Promise<NormalizedSettings>;
  /** 在已存的设置上改几项再存，读和写在同一次排队里做完。外观、卡片开关这类即改即存的设置用。 */
  readonly update: (patch: SettingsInput) => Promise<NormalizedSettings>;
  /** 启用确认还算不算数，不算时给出这次要显示的说明。 */
  readonly activation: () => Promise<NoticeStatus<ActivationKind>>;
  /** 用户点了「启用简幕」：记下当前说明的版本和指纹。 */
  readonly confirmActivation: () => Promise<NormalizedSettings>;
  /** 清除全部数据时清两个存储区，和保存排同一把锁：保存要么整段在清除之前、随后被清掉，要么整段在之后。 */
  readonly clearAll: () => Promise<void>;
}

const fieldsOf = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null ? { ...value } : {};

// 密钥只认会话里的那份：本机设置里就算多出密钥字段也被这里盖掉，下次写入时消失。
// 记录没有来源就按没填：规整时「没记来源归到当前地址」只给表单刚填的密钥用，存着的密钥不能这样跟到别家。
function compose(stored: unknown, secret: unknown): NormalizedSettings {
  const { key, origin } = fieldsOf(secret);
  const bound = typeof origin === "string" && origin !== "";
  return normalize({ ...fieldsOf(stored), aiApiKey: bound ? key : "", aiApiKeyOrigin: bound ? origin : "" });
}

function withoutApiKey({ aiApiKey: _key, aiApiKeyOrigin: _origin, ...rest }: NormalizedSettings) {
  return rest;
}

// 启用确认只由 confirmActivation 写：表单里带的旧值写不回来，没带也不会把确认抹掉。
function activationOf({ activationVersion, activationFingerprint }: NormalizedSettings) {
  return { activationVersion, activationFingerprint };
}

export function createSettingsStore({ storage, locks }: SettingsStoreDeps): SettingsStore {
  const exclusive = <T>(work: () => T) => locks.exclusive(SETTINGS_LOCK_NAME, work);
  const shared = <T>(work: () => T) => locks.shared(SETTINGS_LOCK_NAME, work);

  // 下面两个只能在锁里调用，锁里不能再走 load、save。
  async function read(): Promise<NormalizedSettings> {
    const [stored, secret] = await Promise.all([
      readItem(storage.local, SETTINGS_STORAGE_KEY),
      readItem(storage.session, API_KEY_SESSION_KEY),
    ]);
    return compose(stored, secret);
  }

  // 先写会话，监听本机存储的页面收到变化时就能读到新密钥。
  async function write(settings: NormalizedSettings): Promise<NormalizedSettings> {
    // 本机存储写不进去（比如写满了）时把会话里的密钥换回原样：不然留下新密钥配旧服务商，
    // 密钥按来源对不上被丢掉，原来能用的那把也没了。
    const previous = await readItem(storage.session, API_KEY_SESSION_KEY);
    const { aiApiKey: key, aiApiKeyOrigin: origin } = settings;
    if (key) await storage.session.set({ [API_KEY_SESSION_KEY]: { key, origin } });
    else await storage.session.remove(API_KEY_SESSION_KEY);
    try {
      await storage.local.set({ [SETTINGS_STORAGE_KEY]: withoutApiKey(settings) });
    } catch (error) {
      try {
        if (previous) await storage.session.set({ [API_KEY_SESSION_KEY]: previous });
        else await storage.session.remove(API_KEY_SESSION_KEY);
      } catch {
        // 换不回去也照常报原来的错。
      }
      throw error;
    }
    return settings;
  }

  return {
    load: () => shared(read),
    save: (input) => exclusive(async () => write({ ...normalize(input), ...activationOf(await read()) })),
    update: (patch) =>
      exclusive(async () => {
        const current = await read();
        return write({ ...normalize({ ...current, ...patch }), ...activationOf(current) });
      }),
    activation: () => shared(async () => activationStatus(await readItem(storage.local, SETTINGS_STORAGE_KEY))),
    confirmActivation: () => exclusive(async () => write({ ...(await read()), ...ACTIVATION_CONFIRMED })),
    clearAll: () =>
      exclusive(async () => {
        const { local, session } = clearTargets("all");
        await storage.local.remove([...local]);
        await storage.session.remove([...session]);
      }),
  };
}
