// 各层共用的类型守卫：只看值本身的形状。

/** 非空、不是数组的对象。 */
export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 字面量写出来的普通对象：除了不是数组，原型还得是 Object.prototype，类实例和无原型对象都不算。 */
export const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  isRecord(value) && Object.getPrototypeOf(value) === Object.prototype;

/** 标签页编号：不小于 0 的安全整数。 */
export const isTabId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
