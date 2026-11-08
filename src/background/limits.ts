// 后台的限频和一次性令牌。计数和令牌都只在内存里，后台被回收后从零算起。

export interface RateLimitDeps {
  readonly limit: number;
  readonly windowMs: number;
  readonly now: () => number;
}

/** 滑动窗口：窗口里放行过 limit 次就不再放行，放行一次记一次。 */
export function createRateLimit({ limit, windowMs, now }: RateLimitDeps): () => boolean {
  const granted: number[] = [];
  return () => {
    const current = now();
    while (granted.length > 0 && current - (granted[0] ?? 0) >= windowMs) granted.shift();
    if (granted.length >= limit) return false;
    granted.push(current);
    return true;
  };
}

// 卡片发起的概览每分钟最多 3 次。正常用的人在卡片上点一次「生成概览」要等几十秒到几分钟，
// 一分钟里连开三个视频已经很多；卡片被劫持时用户每点一下视频就是一个新视频的概览，这里把它压住。
export const CARD_GENERATE_LIMIT = 3;
export const CARD_GENERATE_WINDOW_MS = 60_000;

export interface CardLimits {
  /** 卡片要新起一个生成：额度够就记一次、放行。接上已经在跑的不问这里。 */
  readonly admitGenerate: () => boolean;
  /** 卡片登记成功的任务换一个令牌，卡片凭它开始生成。 */
  readonly issueToken: (taskId: string) => string;
  /** 凭令牌换回登记的任务号，用一次就作废；过期、认不出的回 null。不登记直接生成，就绕过了开关和限频。 */
  readonly redeemToken: (token: string) => string | null;
}

export interface CardLimitsDeps {
  readonly now: () => number;
  readonly newToken: () => string;
  /** 令牌多久作废：过了这个时间，没人认领的任务也已经收掉了。 */
  readonly tokenTtlMs: number;
}

export function createCardLimits({ now, newToken, tokenTtlMs }: CardLimitsDeps): CardLimits {
  const admitGenerate = createRateLimit({ limit: CARD_GENERATE_LIMIT, windowMs: CARD_GENERATE_WINDOW_MS, now });
  const tokens = new Map<string, { readonly taskId: string; readonly issuedAt: number }>();
  const prune = (current: number): void => {
    for (const [token, entry] of tokens) if (current - entry.issuedAt > tokenTtlMs) tokens.delete(token);
  };
  return {
    admitGenerate,
    issueToken(taskId) {
      prune(now());
      const token = newToken();
      tokens.set(token, { taskId, issuedAt: now() });
      return token;
    },
    redeemToken(token) {
      prune(now());
      const entry = tokens.get(token);
      if (!entry) return null;
      tokens.delete(token);
      return entry.taskId;
    },
  };
}

// 内容脚本每累计播放 10 秒报一次进度，真实经过的时间只会更长，所以一个标签页 10 秒里最多收一条。
// 收不下的那条不会丢进度：累计秒数是总数，下一条照样带上。
export const MILESTONE_INTERVAL_MS = 10_000;

export interface PlaybackLimits {
  /** 这个标签页这会儿能不能再报一条进度：能就记一次。 */
  readonly admitMilestone: (tabId: number) => boolean;
  /** 标签页关了，不再记它。 */
  readonly forget: (tabId: number) => void;
}

export function createPlaybackLimits({ now }: { readonly now: () => number }): PlaybackLimits {
  const perTab = new Map<number, () => boolean>();
  return {
    admitMilestone(tabId) {
      let admit = perTab.get(tabId);
      if (!admit) {
        admit = createRateLimit({ limit: 1, windowMs: MILESTONE_INTERVAL_MS, now });
        perTab.set(tabId, admit);
      }
      return admit();
    },
    forget(tabId) {
      perTab.delete(tabId);
    },
  };
}
