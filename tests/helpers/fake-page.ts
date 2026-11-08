// 扩展页面的最小替身：页面的 localStorage、系统明暗的媒体查询，和挂在页面上的根节点 html。
// 只实现外观代码用到的几样；localStorage 和浏览器一样只存字符串。

export interface MemoryLocalStorage {
  readonly values: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function memoryLocalStorage(initial: Readonly<Record<string, string>> = {}): MemoryLocalStorage {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, String(value)),
    removeItem: (key) => void values.delete(key),
  };
}

export interface FakeRoot {
  readonly dataset: Record<string, string | undefined>;
  readonly style: { readonly values: Record<string, string>; setProperty(name: string, value: string): void };
  readonly ownerDocument: { readonly defaultView: FakeView };
}

export interface FakeView {
  readonly location: { readonly protocol: string };
  readonly localStorage: Pick<Storage, "getItem" | "setItem">;
  matchMedia(query: string): { readonly matches: boolean; addEventListener(type: "change", listener: () => void): void; removeEventListener(type: "change", listener: () => void): void };
}

export interface FakePageOptions {
  readonly protocol?: string;
  readonly localStorage?: Pick<Storage, "getItem" | "setItem">;
  readonly prefersDark?: boolean;
}

export interface FakePage {
  readonly root: FakeRoot;
  /** 改系统明暗，派发媒体查询的 change。 */
  readonly setPrefersDark: (dark: boolean) => void;
  /** 还挂着的系统明暗监听个数。 */
  readonly schemeListeners: () => number;
}

export function fakePage({ protocol = "chrome-extension:", localStorage = memoryLocalStorage(), prefersDark = false }: FakePageOptions = {}): FakePage {
  let dark = prefersDark;
  const listeners = new Set<() => void>();
  const values: Record<string, string> = {};
  const view: FakeView = {
    location: { protocol },
    localStorage,
    matchMedia: (query) => ({
      matches: query === "(prefers-color-scheme: dark)" && dark,
      addEventListener: (_type, listener) => void listeners.add(listener),
      removeEventListener: (_type, listener) => void listeners.delete(listener),
    }),
  };
  const root: FakeRoot = {
    dataset: {},
    style: {
      values,
      setProperty(name, value) {
        values[name] = value;
      },
    },
    ownerDocument: { defaultView: view },
  };
  return {
    root,
    setPrefersDark(next) {
      dark = next;
      for (const listener of [...listeners]) listener();
    },
    schemeListeners: () => listeners.size,
  };
}
