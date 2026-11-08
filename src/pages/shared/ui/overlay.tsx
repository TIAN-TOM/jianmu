// 抽屉和层：抽屉从底部升起，还看得见当前位置；层盖住整个面板。两者都不改模式。
// 都用浏览器的模态对话框：打开时页面其余部分不可操作，Esc 关闭，关上以后焦点回到打开它的按钮。
// 开关由页面的状态决定：Esc 和点遮罩只是请页面关，页面把 open 改成 false 才真的关。
import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import { IconButton } from "./button.tsx";

function useModal(open: boolean, onClose: () => void) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const wantOpen = useRef(open);
  const close = useRef(onClose);
  wantOpen.current = open;
  close.current = onClose;

  // 新版浏览器关对话框时自己会把焦点还回去，这里再还一次，老版本上也一样。
  const restoreFocus = (): void => {
    const target = opener.current;
    opener.current = null;
    if (target?.isConnected) target.focus();
  };

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (open && !node.open) {
      const active = node.ownerDocument.activeElement;
      opener.current = active instanceof HTMLElement ? active : null;
      node.showModal();
    } else if (!open && node.open) {
      node.close();
      restoreFocus();
    }
  }, [open]);

  // 开着的时候整个组件被拿掉：先关上再拿掉，焦点才回得去，不落到页面上。
  useEffect(
    () => () => {
      if (dialog.current?.open) dialog.current.close();
      restoreFocus();
    },
    [],
  );

  return {
    ref: dialog,
    onCancel(event: Event): void {
      event.preventDefault();
      close.current();
    },
    // 浏览器自己关掉了对话框（连按 Esc 时可能不等页面），把状态同步回页面，焦点照样还回去。
    onClose(): void {
      restoreFocus();
      if (wantOpen.current) close.current();
    },
  };
}

export interface SheetProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ComponentChildren;
}

export function Sheet({ open, title, onClose, children }: SheetProps) {
  const id = useId();
  const modal = useModal(open, onClose);
  return (
    <dialog
      ref={modal.ref}
      class="sheet"
      aria-labelledby={`${id}-title`}
      onCancel={modal.onCancel}
      onClose={modal.onClose}
      onClick={(event) => {
        // 只有点在遮罩上时事件目标才是对话框本身：内容区铺满了对话框。
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div class="sheet-body">
        <header class="overlay-head">
          <h2 class="overlay-title" id={`${id}-title`}>
            {title}
          </h2>
          <IconButton icon="close" label="关闭" onClick={onClose} />
        </header>
        <div class="overlay-content">{children}</div>
      </div>
    </dialog>
  );
}

export interface LayerProps {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly actions?: ComponentChildren;
  readonly children: ComponentChildren;
}

export function Layer({ open, title, onClose, actions, children }: LayerProps) {
  const id = useId();
  const modal = useModal(open, onClose);
  return (
    <dialog ref={modal.ref} class="layer" aria-labelledby={`${id}-title`} onCancel={modal.onCancel} onClose={modal.onClose}>
      <header class="overlay-head">
        <IconButton icon="back" label="返回" onClick={onClose} />
        <h2 class="overlay-title" id={`${id}-title`}>
          {title}
        </h2>
        {actions ? <span class="overlay-actions">{actions}</span> : null}
      </header>
      <div class="overlay-content">{children}</div>
    </dialog>
  );
}
