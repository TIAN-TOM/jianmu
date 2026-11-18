/// <reference types="chrome" />
// 运行时注册的内容脚本（chrome.scripting 的动态注册）的薄封装。下面的接口只列用到的方法，真实的接口和测试替身都按结构满足它们。

export interface ScriptRegistration {
  readonly id: string;
  readonly matches: readonly string[];
  readonly js: readonly string[];
}

export interface RegisteredScriptsApi {
  getRegisteredContentScripts(filter?: { ids?: string[] }): Promise<readonly { readonly id: string }[]>;
  registerContentScripts(scripts: { id: string; matches: string[]; js: string[]; runAt: "document_idle"; persistAcrossSessions: boolean }[]): Promise<void>;
  unregisterContentScripts(filter?: { ids?: string[] }): Promise<void>;
}

export interface RegisteredScripts {
  /** 这几个编号里已经注册着的。 */
  readonly registered: (ids: readonly string[]) => Promise<readonly string[]>;
  /** 注册一份，浏览器重启后也在；扩展更新后浏览器会清掉，要再注册。 */
  readonly register: (script: ScriptRegistration) => Promise<void>;
  readonly unregister: (ids: readonly string[]) => Promise<void>;
}

export function createRegisteredScripts(api: RegisteredScriptsApi = chrome.scripting): RegisteredScripts {
  return {
    registered: async (ids) => (ids.length === 0 ? [] : (await api.getRegisteredContentScripts({ ids: [...ids] })).map(({ id }) => id)),
    register: ({ id, matches, js }) =>
      api.registerContentScripts([{ id, matches: [...matches], js: [...js], runAt: "document_idle", persistAcrossSessions: true }]),
    unregister: (ids) => (ids.length === 0 ? Promise.resolve() : api.unregisterContentScripts({ ids: [...ids] })),
  };
}
