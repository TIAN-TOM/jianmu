/// <reference types="chrome" />
// 工具栏图标右键菜单的薄封装：建菜单项的接口靠回调报错，这里换成 Promise。下面的接口只列用到的方法。

/** 只放在工具栏图标的右键菜单里的一项。 */
export interface ActionMenuItem {
  readonly id: string;
  readonly title: string;
  readonly type: "normal" | "checkbox";
  readonly checked?: boolean;
}

export interface ContextMenusApi {
  create(properties: { id: string; title: string; type: "normal" | "checkbox"; contexts: ["action"]; checked?: boolean }, callback?: () => void): unknown;
  update(id: string, properties: { checked: boolean }): Promise<void>;
  removeAll(): Promise<void>;
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
  return {
    removeAll: () => menus.removeAll(),
    create: ({ id, title, type, checked }) =>
      new Promise((resolve, reject) => {
        menus.create({ id, title, type, contexts: ["action"], ...(checked === undefined ? {} : { checked }) }, () => {
          const error = runtime.lastError;
          if (error) reject(new Error(error.message ?? "建菜单项失败"));
          else resolve();
        });
      }),
    setChecked: (id, checked) => menus.update(id, { checked }),
  };
}
