// 把外来的时间值换成秒数：读平台返回的时间点和导出笔记共用。

/** 认得出的非负秒数；空值、认不出的和负数都是 null。空值换成数字会变 0，跳到片头比没有落点更糟。 */
export function secondsOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}
