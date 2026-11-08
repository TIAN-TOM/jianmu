// 让 Node 认得构建才有的 `prompt:<文件名>` 导入：和构建一样按文本读 prompts/ 下的模板，去掉 \r。
// 只有要加载后台入口的测试才导入这个文件。
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MARK = "?prompt-text";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (!specifier.startsWith("prompt:")) return nextResolve(specifier, context);
    const file = join(ROOT, "prompts", specifier.slice("prompt:".length));
    return { url: `${pathToFileURL(file).href}${MARK}`, format: "module", shortCircuit: true };
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(MARK)) return nextLoad(url, context);
    const text = readFileSync(fileURLToPath(url.slice(0, -MARK.length)), "utf8").replaceAll("\r", "");
    return { format: "module", source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
  },
});
