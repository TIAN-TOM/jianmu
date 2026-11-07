import assert from "node:assert/strict";
import { test } from "node:test";
import { findPackageProblems } from "../../../scripts/package.mjs";

const manifest = JSON.stringify({ version: "1.2.3", background: { service_worker: "background.js" }, side_panel: { default_path: "pages/a.html" } });
const good: Record<string, string> = {
  "manifest.json": manifest,
  "background.js": "console.log(1);\n",
  "pages/a.html": '<script type="module" src="./a.js"></script>',
  "pages/a.js": "console.log(2);\n",
};

function problems(files: Record<string, string>): string[] {
  return findPackageProblems({
    files: Object.keys(files),
    read: (file) => files[file] ?? "",
    expectedFiles: Object.keys(good),
    version: "1.2.3",
  });
}

test("合格的包不报", () => {
  assert.deepEqual(problems(good), []);
  assert.deepEqual(problems({ ...good, "background.js": 'const tip = "不读 Cookie 内容";\n' }), [], "文案里的大写 Cookie 不算读取");
});

test("拦下各类问题", () => {
  const cases: [Record<string, string>, RegExp][] = [
    [{ ...good, "background.js.map": "{}" }, /后缀不在白名单里/],
    [{ ...good, "src.ts": "" }, /后缀不在白名单里/],
    [{ ...good, ".hidden.js": "" }, /点开头/],
    [{ ...good, "a.test.js": "" }, /测试文件/],
    [{ ...good, "background.js": "eval('1');\n" }, /eval/],
    [{ ...good, "background.js": "new Function('return 1');\n" }, /new Function/],
    [{ ...good, "background.js": "importScripts('https://example.com/a.js');\n" }, /远程脚本/],
    [{ ...good, "background.js": "a();\r\nb();\r\n" }, /CRLF/],
    [{ ...good, "pages/a.html": '<script src="./missing.js"></script>' }, /missing\.js 不在包里/],
    [{ ...good, "background.js": "const c = document.cookie;\n" }, /读 Cookie/],
    [{ ...good, "background.js": "chrome.cookies.getAll({});\n" }, /读 Cookie/],
    [{ ...good, "background.js": "const c = document?.cookie;\n" }, /读 Cookie/],
    [{ ...good, "background.js": 'const c = document["cookie"];\n' }, /读 Cookie/],
    [{ ...good, "background.js": "cookieStore.getAll();\n" }, /读 Cookie/],
    [{ ...good, "background.js": "chrome?.cookies.getAll({});\n" }, /读 Cookie/],
    [{ ...good, "background.js": 'const c = document?.["cookie"];\n' }, /读 Cookie/],
    [{ ...good, "background.js": "const { cookie } = document;\n" }, /读 Cookie/],
    [{ ...good, "background.js": "const doc = document; doc.cookie;\n" }, /读 Cookie/],
    [{ ...good, "background.js": 'Reflect.get(document, "cookie");\n' }, /读 Cookie/],
    [{ ...good, "manifest.json": JSON.stringify({ version: "9.9.9", background: { service_worker: "background.js" } }) }, /清单版本/],
    [{ ...good, "manifest.json": JSON.stringify({ version: "1.2.3", background: { service_worker: "gone.js" } }) }, /gone\.js 不在包里/],
    [{ ...good, "extra.js": "" }, /文件清单/],
  ];
  for (const [files, expected] of cases) {
    assert.ok(problems(files).some((problem) => expected.test(problem)), String(expected));
  }
  const { "manifest.json": _dropped, ...withoutManifest } = good;
  assert.ok(problems(withoutManifest).some((problem) => /manifest\.json 不在包的顶层/.test(problem)));
});
