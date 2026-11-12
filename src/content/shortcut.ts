// 记笔记的快捷键：只认真实按键，按住连发只算第一下，带修饰键的不算；在输入框、可编辑区域里打字时不抢。
// 评论区这类输入框可能在封闭的 shadow root 里，顺着事件路径和焦点一层层往里找。

export interface ShortcutDeps {
  readonly document: Document;
  readonly key: string;
  readonly onPress: () => void;
  /** 拿得到封闭 shadow root 的接口，没有时只看开放的。 */
  readonly shadowRootOf?: (element: Element) => ShadowRoot | null;
}

function isEditable(node: unknown): boolean {
  if (typeof node !== "object" || node === null || typeof (node as Element).tagName !== "string") return false;
  const element = node as HTMLElement;
  const tag = element.tagName.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || element.isContentEditable === true || element.getAttribute?.("role") === "textbox";
}

export function isTyping(event: KeyboardEvent, document: Document, shadowRootOf: (element: Element) => ShadowRoot | null): boolean {
  if ([event.target, ...event.composedPath()].some(isEditable)) return true;
  let active: Element | null = document.activeElement;
  for (let depth = 0; active && depth < 20; depth += 1) {
    if (isEditable(active)) return true;
    active = shadowRootOf(active)?.activeElement ?? null;
  }
  return false;
}

/** 挂上快捷键，回撤销函数。 */
export function listenShortcut({ document, key, onPress, shadowRootOf = (element) => element.shadowRoot }: ShortcutDeps): () => void {
  const lower = key.toLowerCase();
  const onKeydown = (event: KeyboardEvent): void => {
    if (!event.isTrusted || event.key.toLowerCase() !== lower || event.repeat) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (isTyping(event, document, shadowRootOf)) return;
    event.preventDefault();
    onPress();
  };
  document.addEventListener("keydown", onKeydown);
  return () => document.removeEventListener("keydown", onKeydown);
}
