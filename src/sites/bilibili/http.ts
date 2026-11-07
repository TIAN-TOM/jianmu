// 读 B 站的全部请求都从这里出去：站点限速和退避、登录门、签名密钥、时限和响应分类。
import { retryAfterMsOf } from "../../core/ai/transport/policy.ts";
import type { SiteCtx, SiteErrorCode, SiteResult } from "../types.ts";
import { buildQuery, KEY_ORDER, keysFromNav, signedUrl, type SigningKeys } from "./sign.ts";

export const NAV_URL = "https://api.bilibili.com/x/web-interface/nav";
export const VIEW_URL = "https://api.bilibili.com/x/web-interface/view";
export const SUMMARY_URL = "https://api.bilibili.com/x/web-interface/view/conclusion/get";
export const PLAYER_URL = "https://api.bilibili.com/x/player/wbi/v2";
export const WATCH_LATER_URL = "https://api.bilibili.com/x/v2/history/toview";

export type BiliApiUrl =
  | typeof NAV_URL
  | typeof VIEW_URL
  | typeof SUMMARY_URL
  | typeof PLAYER_URL
  | typeof WATCH_LATER_URL;

export interface GetRequest {
  url: BiliApiUrl;
  params?: Record<string, string | number>;
  signed?: boolean;
  timeoutMs?: number; // 只算这一个请求，排队和取密钥不计入
}

// 一次读取操作用一个 ctx：同一个 ctx 确认过登录，后面的读取方法接着用；新的 ctx 一定重新确认。
export interface BiliHttp {
  requireLogin(ctx: SiteCtx): Promise<SiteResult<void>>;
  getData(request: GetRequest, ctx: SiteCtx): Promise<SiteResult<unknown>>; // 过登录门，返回信封里的数据
  getFile(url: string, ctx: SiteCtx): Promise<SiteResult<unknown>>; // 字幕文件，不带登录状态，调用方先过登录门
  detach(ctx: SiteCtx): SiteCtx; // 同一次操作里共用的请求用它：不接调用方的取消信号，登录结论带过去
  forgetLogin(): void; // 所有操作记下的已登录结论一起作废
}

export interface BiliHttpDeps {
  readonly now?: () => number;
  readonly requestTimeoutMs?: number; // 账号接口、字幕文件和没写时限的接口用这个
}

const REQUEST_TIMEOUT_MS = 12_000;
const KEY_TTL_MS = 60 * 60_000;
// 密钥取到超过这么久才值得换：刚取到的被拒，问题不在密钥上。
const STALE_KEY_AGE_MS = 60_000;

const ACCEPT_JSON = { Accept: "application/json" };
const API_INIT: RequestInit = { credentials: "include", cache: "no-store", headers: ACCEPT_JSON };
const FILE_INIT: RequestInit = { credentials: "omit", cache: "default", headers: ACCEPT_JSON };
const FILE_HOST_SUFFIX = ".hdslb.com";

const ABORTED: SiteResult<never> = { ok: false, code: "NETWORK", detail: "aborted" };
const NEVER_ABORTED = new AbortController().signal;

type Channel = "account" | "api" | "file";
type Outcome = "response" | "blocked" | "unconfirmed" | "timeout" | "threw";
type SiteFailure = Extract<SiteResult<never>, { ok: false }>;

// 一次账号读取的结果和发出时的代次。
interface AccountCheck {
  readonly result: SiteResult<void>;
  readonly generation: number;
}

// 一次请求的结果，分类只看这些。
interface Reading {
  readonly channel: Channel;
  readonly outcome: Outcome;
  readonly ok: boolean;
  readonly status: number;
  readonly json: boolean;
  readonly enveloped: boolean; // 正文带业务码
  readonly apiCode: number; // 读不出来时是 0
  readonly body: unknown;
  readonly retryAfterSec?: number | undefined;
}

interface ErrorRow {
  readonly when: (reading: Reading) => boolean;
  readonly code: SiteErrorCode;
  readonly trip?: true; // 进退避
  readonly forgetLogin?: true;
}

const LIMIT_STATUSES: ReadonlySet<number> = new Set([429, 412]);
const SIGN_REJECTED_CODE = -352;
const LIMIT_CODES: ReadonlySet<number> = new Set([-412, -509, -799, SIGN_REJECTED_CODE]);
const GONE_CODES: ReadonlySet<number> = new Set([-404, 62002, 62004]);

// 平台限流或拦下请求的几种信号，处理都是停下；从上往下第一行对上的算数，都对不上就是成功。
const ERROR_TABLE: readonly ErrorRow[] = [
  { when: (r) => r.outcome === "blocked", code: "RATE_LIMITED" },
  { when: (r) => r.outcome === "unconfirmed", code: "NEED_LOGIN" },
  { when: (r) => r.outcome === "timeout", code: "TIMEOUT" },
  { when: (r) => r.outcome === "threw", code: "NETWORK" },
  { when: (r) => LIMIT_STATUSES.has(r.status) || LIMIT_CODES.has(r.apiCode), code: "RATE_LIMITED", trip: true },
  { when: (r) => r.apiCode === -101, code: "NEED_LOGIN", forgetLogin: true },
  { when: (r) => r.apiCode === -403, code: "UNPLAYABLE" },
  { when: (r) => GONE_CODES.has(r.apiCode), code: "NOT_FOUND" },
  { when: (r) => r.apiCode !== 0, code: "MALFORMED" },
  { when: (r) => !r.ok && r.channel !== "file" && r.status === 403, code: "NETWORK", trip: true },
  { when: (r) => !r.ok, code: "NETWORK" },
  { when: (r) => !r.json && r.channel !== "file", code: "MALFORMED", trip: true },
  { when: (r) => !r.json, code: "MALFORMED" },
  { when: (r) => r.channel === "api" && !r.enveloped, code: "MALFORMED" },
];

function detailOf(reading: Reading): string {
  if (reading.apiCode !== 0) return `code:${reading.apiCode}`;
  if (reading.outcome !== "response") return reading.outcome;
  if (!reading.ok) return `http:${reading.status}`;
  return reading.json ? "no-code" : "unreadable-body";
}

function notSent(channel: Channel, outcome: Outcome, retryAfterSec?: number): Reading {
  return { channel, outcome, ok: false, status: 0, json: false, enveloped: false, apiCode: 0, body: null, retryAfterSec };
}

function retryAfterSecOf(response: Response): number | undefined {
  const retryAfterMs = retryAfterMsOf(response.headers);
  return retryAfterMs === undefined ? undefined : Math.ceil(retryAfterMs / 1000);
}

// 只看响应头就能下结论，不等正文：限流要马上进退避，别的读取才不会在等正文的时候放行。
function limitedReading(response: Response, channel: Channel): Reading {
  return { ...notSent(channel, "response", retryAfterSecOf(response)), status: response.status };
}

async function readResponse(response: Response, channel: Channel): Promise<Reading> {
  let body: unknown = null;
  let json = true;
  try {
    body = await response.json();
  } catch (error) {
    // 只有正文不是 JSON 才算内容问题，读到一半断开按网络失败算。
    if (response.ok && (error as Error | null)?.name !== "SyntaxError") throw error;
    json = false;
  }
  const code = (body as { code?: unknown } | null)?.code;
  const enveloped = typeof code === "number" && Number.isFinite(code);
  return {
    channel,
    outcome: "response",
    ok: response.ok,
    status: response.status,
    json,
    enveloped,
    apiCode: enveloped ? code : 0,
    body,
    retryAfterSec: retryAfterSecOf(response),
  };
}

interface Send {
  readonly channel: Channel;
  readonly init: RequestInit;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly stillConfirmed?: () => boolean; // 排队等放行的时候登录结论可能作废，放行后再看一次
}

// 替身或别的实现不一定理会中止信号，所以到点靠竞速放手，读响应正文也算在时限内。
async function exchange(url: string, spec: Send, ctx: SiteCtx): Promise<Reading> {
  const timer = new AbortController();
  const signal = AbortSignal.any([timer.signal, spec.signal]);
  const ended = (): Reading => notSent(spec.channel, timer.signal.aborted ? "timeout" : "threw");
  let stop = (): void => {};
  const stopped = new Promise<Reading>((resolve) => {
    stop = (): void => resolve(ended());
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
  const deadline = setTimeout(() => timer.abort(), spec.timeoutMs);
  const request = async (): Promise<Reading> => {
    const response = await ctx.fetch(url, { ...spec.init, signal });
    if (!LIMIT_STATUSES.has(response.status)) return readResponse(response, spec.channel);
    response.body?.cancel().catch(() => {});
    return limitedReading(response, spec.channel);
  };
  try {
    return await Promise.race([request(), stopped]);
  } catch {
    return ended();
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener("abort", stop);
  }
}

// 先过限速和退避，放行之后才拼地址：签名里的时间不能算上排队。
async function send(buildUrl: () => string, spec: Send, ctx: SiteCtx): Promise<Reading> {
  try {
    const gate = await ctx.backoff.admit(spec.signal);
    if (!gate.ok) return notSent(spec.channel, "blocked", gate.retryAfterSec);
  } catch {
    return notSent(spec.channel, "threw");
  }
  if (spec.stillConfirmed && !spec.stillConfirmed()) return notSent(spec.channel, "unconfirmed");
  return exchange(buildUrl(), spec, ctx);
}

// 记下退避，再问一次要等多久；退避记不下来也照样报这次的结果。
async function enterBackoff(ctx: SiteCtx, retryAfterSec: number | undefined): Promise<number | undefined> {
  try {
    await ctx.backoff.trip(retryAfterSec);
    const gate = await ctx.backoff.admit(ctx.signal);
    return gate.ok ? retryAfterSec : gate.retryAfterSec;
  } catch {
    return retryAfterSec;
  }
}

async function clearStrikes(ctx: SiteCtx): Promise<void> {
  try {
    await ctx.backoff.clear();
  } catch {
    // 只影响下次退避的时长，这次读取已经成功。
  }
}

// 调用方取消只是不再等，共用的请求照常跑完。
function untilAborted<T>(work: Promise<SiteResult<T>>, signal: AbortSignal): Promise<SiteResult<T>> {
  return new Promise((resolve) => {
    const stop = (): void => resolve(ABORTED);
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
    void work.then((result) => {
      signal.removeEventListener("abort", stop);
      resolve(result);
    });
  });
}

function sameKeys(left: SigningKeys, right: SigningKeys): boolean {
  return left.imgKey === right.imgKey && left.subKey === right.subKey;
}

function hasContent(value: unknown): boolean {
  return typeof value === "object" && value !== null && Object.keys(value).length > 0;
}

// 判断这次被拒值不值得换密钥重试。
function wantsNewKeys(reading: Reading): boolean {
  if (reading.apiCode !== SIGN_REJECTED_CODE || LIMIT_STATUSES.has(reading.status)) return false;
  return !hasContent((reading.body as { data?: unknown } | null)?.data);
}

/** 字幕文件的地址只收 https 和字幕文件的主机。 */
export function isCaptionFileUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname.endsWith(FILE_HOST_SUFFIX);
  } catch {
    return false;
  }
}

export function createBiliHttp(deps: BiliHttpDeps = {}): BiliHttp {
  const now = deps.now ?? Date.now;
  const requestTimeoutMs = deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  // 收到未登录信号就加一；各次操作记下的已登录结论只在代次没变时算数，不看时间。
  let generation = 0;
  const confirmed = new WeakMap<SiteCtx, number>();
  let keyRecord: { readonly keys: SigningKeys; readonly fetchedAt: number } | null = null;
  let pendingAccount: { readonly check: Promise<AccountCheck>; readonly generation: number } | null = null;

  function forgetLogin(): void {
    generation += 1;
  }

  async function failureOf(reading: Reading, ctx: SiteCtx): Promise<SiteFailure | null> {
    const row = ERROR_TABLE.find((candidate) => candidate.when(reading));
    if (!row) return null;
    if (row.forgetLogin) forgetLogin();
    const retryAfterSec = row.trip ? await enterBackoff(ctx, reading.retryAfterSec) : reading.retryAfterSec;
    const failure: SiteFailure = { ok: false, code: row.code, detail: detailOf(reading) };
    return row.code === "RATE_LIMITED" && retryAfterSec !== undefined ? { ...failure, retryAfterSec } : failure;
  }

  function apiSend(request: GetRequest, ctx: SiteCtx): Send {
    const timeoutMs = request.timeoutMs ?? requestTimeoutMs;
    return { channel: "api", init: API_INIT, timeoutMs, signal: ctx.signal, stillConfirmed: () => confirmed.get(ctx) === generation };
  }

  // 读登录状态，未登录时不留别的。
  async function readAccount(ctx: SiteCtx): Promise<AccountCheck> {
    const sentAt = generation;
    const spec: Send = { channel: "account", init: API_INIT, timeoutMs: requestTimeoutMs, signal: NEVER_ABORTED };
    const reading = await send(() => NAV_URL, spec, ctx);
    const failure = await failureOf(reading, ctx);
    if (failure) return { result: failure, generation: sentAt };
    const data = (reading.body as { data?: { isLogin?: unknown } | null } | null)?.data;
    if (!reading.enveloped || data?.isLogin !== true) {
      forgetLogin();
      return { result: { ok: false, code: "NEED_LOGIN", detail: "not-logged-in" }, generation: sentAt };
    }
    const keys = keysFromNav(reading.body);
    if (keys && keys.imgKey.length + keys.subKey.length >= KEY_ORDER.length) {
      keyRecord = { keys, fetchedAt: now() };
    }
    return { result: { ok: true, value: undefined }, generation: sentAt };
  }

  // 同一时间只发一个，只合并收到未登录信号之后发出的；用自己的时限，不接某个调用方的取消信号。
  // 读的途中收到未登录信号，这次不算确认，内容请求不发。
  async function loadAccount(ctx: SiteCtx): Promise<SiteResult<void>> {
    let entry = pendingAccount;
    if (!entry || entry.generation !== generation) {
      const started = { generation, check: readAccount(ctx) };
      const clear = (): void => {
        if (pendingAccount === started) pendingAccount = null;
      };
      void started.check.then(clear, clear);
      pendingAccount = entry = started;
    }
    const check = await entry.check;
    if (!check.result.ok) return check.result;
    if (check.generation !== generation) return { ok: false, code: "NEED_LOGIN", detail: "login-changed" };
    confirmed.set(ctx, generation);
    return check.result;
  }

  async function requireLogin(ctx: SiteCtx): Promise<SiteResult<void>> {
    if (confirmed.get(ctx) === generation) return { ok: true, value: undefined };
    if (ctx.signal.aborted) return ABORTED;
    return untilAborted(loadAccount(ctx), ctx.signal);
  }

  function detach(ctx: SiteCtx): SiteCtx {
    const shared: SiteCtx = { ...ctx, signal: NEVER_ABORTED };
    const seen = confirmed.get(ctx);
    if (seen !== undefined) confirmed.set(shared, seen);
    return shared;
  }

  function freshKeys(): SigningKeys | null {
    return keyRecord && now() - keyRecord.fetchedAt < KEY_TTL_MS ? keyRecord.keys : null;
  }

  async function signingKeys(ctx: SiteCtx): Promise<SiteResult<SigningKeys>> {
    const cached = freshKeys();
    if (cached) return { ok: true, value: cached };
    const account = await untilAborted(loadAccount(ctx), ctx.signal);
    if (!account.ok) return account;
    const fetched = freshKeys();
    return fetched ? { ok: true, value: fetched } : { ok: false, code: "MALFORMED", detail: "no-signing-keys" };
  }

  // 返回能重签一次的新密钥，不该重发时返回 null，未登录时返回这个失败。两次被拒之间最多换一次。
  async function keysAfterRejection(rejected: SigningKeys, ctx: SiteCtx): Promise<SigningKeys | SiteFailure | null> {
    if (!pendingAccount && keyRecord) {
      if (!sameKeys(keyRecord.keys, rejected)) return keyRecord.keys;
      if (now() - keyRecord.fetchedAt < STALE_KEY_AGE_MS) return null;
    }
    const account = await untilAborted(loadAccount(ctx), ctx.signal);
    if (!account.ok) return account.code === "NEED_LOGIN" ? account : null;
    const fresh = keyRecord?.keys;
    return fresh && !sameKeys(fresh, rejected) ? fresh : null;
  }

  async function finish(reading: Reading, ctx: SiteCtx): Promise<SiteResult<unknown>> {
    const failure = await failureOf(reading, ctx);
    if (failure) return failure;
    await clearStrikes(ctx);
    return { ok: true, value: reading.channel === "api" ? (reading.body as { data?: unknown }).data : reading.body };
  }

  async function getSigned(request: GetRequest, ctx: SiteCtx): Promise<SiteResult<unknown>> {
    const keys = await signingKeys(ctx);
    if (!keys.ok) return keys;
    const attempt = (signWith: SigningKeys): Promise<Reading> =>
      send(() => signedUrl(request.url, request.params ?? {}, signWith, now() / 1000), apiSend(request, ctx), ctx);
    const first = await attempt(keys.value);
    if (!wantsNewKeys(first)) return finish(first, ctx);
    const fresh = await keysAfterRejection(keys.value, ctx);
    if (ctx.signal.aborted) return ABORTED;
    if (fresh && "ok" in fresh) return fresh;
    return finish(fresh ? await attempt(fresh) : first, ctx);
  }

  async function getData(request: GetRequest, ctx: SiteCtx): Promise<SiteResult<unknown>> {
    const login = await requireLogin(ctx);
    if (!login.ok) return login;
    if (request.signed) return getSigned(request, ctx);
    const query = buildQuery(request.params ?? {});
    return finish(await send(() => (query ? `${request.url}?${query}` : request.url), apiSend(request, ctx), ctx), ctx);
  }

  async function getFile(url: string, ctx: SiteCtx): Promise<SiteResult<unknown>> {
    if (!isCaptionFileUrl(url)) return { ok: false, code: "MALFORMED", detail: "untrusted-file-host" };
    // 这次操作确认过登录的，排队期间作废了就不发；没确认过的由调用方负责先过登录门。
    const stillConfirmed = (): boolean => (confirmed.get(ctx) ?? generation) === generation;
    const spec: Send = { channel: "file", init: FILE_INIT, timeoutMs: requestTimeoutMs, signal: ctx.signal, stillConfirmed };
    return finish(await send(() => url, spec, ctx), ctx);
  }

  return { requireLogin, getData, getFile, detach, forgetLogin };
}
