// 可复现打包用到的纯函数：文件顺序、固定时间的取值、校验值文件的格式。
import { Buffer } from "node:buffer";

// zip 里的时间是 DOS 格式，只能表示 1980 到 2107 年。
const DOS_EPOCH_MIN = 315532800;
const DOS_EPOCH_MAX = 4354819198;

/** 按路径的 UTF-8 字节序排好，不受系统语言和文件系统列目录顺序的影响。 @param {readonly string[]} paths */
export function sortZipEntries(paths) {
  return [...paths].sort((a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")));
}

/**
 * 包里每个文件的修改时间：优先用环境变量给的值，没有就用提交时间。
 * @param {string | undefined} value 环境变量 SOURCE_DATE_EPOCH
 * @param {() => string} readCommitTime 读当前提交的提交时间（秒），只在没给环境变量时调用
 * @returns {number}
 */
export function resolveSourceDateEpoch(value, readCommitTime) {
  const fromEnv = value !== undefined && value.trim() !== "";
  const text = (fromEnv ? value : readCommitTime()).trim();
  const label = fromEnv ? "SOURCE_DATE_EPOCH " : "提交时间";
  if (!/^\d+$/.test(text)) throw new Error(`${label}不是整数秒：${text}`);
  const epoch = Number(text);
  if (epoch < DOS_EPOCH_MIN || epoch > DOS_EPOCH_MAX) throw new Error(`${label}超出 zip 能记的时间范围：${text}`);
  return epoch;
}

/** 一行校验值，`shasum -a 256 -c` 和 `sha256sum -c` 都认。 @param {string} sha256 @param {string} fileName */
export function checksumLine(sha256, fileName) {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`不是小写十六进制的 SHA-256：${sha256}`);
  if (/[\\/\n]/.test(fileName)) throw new Error(`文件名不能带路径或换行：${fileName}`);
  return `${sha256}  ${fileName}\n`;
}

/** 读回一行校验值。 @param {string} text @returns {{ sha256: string, fileName: string }} */
export function parseChecksumLine(text) {
  const match = /^([0-9a-f]{64}) [ *](\S[^\n]*)\n?$/.exec(text);
  if (!match) throw new Error("校验值文件的格式不对");
  return { sha256: match[1] ?? "", fileName: match[2] ?? "" };
}
