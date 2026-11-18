/// <reference types="chrome" />
// 工具栏图标右键菜单的薄封装：这几个接口在清单支持的最低版本上还不回 Promise，一律走回调，报错从回调里读，这里换成 Promise。
// 下面的接口只列用到的方法。

/** 只放在工具栏图标的右键菜单里的一项。 */
export interface ActionMenuItem {
  readonly id: string;
  readonly title: string;
  readonly type: "normal" | "checkbox";
  readonly checked?: boolean;
}

export interface ContextMenusApi {
  create(properties: { id: string; title: string; type: "normal" | "checkbox"; contexts: ["action"]; checked?: boolean }, callback?: () => void): unknown;
  update(id: string, properties: { checked: boolean }, callback?: () => void): unknown;
  removeAll(callback?: () => void): unknown;
}

export interface ContextMenusDeps {
  readonly menus: ContextMenusApi;
  /** 回调里读到的上一次调用的错误。 */
  readonly runtime: { readonly lastError?: { readonly message?: string } | undefined };
}

export interface ContextMenus {
  /** 清掉本扩展建过的全部菜单项。 */
  readonly removeAll: () => Promise<void>;
  /** 建一项；同名标识已经有了等浏览器报错时抛出。 */
  readonly create: (item: ActionMenuItem) => Promise<void>;
  /** 改一项的勾选状态。 */
  readonly setChecked: (id: string, checked: boolean) => Promise<void>;
}

export function createContextMenus({ menus, runtime }: ContextMenusDeps): ContextMenus {
  // 调一个带回调的接口，回调里有报错就拒绝。
  const call = (run: (done: () => void) => void, failed: string): Promise<void> =>
    new Promise((resolve, reject) => {
      run(() => {
        const error = runtime.lastError;
        if (error) reject(new Error(error.message ?? failed));
        else resolve();
      });
    });
  return {
    removeAll: () => call((done) => menus.removeAll(done), "清掉菜单项失败"),
    create: ({ id, title, type, checked }) => call((done) => menus.create({ id, title, type, contexts: ["action"], ...(checked === undefined ? {} : { checked }) }, done), "建菜单项失败"),
    setChecked: (id, checked) => call((done) => menus.update(id, { checked }, done), "改菜单项的勾选失败"),
  };
}
