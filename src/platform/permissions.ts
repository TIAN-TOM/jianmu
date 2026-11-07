/// <reference types="chrome" />
// chrome.permissions 的薄封装，加上清单写死的主机。下面的接口只列用到的方法，真实的接口和测试替身都按结构满足它们。

export interface PermissionsApi {
  getAll(): Promise<{ readonly origins?: readonly string[] }>;
  remove(permissions: { origins: string[] }): Promise<boolean>;
}

export interface ManifestHosts {
  readonly host_permissions?: readonly string[];
  readonly content_scripts?: readonly { readonly matches?: readonly string[] }[];
}

export interface Permissions {
  /** 清单写死的主机和内容脚本的匹配规则。 */
  readonly declared: () => readonly string[];
  /** 浏览器现在列出的全部主机规则。除了运行时的授权，清单主机和内容脚本的匹配规则也在里面。 */
  readonly listed: () => Promise<readonly string[]>;
  /** 回收一条。不提供批量：一批里只要有一条回收不了，浏览器就拒绝整批。 */
  readonly revoke: (pattern: string) => Promise<boolean>;
}

export function createPermissions(
  api: PermissionsApi = chrome.permissions,
  manifest: () => ManifestHosts = () => chrome.runtime.getManifest(),
): Permissions {
  return {
    declared() {
      const { host_permissions: hosts = [], content_scripts: scripts = [] } = manifest();
      return [...hosts, ...scripts.flatMap(({ matches = [] }) => matches)];
    },
    listed: async () => (await api.getAll()).origins ?? [],
    revoke: (pattern) => api.remove({ origins: [pattern] }),
  };
}
