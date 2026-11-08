// 菜单弹出的位置：贴着按钮下方、右边对齐，下面放不下而上面更宽就翻到上面，左右不出视口。
// 清单最低支持的 Chrome 还没有锚点定位，位置由脚本算。

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export const MENU_GAP = 4;
export const VIEWPORT_MARGIN = 8;

export function menuPlacement(trigger: Box, menu: Size, viewport: Size): { readonly left: number; readonly top: number } {
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - VIEWPORT_MARGIN - menu.width);
  const left = Math.min(maxLeft, Math.max(VIEWPORT_MARGIN, trigger.right - menu.width));
  const below = viewport.height - VIEWPORT_MARGIN - (trigger.bottom + MENU_GAP);
  const above = trigger.top - MENU_GAP - VIEWPORT_MARGIN;
  const flip = menu.height > below && above > below;
  const wanted = flip ? trigger.top - MENU_GAP - menu.height : trigger.bottom + MENU_GAP;
  const maxTop = Math.max(VIEWPORT_MARGIN, viewport.height - VIEWPORT_MARGIN - menu.height);
  return { left, top: Math.min(maxTop, Math.max(VIEWPORT_MARGIN, wanted)) };
}
