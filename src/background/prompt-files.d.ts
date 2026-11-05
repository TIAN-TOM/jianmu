// `prompt:<文件名>` 由构建按文本内联，默认导出是模板全文。
declare module "prompt:*" {
  const text: string;
  export default text;
}
