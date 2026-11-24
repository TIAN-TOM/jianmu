// 两份说明的版本表和指纹。数据同意管发给模型服务的内容，首次启用说明管在本机读取和保存的内容，分开记、分开判断。
// 表里每个版本只写相对上一版新增或扩大了什么。指纹只算条目的 kind 和 id，改 text 的措辞、并显示的写法都不用重新同意；
// 表从第 1 版起，扩大范围就升版、加一行，存着的版本和指纹表里认不出就按第一次处理；tests/fixtures/consent-fingerprints.json 的快照拦下没留意的变化。
// 跟着构建开关走的条目放在单独的模块里，只从开关分支引用：开关关着的构建连措辞都不进包。
// 每个条目的措辞中文（text）、英文（en）并排写，并显示的合成措辞也一样（combined、combinedEn）；英文不进指纹，加英文不用升版。
// 繁体措辞按条目的 kind:id 另建表，放在 consent-hant.ts（画面那几条在 consent-frame-hant.ts），同样不进指纹。
import { FRAME_ACTIVATION_ITEMS, FRAME_DATA_ITEMS } from "./consent-frame.ts";
import { FRAME_ACTIVATION_HANT, FRAME_DATA_HANT } from "./consent-frame-hant.ts";
import { ACTIVATION_HANT, DATA_CONSENT_ERROR_HANT, DATA_CONSENT_HANT } from "./consent-hant.ts";
import { inLang, type OutputLang } from "./output-lang.ts";

/** 数据类别、使用目的、接收方、发送的触发方式或范围。 */
export type DataConsentKind = "category" | "purpose" | "recipient" | "trigger";
/** 会读取什么、用来做什么、本机存什么。 */
export type ActivationKind = "read" | "purpose" | "store";

export interface NoticeItem<Kind extends string> {
  readonly kind: Kind;
  /** 这一条的实质内容。范围变了就换新 id，写进新版本。 */
  readonly id: string;
  /** 给用户看的措辞，中文，不进指纹。 */
  readonly text: string;
  /** 同一条的英文措辞，和 text 逐项对应、不多说也不少说，不进指纹。 */
  readonly en: string;
  /**
   * 只管显示，不进指纹：完整说明里这一条不单列，并进同一 kind、id 为 shownWith.id 的那一条，那一条改显示 combined（英文是 combinedEn）。
   * 那一条不在要显示的这组里（老用户只看新增的）时照常单列。
   */
  readonly shownWith?: { readonly id: string; readonly combined: string; readonly combinedEn: string };
}

/** 一个条目的繁体措辞：text 对应简体的 text，combined 对应 shownWith.combined。 */
export interface NoticeHant {
  readonly text: string;
  readonly combined?: string;
}

/** 繁体措辞表，键是条目的 kind:id。 */
export type NoticeHantTable = Readonly<Record<string, NoticeHant>>;

type HantKey<Item> = Item extends { readonly kind: infer K extends string; readonly id: infer D extends string } ? `${K}:${D}` : never;

/** 一组条目要的繁体措辞表：每个条目的 kind:id 都得有，不多不少；并显示的条目还要合成措辞。 */
export type HantFor<Items extends readonly NoticeItem<string>[]> = {
  readonly [Item in Items[number] as HantKey<Item>]: Item extends { readonly shownWith: object }
    ? { readonly text: string; readonly combined: string }
    : { readonly text: string; readonly combined?: never };
};

/** 给用户看的一行：通常是一个条目，并显示的是几个条目合成一行。 */
export interface NoticeLine<Kind extends string> {
  readonly kind: Kind;
  readonly ids: readonly string[];
  readonly text: string;
}

export interface NoticeVersion<Kind extends string> {
  readonly version: number;
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
  | {
      readonly state: "current";
      /** 只在开发者本人的日用包里有：确认过、同意过的旧版本照旧沿用，这是两份说明之后多出来、还没看过的条目。 */
      readonly carried?: CarriedItems;
    }
  | {
      readonly state: "needed";
      /** true：确认过表里更早的某一版，提示说明有更新；false：从没确认过，或者存着的版本和指纹表里认不出，按第一次处理。 */
      readonly updated: boolean;
      /** 这次要给用户看的条目：认得出确认过哪一版就只列之后新增的，否则是完整说明。 */
      readonly items: readonly NoticeItem<Kind>[];
    };

/** 沿用时多出来的条目：启用说明的（在本机读的）和数据说明的（发给模型的）分开放。 */
export interface CarriedItems {
  readonly activation: readonly NoticeItem<string>[];
  readonly consent: readonly NoticeItem<string>[];
}

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

const DATA_CONSENT_V1 = [
  { kind: "category", id: "transcript", text: "字幕文本", en: "Subtitle text" },
  { kind: "category", id: "selection", text: "你选中的文字", en: "Text you select" },
  { kind: "category", id: "question", text: "你的问题", en: "Your questions" },
  { kind: "category", id: "video-title", text: "视频标题", en: "Video title" },
  { kind: "category", id: "uploader-and-description", text: "UP 主名或频道名，和简介", en: "Creator or channel name, and the video description" },
  { kind: "category", id: "official-summary", text: "「用官方总结写结论」和粗筛用到的 B 站官方总结", en: "Bilibili official summaries used by “Write a verdict from the official summary” and Watch Later triage" },
  { kind: "category", id: "api-key", text: "你的 API 密钥", en: "Your API key" },
  {
    kind: "purpose",
    id: "ai-features",
    text: "翻译、概览、一句话结论、划词解释、笔记润色、问答和粗筛写结论",
    en: "Translation, overviews, one-line verdicts, selection explanation, note polishing, Q&A, and verdicts in Watch Later triage",
  },
  {
    kind: "recipient",
    id: "chosen-provider",
    text: "发到你选的服务商地址，也可以是你自己电脑上的服务。开发者没有服务器，收不到这些内容；服务商怎么处理，以它的隐私政策为准",
    en: "The provider address you choose, which can also be a service on your own computer. The developer has no server and never receives any of this. How the provider handles it is governed by its privacy policy",
  },
  { kind: "trigger", id: "on-click", text: "这些请求只在你点按钮时发出", en: "These requests are only sent when you click a button" },
  { kind: "category", id: "imported-transcript", text: "你导入的字幕文件里的文字", en: "Text from subtitle files you import" },
  {
    kind: "category",
    id: "video-duration",
    text: "视频时长",
    en: "Video length",
    shownWith: { id: "video-title", combined: "视频标题和时长", combinedEn: "Video title and length" },
  },
  {
    kind: "trigger",
    id: "auto-on-open-tabs",
    text: "打开「打开就出结论」以后，在 B 站和已启用的 YouTube 上打开超过设定时长的视频，包括在后台打开、还没切过去看的标签页和打开开关时已经开着的，会自动发送字幕、视频标题和时长、UP 主名或频道名和简介，生成概览和一句话结论",
    en: "With “Verdict on open” turned on, opening a video longer than the set length on Bilibili, or on YouTube once it's turned on, automatically sends its subtitles, title and length, creator or channel name, and description to generate an overview and a one-line verdict. This includes tabs opened in the background that you haven't switched to yet, and tabs already open when you turn it on",
    shownWith: {
      id: "on-click",
      combined:
        "平时只在你点按钮时发出；打开「打开就出结论」以后，在 B 站和已启用的 YouTube 上打开超过设定时长的视频，包括在后台打开、还没切过去看的标签页和打开开关时已经开着的，会自动发送字幕、视频标题和时长、UP 主名或频道名和简介，生成概览和一句话结论",
      combinedEn:
        "Normally only when you click a button. With “Verdict on open” turned on, opening a video longer than the set length on Bilibili, or on YouTube once it's turned on, automatically sends its subtitles, title and length, creator or channel name, and description to generate an overview and a one-line verdict. This includes tabs opened in the background that you haven't switched to yet, and tabs already open when you turn it on",
    },
  },
  {
    kind: "purpose",
    id: "tidy-transcript",
    text: "整理字幕：点「整理字幕」时发送字幕和视频标题，给字幕补标点、改明显的同音错字",
    en: "Subtitle tidy-up: clicking “Tidy up subtitles” sends the subtitles and video title to add punctuation and fix obviously misheard words",
    shownWith: {
      id: "ai-features",
      combined: "翻译、整理字幕（补标点、改同音错字）、概览、一句话结论、划词解释、笔记润色、问答和粗筛写结论",
      combinedEn: "Translation, subtitle tidy-up (adding punctuation and fixing misheard words), overviews, one-line verdicts, selection explanation, note polishing, Q&A, and verdicts in Watch Later triage",
    },
  },
  {
    kind: "trigger",
    id: "keep-running",
    text: "翻译和整理字幕点了以后在后台把整个视频分批发完，关掉侧边栏也继续，会接着用 API 额度；做完、你点停止，或者视频所在的标签页换了视频或关掉时才停",
    en: "Once started, translation and subtitle tidy-up send the whole video in batches in the background and keep going after you close the side panel, using more API credit as they go. They only stop when they finish, when you click Stop, or when the video's tab switches to another video or is closed",
  },
] as const satisfies readonly NoticeItem<DataConsentKind>[];

export const DATA_CONSENT_TABLE: NoticeTable<DataConsentKind> = [{ version: 1, items: [...DATA_CONSENT_V1, ...(FEATURE_FRAME_EXPLAIN ? FRAME_DATA_ITEMS : [])] }];

const ACTIVATION_V1 = [
  { kind: "read", id: "video-info", text: "视频信息：标题、作者和频道、时长、简介", en: "Video details: title, creator and channel, length, and description" },
  {
    kind: "read",
    id: "transcript",
    text: "字幕。YouTube 上读观看页文字稿面板里显示的内容，面板没开时替你点开，打开就出结论、本窗口全部生成和卡片上的「生成概览」点开的读完替你关上；页面上没有文字稿时，改读播放器自己取回的那条字幕，字幕关着时替你打开、读完关上；另读播放器上已有的字幕轨列表，标出语言和是不是自动生成",
    en: "Subtitles. On YouTube, Jianmu reads what's shown in the transcript panel on the watch page and opens the panel for you if it's closed. If Verdict on open, Generate all in this window or “Generate overview” on the card opened it, Jianmu closes it again after reading. If the page has no transcript, Jianmu reads the subtitles the player loads itself, turning subtitles on for you if they're off and back off after reading. It also reads the list of subtitle tracks the player already has, noting each track's language and whether it's auto-generated",
  },
  { kind: "read", id: "official-summary", text: "B 站官方总结和 UP 主分段", en: "Bilibili official summaries and the creator's own chapters" },
  { kind: "read", id: "watch-state", text: "观看状态：播放、暂停、累计播放时长", en: "Viewing status: playing, paused, and total time played" },
  { kind: "read", id: "window-tabs", text: "本窗口全部生成时，已授权网站标签页的地址和标题", en: "When you use Generate all in this window, the addresses and titles of tabs on sites you've authorised" },
  { kind: "read", id: "watch-later", text: "打开粗筛并点读取时，B 站稍后再看列表", en: "Your Bilibili Watch Later list, when you open triage and click to load it" },
  { kind: "purpose", id: "display", text: "在侧边栏和卡片里显示", en: "Showing it in the side panel and on the card" },
  { kind: "purpose", id: "pick-mode", text: "按时长、频道和播放情况选模式", en: "Choosing a mode based on length, channel and playback" },
  { kind: "purpose", id: "material", text: "作为之后生成和问答的材料", en: "Material for later generation and Q&A" },
  { kind: "store", id: "cache", text: "字幕和视频信息的缓存，有期限和条数上限，可以在设置页清除", en: "A cache of subtitles and video details, with a time limit and a cap on the number of entries. You can clear it in settings" },
  { kind: "store", id: "triage", text: "粗筛读到的列表和官方总结，有期限，可以在设置页清除", en: "The list and official summaries loaded by triage, with a time limit. You can clear them in settings" },
  { kind: "store", id: "saved", text: "你保存的概览、问答、笔记和译文长期留在本机，保存到你删除为止", en: "Overviews, Q&A, notes and translations you save stay on this computer until you delete them" },
  { kind: "read", id: "bili-login-state", text: "B 站登录状态：只看是否已登录，不读 Cookie 内容", en: "Your Bilibili sign-in status: only whether you're signed in. Cookie contents aren't read" },
  { kind: "read", id: "watch-later-progress", text: "粗筛读到的稍后再看列表里，每个视频看到哪里", en: "How far you've watched each video in the Watch Later list loaded by triage" },
  {
    kind: "read",
    id: "open-tabs",
    text: "打开「打开就出结论」以后，已授权网站各标签页的地址，用来认出打开的 B 站视频和已启用的 YouTube 上的视频，包括在后台打开的",
    en: "With “Verdict on open” turned on, the address of each tab on sites you've authorised, used to recognise videos you open on Bilibili, or on YouTube once it's turned on, including ones opened in the background",
  },
] as const satisfies readonly NoticeItem<ActivationKind>[];

export const ACTIVATION_TABLE: NoticeTable<ActivationKind> = [{ version: 1, items: [...ACTIVATION_V1, ...(FEATURE_FRAME_EXPLAIN ? FRAME_ACTIVATION_ITEMS : [])] }];

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

/** 每一版的版本号和指纹，按版本从小到大。 */
export function versionStamps<Kind extends string>(table: NoticeTable<Kind>): NoticeStamp[] {
  const seen: NoticeItem<Kind>[] = [];
  return table.map((row) => {
    seen.push(...row.items);
    return { version: row.version, fingerprint: fingerprintOf(seen) };
  });
}

/** 最新一版。 */
export function currentStamp<Kind extends string>(table: NoticeTable<Kind>): NoticeStamp {
  const current = versionStamps(table).at(-1);
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

/** 以前确认过、同意过某一版：存着的版本号是正整数。 */
export function everAgreed(stored: StoredStamp): boolean {
  return Number.isInteger(stored.version) && Number(stored.version) > 0;
}

/** 存着的确认还算不算数，不算时这次要给用户看什么。 */
export function noticeStatus<Kind extends string>(table: NoticeTable<Kind>, stored: StoredStamp): NoticeStatus<Kind> {
  const stamps = versionStamps(table);
  const agreedAt = stamps.findIndex((stamp) => stampMatches(stored, stamp));
  if (agreedAt >= 0 && agreedAt === stamps.length - 1) return { state: "current" };
  return {
    state: "needed",
    updated: agreedAt >= 0,
    items: table.slice(agreedAt + 1).flatMap((row) => row.items),
  };
}

/** 两份说明各自要的繁体措辞表。 */
export type DataConsentHant = HantFor<typeof DATA_CONSENT_V1>;
export type ActivationHant = HantFor<typeof ACTIVATION_V1>;

// 两份说明的繁体措辞合成一张：两份的 kind:id 不重（测试会查）；画面那几条只在开关分支里。
const NOTICE_HANT: NoticeHantTable = {
  ...DATA_CONSENT_HANT,
  ...ACTIVATION_HANT,
  ...(FEATURE_FRAME_EXPLAIN ? FRAME_DATA_HANT : {}),
  ...(FEATURE_FRAME_EXPLAIN ? FRAME_ACTIVATION_HANT : {}),
};

/** 一个条目的繁体措辞。各张措辞表的类型保证每个条目都有，查不到说明传进来的不是表里的条目。 */
export function noticeHant(item: Pick<NoticeItem<string>, "kind" | "id">): NoticeHant {
  const key = `${item.kind}:${item.id}`;
  const hant = Object.hasOwn(NOTICE_HANT, key) ? NOTICE_HANT[key] : undefined;
  if (!hant) throw new Error(`说明里没有这个条目：${key}`);
  return hant;
}

/** 一个条目给用户看的措辞。不传语言时是简体。 */
export const noticeText = (item: Pick<NoticeItem<string>, "kind" | "id" | "text" | "en">, lang: OutputLang = "zh"): string =>
  inLang(lang, () => item.text, () => item.en, () => noticeHant(item).text)();

// 并显示的条目的繁体合成措辞，措辞表的类型保证有。
function combinedHant(item: Pick<NoticeItem<string>, "kind" | "id">): string {
  const combined = noticeHant(item).combined;
  if (combined === undefined) throw new Error(`说明里这个条目不并显示：${item.kind}:${item.id}`);
  return combined;
}

/** noticeStatus 给出的一组条目排成给用户看的行：带 shownWith 的并进它指向的那一行，指向的不在这组里就单列。不传语言时是中文。 */
export function noticeLines<Kind extends string>(items: readonly NoticeItem<Kind>[], lang: OutputLang = "zh"): NoticeLine<Kind>[] {
  const keyOf = (kind: string, id: string): string => `${kind}:${id}`;
  const present = new Set(items.map((item) => keyOf(item.kind, item.id)));
  const merges = (item: NoticeItem<Kind>): boolean => item.shownWith !== undefined && present.has(keyOf(item.kind, item.shownWith.id));
  const lines = new Map<string, { kind: Kind; ids: string[]; text: string }>();
  for (const item of items) if (!merges(item)) lines.set(keyOf(item.kind, item.id), { kind: item.kind, ids: [item.id], text: noticeText(item, lang) });
  for (const item of items) {
    const line = item.shownWith && merges(item) ? lines.get(keyOf(item.kind, item.shownWith.id)) : undefined;
    if (!line || !item.shownWith) continue;
    line.ids.push(item.id);
    const shownWith = item.shownWith;
    line.text = inLang(lang, () => shownWith.combined, () => shownWith.combinedEn, () => combinedHant(item))();
  }
  return [...lines.values()];
}

/** 发给模型服务之前的核对：版本和指纹都和当前一致才放行。 */
export function dataConsentGiven(stored: StoredDataConsent, rules: DataConsentRules): boolean {
  const given = { version: stored.dataConsentVersion, fingerprint: stored.dataConsentFingerprint };
  // 开发者本人的日用包：同意过别的版本也沿用（consent-carry.ts）。
  return stampMatches(given, { version: rules.dataConsentVersion, fingerprint: rules.dataConsentFingerprint }) || (FEATURE_KEEP_CONSENT ? everAgreed(given) : false);
}

/**
 * 存着的同意是不是当前这一版，而且当前这一版里有这一条：只看「同意了」不够，比如自动发送要等说明里写了它、用户同意了那一版才算。
 */
export function consentCovers<Kind extends string>(
  table: NoticeTable<Kind>,
  stored: StoredStamp,
  item: { readonly kind: Kind; readonly id: string },
): boolean {
  if (!stampMatches(stored, currentStamp(table)) && !(FEATURE_KEEP_CONSENT ? everAgreed(stored) : false)) return false;
  return table.some((row) => row.items.some((entry) => entry.kind === item.kind && entry.id === item.id));
}

const dataConsent = currentStamp(DATA_CONSENT_TABLE);
const activation = currentStamp(ACTIVATION_TABLE);

export const DATA_CONSENT_VERSION = dataConsent.version;
export const DATA_CONSENT_FINGERPRINT = dataConsent.fingerprint;
/** 没同意数据说明时的提示，中文。校验结果里按它认出是同意的问题，所以它同时是标识，措辞不随语言变；给用户看的用 dataConsentErrorText。 */
export const DATA_CONSENT_ERROR = "请先在设置页「AI 服务」一节读一下数据说明，勾选「我已了解」。";
export const DATA_CONSENT_ERROR_EN = "Read the data notice in the “AI service” section of settings and tick the box to agree first.";

/** 没同意数据说明时给用户看的提示。不传语言时是简体，和 DATA_CONSENT_ERROR 一样。 */
export const dataConsentErrorText = (lang: OutputLang = "zh"): string => inLang(lang, DATA_CONSENT_ERROR, DATA_CONSENT_ERROR_EN, DATA_CONSENT_ERROR_HANT);
export const ACTIVATION_VERSION = activation.version;
export const ACTIVATION_FINGERPRINT = activation.fingerprint;
