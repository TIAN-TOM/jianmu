// 回收用不上的主机授权。拉模型列表和测试连接也会给还没保存的地址申请权限，换过几次地址就攒下一串。
// 保留集合是清单主机、内容脚本的匹配规则、已启用站点的来源和当前 AI 地址的来源，其余的一条一条收。
import type { Permissions } from "../platform/permissions.ts";
import { originOf, type NormalizedSettings } from "../shared/settings-schema.ts";

export interface GrantsDeps {
  readonly permissions: Permissions;
  readonly loadSettings: () => Promise<NormalizedSettings>;
  /** 已启用站点的来源，保存 AI 设置不能碰这些授权。 */
  readonly siteOrigins: (settings: NormalizedSettings) => readonly string[];
  readonly logError?: (message: string, detail: unknown) => void;
}

export interface ReleaseResult {
  readonly released: readonly string[];
  readonly failed: readonly string[];
}

export interface Grants {
  /**
   * 回收用不上的授权，要等设置保存成功再调：新地址在保存之前就申请好了，
   * 夹在中间调用会把它当成用不上的收掉。回收失败不影响已经保存好的设置，只是多留几条授权，所以这里不抛错。
   */
  readonly releaseUnused: () => Promise<ReleaseResult>;
}

interface Host {
  readonly name: string;
  readonly port: string;
}

const ANY_PORT = "*";

// 匹配规则的主机和端口。路径不比：授权按主机生效，浏览器回收时也按主机算。
// 没写端口的规则管这个主机的所有端口。认不出的写法是 null。
function hostOf(pattern: string): Host | null {
  const [, name, port = ANY_PORT] = /^(?:https|\*):\/\/([^/:]+)(?::(\d+|\*))?(?:\/|$)/.exec(pattern) ?? [];
  return name ? { name, port } : null;
}

function covers(wide: Host, narrow: Host): boolean {
  if (wide.port !== ANY_PORT && wide.port !== narrow.port) return false;
  if (wide.name === "*") return true;
  if (!wide.name.startsWith("*.")) return wide.name === narrow.name;
  const domain = wide.name.slice(2);
  return narrow.name === domain || narrow.name.endsWith(`.${domain}`);
}

// 谁盖住谁都算在用。保留的规则盖住它时不用收；它盖住保留的规则时不能收：
// 浏览器不会拒绝，而是把落在里面的必需主机一起收掉，还回一个 true。
// 当前地址没写端口时，同一主机带端口的授权也算在用：多留一条，下次还能收，收错了要用户重新授权。
const inUse = (host: Host, kept: readonly Host[]): boolean =>
  kept.some((other) => covers(host, other) || covers(other, host));

export function createGrants({
  permissions,
  loadSettings,
  siteOrigins,
  logError = console.error,
}: GrantsDeps): Grants {
  async function unusedGrants(): Promise<readonly string[]> {
    const settings = await loadSettings();
    const aiOrigin = originOf(settings.aiBaseUrl);
    // 地址不合法时不知道现在用的是哪个来源，这次不收：多留的下次保存还能收，收错了要用户重新授权。
    if (!aiOrigin) return [];
    const kept = [...permissions.declared(), ...siteOrigins(settings), aiOrigin]
      .map(hostOf)
      .filter((host) => host !== null);
    return (await permissions.listed()).filter((pattern) => {
      const host = hostOf(pattern);
      // 认不出的写法可能很宽，收了会连带必需主机，不碰。
      return host !== null && !inUse(host, kept);
    });
  }

  async function revoke(pattern: string): Promise<boolean> {
    try {
      const revoked = await permissions.revoke(pattern);
      if (!revoked) logError("回收主机授权失败", { pattern });
      return revoked;
    } catch (error) {
      logError("回收主机授权失败", { pattern, error });
      return false;
    }
  }

  return {
    async releaseUnused() {
      const released: string[] = [];
      const failed: string[] = [];
      let unused: readonly string[];
      try {
        unused = await unusedGrants();
      } catch (error) {
        logError("读取主机授权失败", error);
        return { released, failed };
      }
      for (const pattern of unused) {
        if (await revoke(pattern)) released.push(pattern);
        else failed.push(pattern);
      }
      return { released, failed };
    },
  };
}
