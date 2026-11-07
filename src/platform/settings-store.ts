// 设置的读写。密钥默认只进会话存储；用户勾了记住并保存，才写进独立的本机记录。其余设置长期存在本机存储。
// 一次保存分几步写，失败还要把密钥换回去，交错起来会互相冲掉，所以写都排在同一把独占锁里；
// 读用共享锁，不会读到保存做到一半的状态。
import type { ActivationKind, NoticeStatus } from "../core/consent.ts";
import {
  API_KEY_LOCAL_KEY,
  API_KEY_SESSION_KEY,
  SETTINGS_LOCK_NAME,
  SETTINGS_REVISION_KEY,
  SETTINGS_STORAGE_KEY,
} from "../shared/names.ts";
import {
  ACTIVATION_CONFIRMED,
  activationStatus,
  DATA_CONSENT_CONFIRMED,
  DEFAULTS,
  normalize,
  originOf,
  type NormalizedSettings,
  type SettingsInput,
} from "../shared/settings-schema.ts";
import { clearTargets } from "../shared/storage-plan.ts";
import type { Locks } from "./locks.ts";
import { readItem, restrictToTrustedContexts, type ExtensionStorage } from "./storage.ts";

export interface SettingsStoreDeps {
  readonly storage: ExtensionStorage;
  readonly locks: Locks;
}

/** 读出的设置带着当时的修订号。修订号在规整时丢掉，不进存储。 */
export interface LoadedSettings extends NormalizedSettings {
  readonly settingsRevision: string;
}

export interface WrittenSettings extends LoadedSettings {
  /** 这次写之前在锁里读到的修订号。和表单记着的对不上，说明排队等锁时别的页面改过，表单要重新载入。 */
  readonly previousRevision: string;
}

/** 即改即存的设置。 */
const INSTANT_FIELDS = ["accentTheme", "themeMode", "uiFontScale", "inPageCard"] as const;

/**
 * update 能改的字段，加上清空密钥、关掉记住这两个收回的动作。
 * 写密钥、改来源、换服务商、打开记住都走 save，那里核对修订号。
 */
export type SettingsPatch = Pick<SettingsInput, (typeof INSTANT_FIELDS)[number]> & {
  readonly aiApiKey?: "";
  readonly rememberApiKey?: false;
};

export type SettingsErrorCode = "SETTINGS_STALE" | "REMEMBER_KEY_UNPROTECTED" | "REMEMBER_KEY_UNBOUND";

export interface SettingsError extends Error {
  readonly code: SettingsErrorCode;
}

export interface SettingsStore {
  /** 读出完整设置，含算数的那份密钥。 */
  readonly load: () => Promise<LoadedSettings>;
  /**
   * 表单整份替换已存的设置，规整后分开存，记不记住看表单里的开关。返回规整后的完整设置。
   * 页面要自己补全表单上没有的字段。来源也是：新填的密钥来源留空，归到当前地址，留着旧来源会被当成别家的丢掉；
   * 换了地址后重新贴同一把，要写明新来源，否则按已存的那把算，不跟过去。
   * expectedRevision 用表单打开时记下的修订号，不用这次 load 读到的，在锁里核对，对不上就整次不存（SETTINGS_STALE）：
   * 别处清过密钥或全部数据之后，旧表单写不回去。
   */
  readonly save: (form: SettingsInput, expectedRevision: string) => Promise<WrittenSettings>;
  /**
   * 在已存的设置上改几项再存，读和写在同一次排队里做完。SettingsPatch 之外的字段带来也不认。
   * 不核对修订号：调用方拿 previousRevision 和自己记着的比，判断别的页面改过没有。
   */
  readonly update: (patch: SettingsPatch) => Promise<WrittenSettings>;
  /** 用户勾选或取消数据说明：只有 true 才记下当前说明的版本和指纹，别的值一律清掉。和 update 一样不核对修订号。 */
  readonly setDataConsent: (given: boolean) => Promise<WrittenSettings>;
  /** 启用确认还算不算数，不算时给出这次要显示的说明。 */
  readonly activation: () => Promise<NoticeStatus<ActivationKind>>;
  /** 用户点了「启用简幕」：记下当前说明的版本和指纹。 */
  readonly confirmActivation: () => Promise<WrittenSettings>;
  /**
   * 清除全部数据时先写入清除表里标 renew 的新值，再清两个存储区，都排在同一把锁里：
   * 保存要么整段在清除之前、随后被清掉，要么整段在之后，并且核对不过清除之前打开的表单。
   */
  readonly clearAll: () => Promise<void>;
}

/** 本机记录的结构版本，对不上就当作没填。 */
const LOCAL_KEY_VERSION = 1;

/** 一次读到的存储内容。 */
interface Snapshot {
  readonly stored: unknown;
  readonly localRecord: unknown;
  readonly sessionRecord: unknown;
  readonly revision: string;
}

const fieldsOf = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null ? { ...value } : {};

function settingsError(code: SettingsErrorCode, message: string, cause?: unknown): SettingsError {
  return Object.assign(new Error(message, { cause }), { code });
}

const remembers = ({ stored }: Snapshot): boolean => fieldsOf(stored)["rememberApiKey"] === true;

// 用哪一份只看记住开关，不按「哪边有值用哪边」挑：开关切到一半失败时两边都可能留着东西。
function secretOf(snapshot: Snapshot): unknown {
  if (!remembers(snapshot)) return snapshot.sessionRecord;
  return fieldsOf(snapshot.localRecord)["version"] === LOCAL_KEY_VERSION ? snapshot.localRecord : null;
}

// 没选记住、本机却留着一份：上次关开关中途失败留下的，读的时候要删掉。
const hasLeftover = (snapshot: Snapshot): boolean => !remembers(snapshot) && snapshot.localRecord !== undefined;

// 密钥只认会话或本机记录里的那份：设置里就算多出密钥字段也被这里盖掉，下次写入时消失。
// 记录没有来源就按没填：规整时「没记来源归到当前地址」只给表单刚填的密钥用，存着的密钥不能这样跟到别家。
function compose(snapshot: Snapshot): NormalizedSettings {
  const { key, origin } = fieldsOf(secretOf(snapshot));
  const bound = typeof origin === "string" && origin !== "";
  return normalize({ ...fieldsOf(snapshot.stored), aiApiKey: bound ? key : "", aiApiKeyOrigin: bound ? origin : "" });
}

function withoutApiKey({ aiApiKey: _key, aiApiKeyOrigin: _origin, ...rest }: NormalizedSettings) {
  return rest;
}

// 启用确认只由 confirmActivation 写：表单里带的旧值写不回来，没带也不会把确认抹掉。
function activationOf({ activationVersion, activationFingerprint }: NormalizedSettings) {
  return { activationVersion, activationFingerprint };
}

function credentialChanged(next: NormalizedSettings, before: NormalizedSettings): boolean {
  return (
    next.aiApiKey !== before.aiApiKey ||
    next.aiApiKeyOrigin !== before.aiApiKeyOrigin ||
    next.rememberApiKey !== before.rememberApiKey
  );
}

function consentChanged(next: NormalizedSettings, before: NormalizedSettings): boolean {
  return (
    next.dataConsentVersion !== before.dataConsentVersion ||
    next.dataConsentFingerprint !== before.dataConsentFingerprint
  );
}

// 表单没写来源时，规整把密钥归到当前地址，这只给刚填的密钥用：还是已存的那把，就按它绑定的来源核对。
function settingsFromForm(form: SettingsInput, before: NormalizedSettings): NormalizedSettings {
  const settings = normalize(form);
  const stated = typeof form.aiApiKeyOrigin === "string" && form.aiApiKeyOrigin !== "";
  if (stated || settings.aiApiKey !== before.aiApiKey) return settings;
  return normalize({ ...form, aiApiKeyOrigin: before.aiApiKeyOrigin });
}

// 类型挡不住跨消息传来的值，这里按名单再挑一遍。
function allowedFields(patch: SettingsPatch): SettingsInput {
  const present = INSTANT_FIELDS.filter((field) => Object.hasOwn(patch, field));
  return {
    ...Object.fromEntries(present.map((field) => [field, patch[field]])),
    ...(patch.aiApiKey === "" ? { aiApiKey: "" } : {}),
    ...(patch.rememberApiKey === false ? { rememberApiKey: false } : {}),
  };
}

export function createSettingsStore({ storage, locks }: SettingsStoreDeps): SettingsStore {
  const exclusive = <T>(work: () => T) => locks.exclusive(SETTINGS_LOCK_NAME, work);
  const shared = <T>(work: () => T) => locks.shared(SETTINGS_LOCK_NAME, work);

  // 下面三个只能在锁里调用，锁里不能再走 load、save。
  async function read(): Promise<Snapshot> {
    const [local, session] = await Promise.all([
      storage.local.get([SETTINGS_STORAGE_KEY, API_KEY_LOCAL_KEY, SETTINGS_REVISION_KEY]),
      storage.session.get(API_KEY_SESSION_KEY),
    ]);
    const revision = local[SETTINGS_REVISION_KEY];
    return {
      stored: local[SETTINGS_STORAGE_KEY],
      localRecord: local[API_KEY_LOCAL_KEY],
      sessionRecord: session[API_KEY_SESSION_KEY],
      revision: typeof revision === "string" ? revision : "",
    };
  }

  async function writeRemembered(settings: NormalizedSettings, rewrite: boolean, entries: Record<string, unknown>) {
    const { aiApiKey: key, aiApiKeyOrigin: origin } = settings;
    if (rewrite) {
      // 地址不合法时规整不核对来源，所以这里再比一次：写进磁盘的只能是绑定当前地址的那把。
      if (!origin || origin !== originOf(settings.aiBaseUrl)) {
        throw settingsError("REMEMBER_KEY_UNBOUND", "密钥缺少所属的 API 地址，没有记到这台电脑上。");
      }
      try {
        await restrictToTrustedContexts(storage.local);
      } catch (cause) {
        throw settingsError("REMEMBER_KEY_UNPROTECTED", "没能限制本机存储的访问范围，密钥没有记到这台电脑上。", cause);
      }
    }
    // 一次写完：记录、开关和修订号要么都写进去，要么都没写（比如存储写满）。
    await storage.local.set({
      ...(rewrite ? { [API_KEY_LOCAL_KEY]: { version: LOCAL_KEY_VERSION, key, origin } } : {}),
      ...entries,
    });
    try {
      await storage.session.remove(API_KEY_SESSION_KEY);
    } catch {
      // 记住时只认本机记录，会话里那份删不掉也照常算保存成功。
    }
  }

  // 先写会话，监听本机存储的页面收到变化时就能读到新密钥。
  async function writeSessionOnly(settings: NormalizedSettings, current: Snapshot, entries: Record<string, unknown>) {
    const { aiApiKey: key, aiApiKeyOrigin: origin } = settings;
    // 要删密钥时先换修订号：删到一半失败或后台被杀，之前打开的表单也核对不过，写不回来。
    const removing = current.localRecord !== undefined || (!key && current.sessionRecord !== undefined);
    const renewed = entries[SETTINGS_REVISION_KEY];
    if (removing && renewed !== undefined) await storage.local.set({ [SETTINGS_REVISION_KEY]: renewed });
    if (key) await storage.session.set({ [API_KEY_SESSION_KEY]: { key, origin } });
    else await storage.session.remove(API_KEY_SESSION_KEY);
    try {
      // 确认本机记录删掉了才把开关写成关：删不掉就整次报错，不会显示已关闭、记录却还在。
      // 删掉之后写设置失败时不把记录写回去。
      if (current.localRecord !== undefined) await storage.local.remove(API_KEY_LOCAL_KEY);
      await storage.local.set(entries);
    } catch (error) {
      // 本机存储写不进去（比如写满了）时把会话里的密钥换回原样：不然留下新密钥配旧服务商，
      // 密钥按来源对不上被丢掉，原来能用的那把也没了。
      try {
        if (current.sessionRecord) await storage.session.set({ [API_KEY_SESSION_KEY]: current.sessionRecord });
        else await storage.session.remove(API_KEY_SESSION_KEY);
      } catch {
        // 换不回去也照常报原来的错。
      }
      throw error;
    }
  }

  async function write(next: NormalizedSettings, current: Snapshot): Promise<WrittenSettings> {
    // 没有密钥就没有可记的：清空密钥时开关跟着关，下一把密钥不会悄悄记到磁盘上。
    const settings = next.aiApiKey ? next : { ...next, rememberApiKey: false };
    const before = compose(current);
    const changed = credentialChanged(settings, before);
    const revision = changed || consentChanged(settings, before) ? crypto.randomUUID() : current.revision;
    const entries = {
      [SETTINGS_STORAGE_KEY]: withoutApiKey(settings),
      ...(revision === current.revision ? {} : { [SETTINGS_REVISION_KEY]: revision }),
    };
    if (settings.rememberApiKey) {
      // 密钥、来源和开关都没变时（改外观、改模型这类写入）不重写密钥，也不重新申请访问限制。
      await writeRemembered(settings, changed, entries);
    } else {
      await writeSessionOnly(settings, current, entries);
    }
    return { ...settings, settingsRevision: revision, previousRevision: current.revision };
  }

  return {
    load: async () => {
      let snapshot = await shared(read);
      if (hasLeftover(snapshot)) {
        // 要写存储才能读对：换成独占锁重读一遍，读到之后别处保存过也不会删错。
        snapshot = await exclusive(async () => {
          const fresh = await read();
          if (hasLeftover(fresh)) await storage.local.remove(API_KEY_LOCAL_KEY);
          return fresh;
        });
      }
      return { ...compose(snapshot), settingsRevision: snapshot.revision };
    },
    save: (form, expectedRevision) =>
      exclusive(async () => {
        const current = await read();
        if (expectedRevision !== current.revision) {
          throw settingsError("SETTINGS_STALE", "设置刚在别的页面改过，这里的表单已经过时。");
        }
        const before = compose(current);
        return write({ ...settingsFromForm(form, before), ...activationOf(before) }, current);
      }),
    update: (patch) =>
      exclusive(async () => {
        const current = await read();
        return write(normalize({ ...compose(current), ...allowedFields(patch) }), current);
      }),
    setDataConsent: (given) =>
      exclusive(async () => {
        const current = await read();
        const { dataConsentVersion, dataConsentFingerprint } = given === true ? DATA_CONSENT_CONFIRMED : DEFAULTS;
        return write({ ...compose(current), dataConsentVersion, dataConsentFingerprint }, current);
      }),
    activation: () => shared(async () => activationStatus(await readItem(storage.local, SETTINGS_STORAGE_KEY))),
    confirmActivation: () =>
      exclusive(async () => {
        const current = await read();
        return write({ ...compose(current), ...ACTIVATION_CONFIRMED }, current);
      }),
    clearAll: () =>
      exclusive(async () => {
        const { local, session, renew } = clearTargets("all");
        const renewed = Object.fromEntries(renew.map((key) => [key, crypto.randomUUID()]));
        // 先换修订号：后面哪一步失败或后台被杀，清除之前打开的表单都核对不过。
        // 存储写满时可能写不进去，这不能挡住清除：连旧修订号一起删掉，删完再写。
        const written = await storage.local.set(renewed).then(
          () => true,
          () => false,
        );
        await storage.local.remove(written ? local.filter((key) => !renew.includes(key)) : [...local]);
        await storage.session.remove([...session]);
        if (!written) await storage.local.set(renewed);
      }),
  };
}
