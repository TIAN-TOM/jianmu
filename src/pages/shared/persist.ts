// 向浏览器申请持久化存储，减少本机的笔记和概览在存储压力下被清掉的机会。每个页面只申请一次；
// 这个方法只在页面里有，后台没有。浏览器没有这个方法、不同意或者出错，都照常运行，不提示用户。

/** navigator.storage 里用到的那一个方法。 */
export interface PersistableStorage {
  persist?: () => Promise<boolean>;
}

const asked = new WeakMap<object, Promise<boolean>>();

/** 回浏览器同不同意；同一个页面再调，回第一次的结果，不再申请。 */
export function requestPersistence(storage: PersistableStorage | undefined = globalThis.navigator?.storage): Promise<boolean> {
  const persist = storage?.persist;
  if (!storage || typeof persist !== "function") return Promise.resolve(false);
  const earlier = asked.get(storage);
  if (earlier) return earlier;
  const answer = Promise.resolve()
    .then(() => persist.call(storage))
    .then(
      (granted) => granted === true,
      () => false,
    );
  asked.set(storage, answer);
  return answer;
}
