// 抽屉和层：抽屉从底部升起，还看得见当前位置；层盖住整个面板。两者都不改模式。
// 都用浏览器的模态对话框：打开时页面其余部分不可操作，Esc 关闭，关上以后焦点回到打开它的按钮。
// 开关由页面的状态决定：Esc 和点遮罩只是请页面关，页面把 open 改成 false 才真的关。
// 关上的那一刻就不再挡住页面、焦点也还回去，画面晚一点走（离场的过渡在 overlays.css）；
// 离场途中标题和内容照最后打开时的样子留着，不先变成空壳再淡出去。
import type { ComponentChildren } from "preact";
import { useEffect, useId, useRef } from "preact/hooks";
import { sharedText } from "../text.ts";
import { IconButton } from "./button.tsx";
import { usePresence } from "./presence.ts";

interface Shown {
  readonly title: string;
  readonly children: ComponentChildren;
}

/** 打开时是传进来的标题和内容；关上以后到离场走完是最后打开时的那份，之后又是传进来的。 */
function useLeavingContent(open: boolean, title: string, children: ComponentChildren) {
  const kept = usePresence<Shown>(open ? { title, children } : null);
  return { view: kept.shown ?? { title, children }, ref: kept.ref };
}

function useModal(open: boolean, onClose: () => void) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const wantOpen = useRef(open);
  const close = useRef(onClose);
  /** 页面自己关上、关闭事件还没到的次数：事件排队发，页面关上以后马上又打开时可能晚到。 */
  const closedByPage = useRef(0);
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
      closedByPage.current += 1;
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
    // 页面自己关的那一下已经还过焦点，晚到的关闭事件不再算数，免得把刚又打开的抽屉关掉。
    onClose(): void {
      if (closedByPage.current > 0) {
        closedByPage.current -= 1;
        return;
      }
      if (dialog.current?.open) return;
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
  const { view, ref } = useLeavingContent(open, title, children);
  return (
    <dialog
      ref={(node) => {
        modal.ref.current = node;
        ref.current = node;
      }}
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
            {view.title}
          </h2>
          <IconButton icon="close" label={sharedText().close} onClick={onClose} />
        </header>
        <div class="overlay-content">{view.children}</div>
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
  const { view, ref } = useLeavingContent(open, title, children);
  return (
    <dialog
      ref={(node) => {
        modal.ref.current = node;
        ref.current = node;
      }}
      class="layer"
      aria-labelledby={`${id}-title`}
      onCancel={modal.onCancel}
      onClose={modal.onClose}
    >
      <header class="overlay-head">
        <IconButton icon="back" label={sharedText().back} onClick={onClose} />
        <h2 class="overlay-title" id={`${id}-title`}>
          {view.title}
        </h2>
        {actions ? <span class="overlay-actions">{actions}</span> : null}
      </header>
      <div class="overlay-content">{view.children}</div>
    </dialog>
  );
}
