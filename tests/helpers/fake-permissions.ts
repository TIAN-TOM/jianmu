// chrome.permissions 的替身，形状和行为按 Chrome 153 实测写。主机名是造的，结构和真实清单一样：
// 三个必需主机，其中一个带通配符；内容脚本四条匹配规则；可选主机声明整个 https。
import type { ManifestHosts, PermissionsApi } from "../../src/platform/permissions.ts";

export const REQUIRED_HOSTS = [
  "https://www.video.example/*",
  "https://data.video.example/*",
  "https://*.static.example/*",
] as const;

export const CONTENT_MATCHES = [
  "https://www.video.example/play/*",
  "https://www.video.example/list/*",
  "https://www.video.example/*/play/*",
  "https://www.video.example/*/list/*",
] as const;

const MANIFEST: ManifestHosts = {
  host_permissions: REQUIRED_HOSTS,
  content_scripts: [{ matches: CONTENT_MATCHES }],
};

const REQUIRED_ERROR = "You cannot remove required permissions.";
const UNDECLARED_ERROR = "Only permissions specified in the manifest may be requested.";

const ANY_PORT = "*";

function parse(pattern: string): { scheme: string; host: string; port: string } {
  const match = /^([^:]+):\/\/([^/]+?)(?::(\d+|\*))?\//.exec(pattern);
  if (!match) throw new Error(`Invalid value for origin pattern ${pattern}: Missing scheme separator.`);
  return { scheme: match[1] ?? "", host: match[2] ?? "", port: match[3] ?? ANY_PORT };
}

function hostCovers(wide: string, narrow: string): boolean {
  if (wide === "*") return true;
  if (!wide.startsWith("*.")) return wide === narrow;
  return narrow === wide.slice(2) || narrow.endsWith(wide.slice(1));
}

// 没写端口的规则盖住这个主机的所有端口，写了端口只盖这一个。
function covers(wide: string, narrow: string): boolean {
  const outer = parse(wide);
  const inner = parse(narrow);
  return (outer.port === ANY_PORT || outer.port === inner.port) && hostCovers(outer.host, inner.host);
}

export interface FakePermissionsOptions {
  /** 运行时的授权，浏览器列出来就是这个写法。 */
  readonly granted?: readonly string[];
  /** 清单里没写、浏览器却当成必需的规则，列出来但回收不了。 */
  readonly alsoRequired?: readonly string[];
}

export interface FakePermissions {
  readonly api: PermissionsApi;
  readonly manifest: () => ManifestHosts;
  /** permissions.request 成功后的样子：请求时写的路径不算，列出来总是整个主机。 */
  readonly grant: (origin: string) => void;
  /** 列出来的全部规则，排好序，和 getAll 一样。 */
  readonly origins: () => string[];
  /** 每次 remove 调用传进来的规则。 */
  readonly removeCalls: string[][];
  /** 真的被收掉的规则。 */
  readonly removed: string[];
}

export function fakePermissions({ granted = [], alsoRequired = [] }: FakePermissionsOptions = {}): FakePermissions {
  // 回收能动到的：运行时的授权，和被更宽的规则连带收掉的清单主机。内容脚本的匹配规则一直在。
  const hosts = new Set<string>([...REQUIRED_HOSTS, ...granted]);
  const fixed = [...CONTENT_MATCHES, ...alsoRequired];
  const required = [...REQUIRED_HOSTS, ...fixed];
  const removeCalls: string[][] = [];
  const removed: string[] = [];
  const origins = () => [...hosts, ...fixed].sort();

  return {
    api: {
      getAll: async () => ({ permissions: ["sidePanel", "storage", "scripting"], origins: origins() }),
      // 每条都要被列出来的某条规则盖住才算有。
      contains: async ({ origins: patterns }) => patterns.every((pattern) => origins().some((host) => covers(host, pattern))),
      // 整批要么全过要么全拒。没授权过的规则照样回 true；比必需主机宽的规则不拒绝，落在里面的一起收掉。
      async remove({ origins: patterns }) {
        removeCalls.push([...patterns]);
        if (patterns.some((pattern) => parse(pattern).scheme !== "https")) throw new Error(UNDECLARED_ERROR);
        if (patterns.some((pattern) => required.some((host) => covers(host, pattern)))) throw new Error(REQUIRED_ERROR);
        for (const pattern of patterns) {
          for (const host of [...hosts]) {
            if (!covers(pattern, host)) continue;
            hosts.delete(host);
            removed.push(host);
          }
        }
        return true;
      },
    },
    manifest: () => MANIFEST,
    grant(origin) {
      hosts.add(`${new URL(origin).origin}/*`);
    },
    origins,
    removeCalls,
    removed,
  };
}
