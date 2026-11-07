// B 站请求的严格替身：没配的地址抛错，记下每个请求；没绑定就以方法形式调用时抛错，和浏览器一样。
import assert from "node:assert/strict";
import { signParams, type SigningKeys } from "../../src/sites/bilibili/sign.ts";
import type { SiteBackoff, SiteCtx, SiteResult } from "../../src/sites/types.ts";

export interface SeenRequest {
  readonly url: string;
  readonly endpoint: string; // 不带查询串的地址
  readonly query: URLSearchParams;
  readonly init: RequestInit;
  readonly headers: Readonly<Record<string, string>>;
}

export type Route = (request: SeenRequest) => Response | Promise<Response>;

export interface FakeSite {
  readonly fetch: typeof fetch;
  readonly requests: SeenRequest[];
  readonly routes: Map<string, Route>;
  calls(endpoint: string): SeenRequest[];
}

/** 路由表的键是不带查询串的完整地址。 */
export function fakeSite(routes: Readonly<Record<string, Route>> = {}): FakeSite {
  const table = new Map(Object.entries(routes));
  const requests: SeenRequest[] = [];
  const strictFetch = function (this: unknown, input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    const url = String(input);
    const parsed = new URL(url);
    const endpoint = `${parsed.origin}${parsed.pathname}`;
    const seen: SeenRequest = {
      url,
      endpoint,
      query: parsed.searchParams,
      init,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
    };
    // 先记下再抛错：出口会把抛错报成失败，意外的请求要靠这份记录查出来。
    requests.push(seen);
    const route = table.get(endpoint);
    if (!route) throw new Error(`替身没有配这个地址：${url}`);
    return Promise.resolve(route(seen));
  };
  return {
    fetch: strictFetch as typeof fetch,
    requests,
    routes: table,
    calls: (endpoint) => requests.filter((request) => request.endpoint === endpoint),
  };
}

export interface FakeBackoff extends SiteBackoff {
  readonly trips: (number | undefined)[];
  readonly admits: AbortSignal[];
  clears: number;
  blockedSec: number; // 大于 0 时不放行
}

/** 进了退避就不再放行，等多久由 trip 的参数定，没有时按 60 秒。 */
export function fakeBackoff(): FakeBackoff {
  const backoff: FakeBackoff = {
    trips: [],
    admits: [],
    clears: 0,
    blockedSec: 0,
    async admit(signal) {
      backoff.admits.push(signal);
      signal.throwIfAborted();
      return backoff.blockedSec > 0 ? { ok: false, retryAfterSec: backoff.blockedSec } : { ok: true };
    },
    async trip(retryAfterSec) {
      backoff.trips.push(retryAfterSec);
      backoff.blockedSec = retryAfterSec ?? 60;
    },
    async clear() {
      backoff.clears += 1;
    },
  };
  return backoff;
}

/** 和真实入口一样绑定 fetch。 */
export function siteCtx(site: FakeSite, backoff: SiteBackoff = fakeBackoff(), signal?: AbortSignal): SiteCtx {
  return { fetch: site.fetch.bind(globalThis), signal: signal ?? new AbortController().signal, backoff };
}

export function testClock(start = 1_800_000_000_000): { at: number; now: () => number } {
  const clock = { at: start, now: (): number => clock.at };
  return clock;
}

export function failure<T>(result: SiteResult<T>): Extract<SiteResult<T>, { ok: false }> {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (result.ok) throw new Error("不该走到这里");
  return result;
}

export function value<T>(result: SiteResult<T>): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("不该走到这里");
  return result.value;
}

/** 一直不回的请求：只在被中止时才失败，和浏览器里收到中止信号一样。 */
export const hanging: Route = (request) =>
  new Promise((_resolve, reject) => {
    request.init.signal?.addEventListener("abort", () => reject(new Error("中止了")));
  });

export function signatureOf(request: SeenRequest): string {
  return request.query.get("w_rid") ?? "";
}

/** 用给定的密钥把这个请求的参数重新签一遍，看签名是不是用它算的。 */
export function expectedSignature(request: SeenRequest, keys: SigningKeys): string {
  const { w_rid: _signature, wts, ...params } = Object.fromEntries(request.query.entries());
  return signParams(params, keys, Number(wts)).w_rid;
}
