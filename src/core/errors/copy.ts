// 一个错误码给用户看的三段话。各领域的文案表都用这个形状。
// 每个领域中文、英文各一张表，并排放在同一个文件里，繁体那张在旁边以 -hant.ts 结尾的模块里：中文那张定下有哪些码、哪些 detail，
// 英文、繁体那张少一条、多一条，类型检查就报错。

/** 每段是以句号结尾的整句；没话可说的那一段不写。 */
export interface ErrorCopy {
  readonly cause: string;
  readonly impact?: string;
  readonly next?: string;
}

/** 同一个码按 detail 换说法的表：码 → detail → 三段。 */
export type DetailTable<Code extends string> = Readonly<Partial<Record<Code, Readonly<Record<string, ErrorCopy>>>>>;

/** 和中文那张 detail 表同样的码、同样的 detail。 */
export type SameDetails<Zh> = { readonly [Code in keyof Zh]: { readonly [Detail in keyof Zh[Code]]: ErrorCopy } };
