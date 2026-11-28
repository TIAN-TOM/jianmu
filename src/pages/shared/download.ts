// 把页面里拼好的内容存成文件交给浏览器下载，不需要下载权限。

/** parts 按顺序拼成文件内容，type 是完整的 MIME 类型（要字符集就写在里面）。 */
export function downloadFile(fileName: string, parts: readonly string[], type: string): void {
  const url = URL.createObjectURL(new Blob([...parts], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  // 浏览器拿到地址就开始下载，稍后再收回。
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
