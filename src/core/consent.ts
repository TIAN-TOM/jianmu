// 两份说明的版本表和指纹。数据同意管发给模型服务的内容，首次启用说明管在本机读取和保存的内容，分开记、分开判断。
// 表里每个版本只写相对上一版新增或扩大了什么。指纹只算条目的 kind 和 id，改 text 的措辞不用重新同意；
// 条目变了就要升版，tests/fixtures/consent-fingerprints.json 的快照拦下忘了升版的改动。

/** 构建时开关。带开关的版本只在开关打开的构建里进说明和指纹，关着的构建停在不含它的版本上。 */
export type NoticeFeature = "frameExplain";
export type NoticeFeatures = Readonly<Record<NoticeFeature, boolean>>;

/** 数据类别、使用目的、接收方、发送的触发方式或范围。 */
export type DataConsentKind = "category" | "purpose" | "recipient" | "trigger";
/** 会读取什么、用来做什么、本机存什么。 */
export type ActivationKind = "read" | "purpose" | "store";

export interface NoticeItem<Kind extends string> {
  readonly kind: Kind;
  /** 这一条的实质内容。范围变了就换新 id，写进新版本。 */
  readonly id: string;
  /** 给用户看的措辞，不进指纹。 */
  readonly text: string;
}

export interface NoticeVersion<Kind extends string> {
  readonly version: number;
  readonly requires?: NoticeFeature;
  readonly items: readonly NoticeItem<Kind>[];
}

export type NoticeTable<Kind extends string> = readonly NoticeVersion<Kind>[];

/** 某一版说明的版本号和到这一版为止全部条目的指纹。 */
export interface NoticeStamp {
  readonly version: number;
  readonly fingerprint: string;
}

/** 用户确认时存下的内容，来自存储，形状不可信。 */
export interface StoredStamp {
  readonly version?: unknown;
  readonly fingerprint?: unknown;
}

export type NoticeStatus<Kind extends string> =
  | { readonly state: "current" }
  | {
      readonly state: "needed";
      /** true：确认过别的版本，提示说明有更新；false：从没确认过。 */
      readonly updated: boolean;
      /** 这次要给用户看的条目：认得出确认过哪一版就只列之后新增的，否则是完整说明。 */
      readonly items: readonly NoticeItem<Kind>[];
    };

/** 设置里记着的数据同意。 */
export interface StoredDataConsent {
  readonly dataConsentVersion?: unknown;
  readonly dataConsentFingerprint?: unknown;
}

/** 当前数据说明的版本和指纹。 */
export interface DataConsentRules {
  readonly dataConsentVersion: number;
  readonly dataConsentFingerprint: string;
}

export const DATA_CONSENT_TABLE: NoticeTable<DataConsentKind> = [
  {
    version: 1,
    items: [
      { kind: "category", id: "transcript", text: "字幕文本" },
      { kind: "category", id: "selection", text: "你选中的文字" },
      { kind: "category", id: "question", text: "你的问题" },
      { kind: "category", id: "video-title", text: "视频标题" },
      { kind: "category", id: "uploader-and-description", text: "UP 主名和简介" },
      { kind: "category", id: "official-summary", text: "「用官方总结写结论」和粗筛用到的 B 站官方总结" },
      { kind: "category", id: "api-key", text: "你的 API 密钥" },
      { kind: "purpose", id: "ai-features", text: "翻译、概览、一句话结论、划词解释、笔记润色、问答和粗筛写结论" },
      {
        kind: "recipient",
        id: "chosen-provider",
        text: "发到你选的服务商地址。开发者没有服务器，收不到这些内容；服务商怎么处理，以它的隐私政策为准",
      },
      { kind: "trigger", id: "on-click", text: "这些请求只在你点按钮时发出" },
    ],
  },
  {
    version: 2,
    items: [{ kind: "category", id: "imported-transcript", text: "你导入的字幕文件里的文字" }],
  },
];

export const ACTIVATION_TABLE: NoticeTable<ActivationKind> = [
  {
    version: 1,
    items: [
      { kind: "read", id: "video-info", text: "视频信息：标题、作者和频道、时长、简介" },
      { kind: "read", id: "transcript", text: "字幕。YouTube 上只在你点读取时，读观看页文字稿面板里显示的内容" },
      { kind: "read", id: "official-summary", text: "B 站官方总结和 UP 主分段" },
      { kind: "read", id: "watch-state", text: "观看状态：播放、暂停、累计播放时长" },
      { kind: "read", id: "window-tabs", text: "本窗口全部生成时，已授权网站标签页的地址和标题" },
      { kind: "read", id: "watch-later", text: "打开粗筛并点读取时，B 站稍后再看列表" },
      { kind: "purpose", id: "display", text: "在侧边栏和卡片里显示" },
      { kind: "purpose", id: "pick-mode", text: "按时长、频道和播放情况选模式" },
      { kind: "purpose", id: "material", text: "作为之后生成和问答的材料" },
      { kind: "store", id: "cache", text: "字幕和视频信息的缓存，有期限和条数上限，可以在设置页清除" },
      { kind: "store", id: "triage", text: "粗筛读到的列表和官方总结，有期限，可以在设置页清除" },
      { kind: "store", id: "saved", text: "你保存的概览、问答、笔记和译文长期留在本机，保存到你删除为止" },
    ],
  },
];

// 当前构建打开了哪些开关。
const BUILD_FEATURES: NoticeFeatures = { frameExplain: false };

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const HASH_MASK = 0xffffffffffffffffn;

// FNV-1a 64 位。指纹防的是忘了升版，不防伪造；要在模块加载时同步算出来，crypto.subtle 用不了。
function hash(text: string): string {
  let value = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    value = ((value ^ BigInt(byte)) * FNV_PRIME) & HASH_MASK;
  }
  return value.toString(16).padStart(16, "0");
}

// 条目先排序：只调顺序不算实质变化。
function fingerprintOf(items: readonly NoticeItem<string>[]): string {
  return hash(items.map((item) => `${item.kind}:${item.id}`).sort().join("\n"));
}

function activeVersions<Kind extends string>(table: NoticeTable<Kind>, features: NoticeFeatures): NoticeTable<Kind> {
  return table.filter((row) => row.requires === undefined || features[row.requires]);
}

/** 这组开关下每一版的版本号和指纹，按版本从小到大。 */
export function versionStamps<Kind extends string>(
  table: NoticeTable<Kind>,
  features: NoticeFeatures = BUILD_FEATURES,
): NoticeStamp[] {
  const seen: NoticeItem<Kind>[] = [];
  return activeVersions(table, features).map((row) => {
    seen.push(...row.items);
    return { version: row.version, fingerprint: fingerprintOf(seen) };
  });
}

/** 这组开关下的最新一版。 */
export function currentStamp<Kind extends string>(
  table: NoticeTable<Kind>,
  features: NoticeFeatures = BUILD_FEATURES,
): NoticeStamp {
  const current = versionStamps(table, features).at(-1);
  if (!current) throw new Error("说明表里没有可用的版本");
  return current;
}

// 版本和指纹都要对上。stamp 不完整时一律不算，免得两边都是空值时恒成立。
function stampMatches(stored: StoredStamp, stamp: NoticeStamp): boolean {
  return (
    Number.isInteger(stamp.version) &&
    stamp.version > 0 &&
    Boolean(stamp.fingerprint) &&
    stored.version === stamp.version &&
    stored.fingerprint === stamp.fingerprint
  );
}

/** 存着的确认还算不算数，不算时这次要给用户看什么。 */
export function noticeStatus<Kind extends string>(
  table: NoticeTable<Kind>,
  stored: StoredStamp,
  features: NoticeFeatures = BUILD_FEATURES,
): NoticeStatus<Kind> {
  const stamps = versionStamps(table, features);
  const agreedAt = stamps.findIndex((stamp) => stampMatches(stored, stamp));
  if (agreedAt >= 0 && agreedAt === stamps.length - 1) return { state: "current" };
  const everAgreed = Number.isInteger(stored.version) && Number(stored.version) > 0;
  return {
    state: "needed",
    updated: everAgreed,
    items: activeVersions(table, features).slice(agreedAt + 1).flatMap((row) => row.items),
  };
}

/** 发给模型服务之前的核对：版本和指纹都和当前一致才放行。 */
export function dataConsentGiven(stored: StoredDataConsent, rules: DataConsentRules): boolean {
  return stampMatches(
    { version: stored.dataConsentVersion, fingerprint: stored.dataConsentFingerprint },
    { version: rules.dataConsentVersion, fingerprint: rules.dataConsentFingerprint },
  );
}

const dataConsent = currentStamp(DATA_CONSENT_TABLE);
const activation = currentStamp(ACTIVATION_TABLE);

export const DATA_CONSENT_VERSION = dataConsent.version;
export const DATA_CONSENT_FINGERPRINT = dataConsent.fingerprint;
export const DATA_CONSENT_ERROR = "请先在设置页「AI 服务」一节读一下数据说明，勾选「我已了解」。";
export const ACTIVATION_VERSION = activation.version;
export const ACTIVATION_FINGERPRINT = activation.fingerprint;
