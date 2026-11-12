// 小窗避让：播放器进了页面内的小窗，或者笔记按钮盖住了小窗的关闭按钮，就把按钮那一层藏起来。
// 页面在播放器容器上标着屏幕状态时信它；看不到标记时，按「固定定位、很小」的样子兜底。
export interface MiniPlayerDeps {
  readonly document: Document;
  /** 笔记按钮那一层。 */
  readonly overlay: () => HTMLElement | null;
  /** 观察 class 和屏幕状态变化的播放器容器。 */
  readonly container: () => Element | null;
  /** 小窗的关闭按钮，平时没有尺寸。 */
  readonly closeButton: () => Element | null;
  /** 播放器容器上标屏幕状态的属性名。 */
  readonly screenAttribute: string;
}

export interface MiniPlayer {
  /** 定时自查时调一次，也在滚动、容器状态变化后调。 */
  readonly sync: () => void;
  readonly stop: () => void;
}

const MINI_CLASSES = ["bpx-state-mini", "bili-mini-player", "mini-player", "mode-miniplayer"];
const MINI_SCREEN = "mini";
const NORMAL_SCREENS = new Set(["normal", "wide", "web", "full"]);
const MINI_MAX = { width: 480, height: 360 };

type Box = Pick<DOMRect, "left" | "top" | "right" | "bottom" | "width" | "height">;

const sized = (box: Box | null): box is Box => box !== null && box.width > 0 && box.height > 0;
const overlap = (a: Box | null, b: Box | null): boolean =>
  sized(a) && sized(b) && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

function boxOf(element: Element | null): Box | null {
  try {
    return element ? element.getBoundingClientRect() : null;
  } catch {
    return null;
  }
}

export function createMiniPlayer({ document, overlay, container, closeButton, screenAttribute }: MiniPlayerDeps): MiniPlayer {
  const view = document.defaultView;
  // 是因为盖住关闭按钮才藏的：藏起来以后量出来是 0，不能据此又摆回去，关闭按钮还在就一直藏着。
  let hiddenForClose = false;
  let observer: MutationObserver | null = null;
  let observed: Element | null = null;
  let frame = 0;

  function fixedAndSmall(element: Element): boolean {
    if (view?.getComputedStyle(element).position !== "fixed") return false;
    const box = boxOf(element);
    return sized(box) && box.width <= MINI_MAX.width && box.height <= MINI_MAX.height;
  }

  function inMini(player: Element | null): boolean {
    const chain: Element[] = [];
    let marked = false;
    for (let node = player, depth = 0; node && depth < 8; node = node.parentElement, depth += 1) {
      if (MINI_CLASSES.some((name) => node?.classList.contains(name))) return true;
      const screen = (node.getAttribute(screenAttribute) ?? "").toLowerCase();
      if (screen === MINI_SCREEN) return true;
      if (NORMAL_SCREENS.has(screen)) marked = true;
      chain.push(node);
    }
    return !marked && chain.some(fixedAndSmall);
  }

  function setHidden(layer: HTMLElement, hidden: boolean): void {
    // 没变就不写：页面自己的变化监听看得到每一次属性写入。
    const display = hidden ? "none" : "flex";
    if (layer.style.display !== display) layer.style.display = display;
  }

  function watch(): void {
    const root = container();
    if (!root || root === observed || typeof MutationObserver !== "function") return;
    observer?.disconnect();
    observed = root;
    observer = new MutationObserver(() => sync());
    observer.observe(root, { attributes: true, attributeFilter: ["class", screenAttribute] });
  }

  function sync(): void {
    watch();
    const layer = overlay();
    if (!layer) return;
    const mini = inMini(layer.parentElement);
    const closeBox = boxOf(closeButton());
    if (!sized(closeBox)) hiddenForClose = false;
    else if (!mini && !hiddenForClose && (overlap(boxOf(layer), closeBox) || overlap(boxOf(layer.firstElementChild), closeBox))) hiddenForClose = true;
    setHidden(layer, mini || hiddenForClose);
  }

  // 小窗是文档滚动后才出现的；一帧里的几次滚动只算一次，内部容器自己滚动不算。
  const onScroll = (event: Event): void => {
    if (event.target !== document || frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      sync();
    });
  };
  document.addEventListener("scroll", onScroll, { passive: true });

  return {
    sync,
    stop() {
      document.removeEventListener("scroll", onScroll);
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      observer = null;
      observed = null;
    },
  };
}
