// 报错要到设置页去改时（密钥不对、没设置好、模型找不到这类，码表在 core/errors/settings-codes.ts），
// 说明下面跟一个「打开设置」，直接滚到 AI 服务那一节，不让用户自己回顶上找设置图标。
import type { ErrorCode } from "../../core/errors.ts";
import { fixedInSettings } from "../../core/errors/settings-codes.ts";
import { cardPanelText } from "../shared/card-panel-text.ts";
import { Button } from "../shared/ui/button.tsx";
import type { Panel } from "./panel.ts";

export function SettingsExit({ panel, code }: { readonly panel: Panel; readonly code: ErrorCode | null | undefined }) {
  if (!fixedInSettings(code)) return null;
  return (
    <span class="settings-exit">
      <Button onClick={() => panel.openSettingsAt("ai-service")}>{cardPanelText().openSettings}</Button>
    </span>
  );
}
