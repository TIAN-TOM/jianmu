// 菜单：用浏览器的弹出层，点外面或按 Esc 自动收起。打开后焦点在第一项，上下方向键移动；
// 选了一项或收起以后，焦点回到打开它的按钮。
import { useId, useRef } from "preact/hooks";
import { Icon } from "./icon.tsx";
import type { IconName } from "./icons.ts";
import { rovingTarget } from "./keys.ts";
import { menuPlacement } from "./menu.ts";

export interface MenuItem {
  readonly label: string;
  /** 菜单项下面一行小字，比如「会再调一次模型」。 */
  readonly hint?: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  readonly onSelect: () => void;
}

export interface MenuProps {
  /** 打开菜单的按钮的无障碍名称。 */
  readonly label: string;
  readonly icon?: IconName;
  /** 按钮上的可见文字；不给就是只有图标的按钮。 */
  readonly text?: string;
  readonly items: readonly MenuItem[];
}

export function Menu({ label, icon = "more", text, items }: MenuProps) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);

  const entries = (): HTMLButtonElement[] => [...(popup.current?.querySelectorAll<HTMLButtonElement>("[role='menuitem']") ?? [])];
  const place = (): void => {
    const button = trigger.current;
    const menu = popup.current;
    const view = menu?.ownerDocument.defaultView;
    if (!button || !menu || !view) return;
    const at = menuPlacement(button.getBoundingClientRect(), { width: menu.offsetWidth, height: menu.offsetHeight }, { width: view.innerWidth, height: view.innerHeight });
    menu.style.left = `${at.left}px`;
    menu.style.top = `${at.top}px`;
  };
  const hide = (): void => {
    if (popup.current?.matches(":popover-open")) popup.current.hidePopover();
  };

  const onToggle = (event: Event & { readonly newState?: string }): void => {
    const menu = popup.current;
    if (!menu) return;
    if (event.newState === "open") {
      // 量好尺寸、摆好位置以后才显示出来，免得先在默认位置闪一下。
      place();
      menu.dataset["placed"] = "true";
      entries()[0]?.focus();
      return;
    }
    delete menu.dataset["placed"];
    // 收起时焦点还在菜单里，或者落到了页面上（按 Esc），就还给按钮；点了页面别处就留在那里。
    const active = menu.ownerDocument.activeElement;
    if (!active || active === menu.ownerDocument.body || menu.contains(active)) trigger.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    const list = entries();
    const current = list.findIndex((entry) => entry === event.target);
    const next = rovingTarget(event.key, current, list.length, "vertical");
    if (next === null) return;
    event.preventDefault();
    list[next]?.focus();
  };

  return (
    <span class="menu-anchor">
      <button
        ref={trigger}
        type="button"
        class={text ? "button" : "icon-button"}
        data-variant={text ? "text" : undefined}
        aria-label={text ? undefined : label}
        title={text ? undefined : label}
        aria-haspopup="menu"
        popovertarget={`${id}-menu`}
      >
        <Icon name={icon} />
        {text ? <span>{text}</span> : null}
      </button>
      <div ref={popup} id={`${id}-menu`} class="menu" popover="auto" role="menu" aria-label={label} onToggle={onToggle} onKeyDown={onKeyDown}>
        {items.map((item, index) => (
          <button
            key={index}
            type="button"
            class="menu-item"
            role="menuitem"
            data-danger={item.danger ? "true" : undefined}
            aria-disabled={item.disabled ? "true" : undefined}
            onClick={() => {
              if (item.disabled) return;
              hide();
              trigger.current?.focus();
              item.onSelect();
            }}
          >
            <span class="menu-label">{item.label}</span>
            {item.hint ? <span class="menu-hint">{item.hint}</span> : null}
          </button>
        ))}
      </div>
    </span>
  );
}
