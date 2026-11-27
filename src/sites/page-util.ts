// 两站页面模块共用的小工具：按时等待、听元素的一个属性、把视频引用换成键。只读页面，不插节点，不发请求。
import { videoKey, type VideoRef } from "../core/video-ref.ts";

/** 等 ms 毫秒；中止时拒绝。 */
export function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 元素的这个属性变了就调，返回停止函数；没有 MutationObserver 时什么也不做。 */
export function watchAttribute(element: Element, name: string, run: () => void): () => void {
  if (typeof MutationObserver !== "function") return () => undefined;
  const observer = new MutationObserver(run);
  observer.observe(element, { attributes: true, attributeFilter: [name] });
  return () => observer.disconnect();
}

/** 视频引用的键；没有视频时是 null。 */
export const keyOf = (ref: VideoRef | null): string | null => (ref ? videoKey(ref) : null);
