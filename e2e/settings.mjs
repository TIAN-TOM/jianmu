// 用真实的设置读写算出存储里该有的样子：选好服务商、填好密钥、同意数据说明、确认启用，要的话再打开「打开就出结论」。脚本里不手写键名和形状。
import { createSettingsStore } from "../src/platform/settings-store.ts";

/**
 * @param {{ presetId: string, key: string, model: string, fields?: Record<string, unknown> }} service fields 是另外要存的设置项，比如自定义服务的协议和地址
 * @param {{ minutes: number }} [auto] 给了就再打开「打开就出结论」，门槛按它
 */
export async function storedSettings(service, auto) {
  const area = (data) => ({
    async get(keys) {
      return Object.fromEntries((typeof keys === "string" ? [keys] : keys).filter((key) => key in data).map((key) => [key, structuredClone(data[key])]));
    },
    async set(entries) {
      Object.assign(data, structuredClone(entries));
    },
    async remove(keys) {
      for (const key of typeof keys === "string" ? [keys] : keys) delete data[key];
    },
  });
  const local = {};
  const session = {};
  const locks = { exclusive: (_name, work) => Promise.resolve().then(work), shared: (_name, work) => Promise.resolve().then(work) };
  const store = createSettingsStore({ storage: { local: area(local), session: area(session) }, locks });
  // 语言写明中文：默认跟随浏览器，无头 Chrome 的界面语言多半是英文，测试照中文的内容核对。
  await store.save({ presetId: service.presetId, aiApiKey: service.key, aiModel: service.model, language: "zh", ...service.fields }, "");
  await store.setDataConsent(true);
  await store.confirmActivation();
  if (auto) await store.update({ autoOverview: true, autoOverviewMinutes: auto.minutes });
  return { local, session };
}
