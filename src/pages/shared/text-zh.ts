// 几个页面共用的界面文案（ui/ 下的共用组件、配置检查的说法），简体这份。它定下文案表的形状（SharedText），
// 英文那份（text-en.ts）和繁体那份（text-hant.ts）必须满足同一个类型。模块顶层只放字面量和函数。带变量的文案写成函数。
import type { ActivationKind } from "../../core/consent.ts";
import type { Basis } from "../../core/notes/records.ts";

export const SHARED_ZH = {
  close: "关闭",
  back: "返回",
  serviceSaid: "服务的原话",
  jumpTo: (time: string) => `跳到 ${time}`,

  modes: { label: "模式", skim: "速览", study: "精读" },

  chapters: {
    label: "章节",
    key: "重点",
    heading: (count: number, keyCount: number) => (keyCount > 0 ? `章节 ${count}，重点 ${keyCount}` : `章节 ${count}`),
  },

  verdict: {
    label: "一句话结论",
    stale: "基于旧字幕",
    incomplete: "不完整",
    basis: {
      transcript: "依据字幕",
      "official-summary": "依据 B 站官方总结，没有通读字幕",
      "title-description": "依据标题和简介",
      "legacy-unknown": "依据未知（旧版）",
    } satisfies Readonly<Record<Basis["source"], string>>,
  },

  activation: {
    sections: { read: "会读取什么", purpose: "用来做什么", store: "本机存什么" } satisfies Readonly<Record<ActivationKind, string>>,
    title: "先看看简幕会读什么",
    titleUpdated: "简幕要多读一样东西",
    confirm: "启用简幕",
    confirmUpdated: "继续使用简幕",
    saving: "正在启用",
    footnote: "启用只在本机读取和处理。发给模型服务要另外在设置页同意。",
    showFull: "查看完整说明",
  },

  stale: {
    title: "简幕需要重新加载",
    impact: "简幕的文件更新了，后台还在跑旧版本，这个页面先用不了。重新加载后笔记和概览都在；没选「在这台电脑上记住密钥」的话，要再填一次密钥。",
    reload: "重新加载简幕",
    note: "开着的简幕页面会关掉，再打开就好",
  },

  // 没设置好 AI 服务时的说法：缺密钥、缺数据同意，其余按从没配过说。
  setup: {
    notice: {
      key: "API 密钥随浏览器重启或扩展更新清空了，要在设置页重新填；勾选「在这台电脑上记住密钥」就不用每次填",
      consent: "字幕不用设置就能看；概览和问答要先在设置页勾选数据说明",
      none: "字幕不用设置就能看；概览和问答要先设置 AI 服务",
    },
    reason: {
      key: "先在设置页重新填 API 密钥",
      consent: "先在设置页勾选数据说明",
      none: "先在设置页设置 AI 服务",
    },
    card: {
      key: "API 密钥随浏览器重启或扩展更新清空了，生成概览要先到设置页重新填；勾选「在这台电脑上记住密钥」就不用每次填。",
      consent: "生成概览要先到设置页勾选数据说明。",
      none: "还没设置 AI 服务，生成概览要先填服务商和密钥。",
    },
  },
};

export type SharedText = typeof SHARED_ZH;
