// 醒来钩子：后台每次醒来后的第一个事件，把本机存储限制成只给扩展页面和后台用。
// 不等它做完，事件照常处理；设失败了记一条，下一个事件再试；设成功后这次醒着不再重复。
import { errorLabel, type Log } from "./log.ts";

export type Wake = <Args extends unknown[], Value>(listener: (...args: Args) => Value) => (...args: Args) => Value;

export function createWake(restrict: () => Promise<void>, log: Log): Wake {
  let state: "idle" | "pending" | "done" = "idle";
  const failed = (error: unknown): void => {
    state = "idle";
    log.warn("没能把本机存储限制成只给扩展页面和后台用，下一个事件再试", errorLabel(error));
  };
  const kick = (): void => {
    if (state !== "idle") return;
    state = "pending";
    let pending: Promise<void>;
    try {
      pending = restrict();
    } catch (error) {
      failed(error);
      return;
    }
    pending.then(() => {
      state = "done";
    }, failed);
  };
  return (listener) =>
    (...args) => {
      kick();
      return listener(...args);
    };
}
