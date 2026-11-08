import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { checksumLine, parseChecksumLine, resolveSourceDateEpoch, sortZipEntries } from "../../../scripts/lib/zip-order.mjs";
import { findPackageProblems, normalizeEntries, writeZip } from "../../../scripts/package.mjs";

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

test("文件按路径的字节序排，和输入顺序无关", () => {
  const paths = ["pages/sidepanel.js", "LICENSE.txt", "background.js", "pages/a.html", "manifest.json", "Z.txt", "pages/sidepanel.html"];
  const sorted = ["LICENSE.txt", "Z.txt", "background.js", "manifest.json", "pages/a.html", "pages/sidepanel.html", "pages/sidepanel.js"];
  assert.deepEqual(sortZipEntries(paths), sorted);
  assert.deepEqual(sortZipEntries([...paths].reverse()), sorted);
  // 按字节比，不按系统语言：大写在小写前，「/」在字母前，中文在 ASCII 后。
  assert.deepEqual(sortZipEntries(["b", "a/b", "A", "中", "a-b"]), ["A", "a-b", "a/b", "b", "中"]);
});

test("文件时间优先用环境变量，没有就用提交时间", () => {
  const commitTime = () => "1762600000\n";
  assert.equal(resolveSourceDateEpoch("1700000000", commitTime), 1700000000);
  assert.equal(resolveSourceDateEpoch(undefined, commitTime), 1762600000);
  assert.equal(resolveSourceDateEpoch("  ", commitTime), 1762600000);
  assert.equal(resolveSourceDateEpoch("1700000000", () => assert.fail("给了环境变量就不读提交时间")), 1700000000);
  assert.throws(() => resolveSourceDateEpoch("1.5", commitTime), /不是整数秒/);
  assert.throws(() => resolveSourceDateEpoch("-1", commitTime), /不是整数秒/);
  assert.throws(() => resolveSourceDateEpoch("100", commitTime), /超出 zip 能记的时间范围/);
});

test("校验值行两个空格隔开文件名，能读回来", () => {
  const sha256 = "a".repeat(64);
  assert.equal(checksumLine(sha256, "jianmu-0.1.0.zip"), `${sha256}  jianmu-0.1.0.zip\n`);
  assert.deepEqual(parseChecksumLine(checksumLine(sha256, "jianmu-0.1.0.zip")), { sha256, fileName: "jianmu-0.1.0.zip" });
  assert.throws(() => checksumLine("A".repeat(64), "a.zip"), /SHA-256/);
  assert.throws(() => checksumLine(sha256, "dist/a.zip"), /路径/);
  assert.throws(() => parseChecksumLine(`${sha256} a.zip\n`), /格式/);
});

const work = mkdtempSync(join(tmpdir(), "jianmu-package-test-"));
after(() => rmSync(work, { recursive: true, force: true }));

/** 一个小目录：两个文件，一个在子目录里，权限和时间由参数定。 */
function makeTree(name: string, mtime: number, mode: number): string {
  const dir = join(work, name);
  mkdirSync(join(dir, "pages"), { recursive: true });
  for (const [file, text] of [["manifest.json", "{}\n"], ["pages/a.js", "console.log(1);\n".repeat(50)]] as const) {
    writeFileSync(join(dir, file), text, { mode });
    utimesSync(join(dir, file), mtime, mtime);
  }
  return dir;
}

test("打包前每个文件的权限设成 644、修改时间设成同一个时刻", () => {
  const dir = makeTree("normalize", 1700000123, 0o755);
  normalizeEntries(dir, ["manifest.json", "pages/a.js"], 1700000000);
  for (const file of ["manifest.json", "pages/a.js"]) {
    const stat = statSync(join(dir, file));
    assert.equal(stat.mode & 0o777, 0o644, file);
    assert.equal(stat.mtimeMs, 1700000000 * 1000, file);
  }
});

const hasZip = (() => {
  try {
    execFileSync("zip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("同样的内容、不同的原始时间和权限，打出的 zip 逐字节相同", { skip: hasZip ? false : "本机没有 zip" }, () => {
  const files = ["pages/a.js", "manifest.json"];
  const pack = (name: string, mtime: number, mode: number, normalize: boolean, order = files): Buffer => {
    const dir = makeTree(name, mtime, mode);
    if (normalize) normalizeEntries(dir, files, 1700000000);
    const output = join(work, `${name}.zip`);
    const sha256 = writeZip({ dir, files: order, output });
    assert.equal(readFileSync(`${output}.sha256`, "utf8"), checksumLine(sha256, `${name}.zip`));
    return readFileSync(output);
  };
  assert.deepEqual(pack("one", 1600000000, 0o600, true), pack("two", 1600007777, 0o755, true, [...files].reverse()));
  // 不固定时间就不一样：说明上面那条比的确实是时间被固定以后的结果。
  assert.notDeepEqual(pack("three", 1600000000, 0o644, false), pack("four", 1600007777, 0o644, false));
  const listing = execFileSync("unzip", ["-Z1", join(work, "one.zip")], { encoding: "utf8" });
  assert.equal(listing, "manifest.json\npages/a.js\n", "按字节序写入，不带目录项");
});
