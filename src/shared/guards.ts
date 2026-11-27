// 各层共用的类型守卫和取字符串的小函数：只看值本身的形状。

/** 非空、不是数组的对象。 */
export const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 非空的对象，数组也算：数组要和 null、原始值走到不同结果的地方用它，别处用 isRecord。 */
export const isObjectLike = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null;

/** 字面量写出来的普通对象：除了不是数组，原型还得是 Object.prototype，类实例和无原型对象都不算。 */
export const isPlainObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  isRecord(value) && Object.getPrototypeOf(value) === Object.prototype;

/** 标签页编号：不小于 0 的安全整数。 */
export const isTabId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** 秒数：有限、不小于 0 的数，不设上限。 */
export const isSeconds = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** 是字符串就原样取，别的当空串。 */
export const stringOrEmpty = (value: unknown): string => (typeof value === "string" ? value : "");

/** 是字符串就去掉首尾空白，别的当空串。 */
export const trimmedOrEmpty = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
