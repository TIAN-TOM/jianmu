// 用真实的设置读写算出存储里该有的样子：选好服务商、填好密钥、同意数据说明、确认启用。脚本里不手写键名和形状。
import { createSettingsStore } from "../src/platform/settings-store.ts";

/** @param {{ presetId: string, key: string, model: string }} service */
export async function storedSettings(service) {
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
  await store.save({ presetId: service.presetId, aiApiKey: service.key, aiModel: service.model }, "");
  await store.setDataConsent(true);
  await store.confirmActivation();
  return { local, session };
}
