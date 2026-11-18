# 简幕隐私政策 · Jianmu Privacy Policy

> **草稿**：这份政策写于首发之前，按只支持哔哩哔哩（下称 B 站）的首发版来写。和首发时的实际行为对不上的地方，以实际行为为准，首发前会再核对一遍。
>
> **Draft**: this policy was written before the first release and describes the first version, which supports Bilibili only. Where it differs from how the released version actually behaves, the actual behaviour applies. It will be checked again before release.

[中文](#中文) · [English](#english)

## 中文

### 概要

- 简幕是一个 Chrome 扩展。没有开发者服务器，不要账号，不放广告，不做统计。开发者收不到你的任何内容。
- 简幕存的资料都在你这台电脑的浏览器里。
- 只有在你同意数据说明以后，简幕才会把内容发给模型服务，而且只发给你在设置页自己选的那一家。
- 现在还不支持 YouTube。以后加上时会更新这份政策。

### 数据从哪来

- **B 站**：你正在看的视频页，以及简幕替你向 B 站读取的视频信息、字幕、官方总结和稍后再看列表。视频没有字幕轨，或者字幕列表、字幕文件读不成时，简幕会用官方总结里附带的 AI 字幕，并在界面上标明来源。每次向 B 站读取新内容之前都先确认你已登录，没登录时不向 B 站读。本机已经存着的内容和你导入的字幕，不登录也照常显示；播放页上的播放状态（播放、暂停、时长）由页面自己提供，不论是否登录都会读。付费和充电专属的内容不读，确认不了是不是付费内容时也不读。不下载音频和视频。
- **你自己**：你输入的问题、选中的文字、记的笔记，导入的字幕文件和备份文件，填的 API 密钥和各项设置。
- **模型服务**：服务商返回的概览、结论、译文、回答和解释。

### 在本机读取什么

装好以后，简幕先不读任何视频数据。第一次打开侧边栏或设置页时，它会列出要读什么，你点「启用简幕」以后才开始。启用以后会读：

- 视频信息：标题、UP 主、时长、简介。
- 字幕。
- B 站官方总结和 UP 主分段。
- 观看状态：播放、暂停、累计播放时长。
- B 站登录状态：只看是否已登录，见下一节。
- 用「本窗口全部生成」时，当前窗口里已授权网站的标签页的地址和标题。
- 打开「打开就出结论」以后，当前窗口前台标签页的地址，用来认出刚打开的 B 站视频。
- 在粗筛页点读取时，你的 B 站稍后再看列表，以及每个视频看到了哪里。

这些内容用来在侧边栏和播放页卡片里显示，按时长、频道和播放情况选速览或精读，以及作为之后生成概览和回答问题的材料。

启用只管在本机读取和处理。发给模型服务要另外同意，见「什么时候发给模型服务」。

### Cookie 和登录状态

这是两件事，分开说：

- **简幕不读 Cookie 内容。** 简幕没有申请读取 Cookie 的权限，不读取、不保存，也不发送你的 B 站 Cookie 值。判断你是否已登录，看的是 B 站返回的登录状态，不是 Cookie 本身。
- **浏览器会随请求带上你的登录状态。** 简幕向 B 站读视频信息、字幕列表、官方总结和稍后再看时，浏览器会像你自己打开 B 站页面一样，在请求里带上你的 B 站登录 Cookie。这些请求只发往 B 站自己的域名。下载字幕文件时不带。

### 什么时候发给模型服务

前提是你先读数据说明并同意：在设置页「AI 服务」一节勾选，或者在「打开就出结论」一节点「同意并打开」。没同意时，简幕不发任何 AI 请求，拉取模型列表和测试连接也不发。取消勾选马上生效：还没发出的请求不再发，已经发出的那一次照常等它回来。

**会发送的内容**，只发当前功能用得到的：

- 字幕文本，包括你导入的字幕文件里的文字，和官方总结里附带的 AI 字幕
- 你选中的文字
- 你的问题
- 视频标题和时长
- UP 主名和简介
- 「用官方总结写结论」和粗筛写结论时用到的 B 站官方总结
- 写一句话结论时，这次已经生成的章节标题、摘要和金句
- 你的 API 密钥：每个请求都带着，服务商靠它认出是你的账户

**用来做什么**：翻译、整理字幕（补标点、改明显的同音错字）、概览、一句话结论、划词解释、笔记润色、问答，以及粗筛时写一句话结论。

**什么时候发**：

- 平时只在你操作时发，比如点「生成概览」、提问、点「解释」、点「整理字幕」，或者记笔记（笔记存下以后，会请模型润色那一刻的字幕）。
- 「本窗口全部生成」和粗筛，你先确认数量，之后逐个发送。
- 打开「打开就出结论」以后：在 B 站打开超过设定时长的视频，简幕会自动发送这个视频的字幕、标题和时长、UP 主名和简介，生成概览和一句话结论。这个开关新安装时是关的，打开前要先同意数据说明；设定时长默认 10 分钟，可以在 0 到 180 分钟之间调。后台打开的标签页，第一次切到前台才算打开。已有概览的视频不再生成，同一个视频在一次浏览器会话里只自动试一次。外文字幕不自动翻译。服务商说额度用完或密钥不对时，自动生成会停下，等你手动生成成功一次，或者重新开一下开关，才恢复。

**不会发送的**：B 站的 Cookie 和其他登录凭证，平台返回的字幕文件地址。

### 接收方

- 内容只发到你在设置页选的服务商地址。可以选下面的预设，也可以选「自定义」自己填地址，包括你自己电脑上跑的模型服务。地址只认 https，本机地址（localhost、127.0.0.1）可以用 http：这样的请求不出你的电脑。
- 开发者没有服务器，收不到这些内容，也不经手。
- 带密钥的请求遇到跳转不会跟过去，免得密钥被转到别的地址。
- 服务商怎么保存、使用这些内容，比如会不会拿去训练模型、存多久，以它的隐私政策、服务条款和你账户里的设置为准。有的服务商在隐私政策里写明，通过 API 发来的内容另按 API 或商业服务条款处理，用之前值得一起看看。
- 用「自定义」地址时，请自己去看那家服务的隐私政策。

预设服务商的隐私政策：

- Anthropic Claude：<https://www.anthropic.com/legal/privacy>
- OpenAI：<https://openai.com/policies/row-privacy-policy/>
- DeepSeek：<https://cdn.deepseek.com/policies/zh-CN/deepseek-privacy-policy.html>
- Google Gemini：<https://policies.google.com/privacy>
- 月之暗面 Kimi：<https://platform.kimi.com/docs/agreement/userprivacy>
- 智谱 GLM：<https://docs.bigmodel.cn/cn/terms/privacy-policy>
- 阿里云百炼（通义千问）：<https://terms.aliyun.com/legal-agreement/terms/suit_bu1_ali_cloud/suit_bu1_ali_cloud202107091605_49213.html>
- 硅基流动 SiliconFlow：<https://docs.siliconflow.cn/cn/legals/privacy-policy>
- OpenRouter：<https://openrouter.ai/privacy>。OpenRouter 会把请求转给它背后的模型服务商，那些服务商的政策也适用。

### 本机存什么、存多久

所有资料都存在这台电脑上、这个 Chrome 个人资料的扩展存储里，不随浏览器账号同步。简幕不另外加密这些资料。每一项的名称见文末的「存储明细」。

- **长期保存，直到你删掉**：概览和一句话结论、问答、笔记、译文、导入的字幕、按频道记住的模式、设置。
- **缓存**：字幕、视频信息、B 站官方总结和 UP 主分段最多留 60 个视频，超过 30 天或超出条数的，在下次存新内容时删掉。粗筛读到的稍后再看列表和官方总结、各个模型能做什么（比如能不能看图），过了有效期就不再使用，但要等重新读取或你清除缓存时才从存储里删掉。字幕文件的地址不存。
- **只留到浏览器关闭**：正在看的视频用哪个模式、播放了多久，「打开就出结论」试过哪些视频，以及默认方式下的 API 密钥（见「API 密钥」一节）。B 站限流以后要等多久，也只留到浏览器关闭。

### 删除和备份

- **清除缓存**（设置页）：删掉上面说的缓存。概览、问答、笔记、译文、导入的字幕、设置和密钥都留着。
- **清除全部数据**（设置页）：删掉简幕在这台电脑上存的全部资料，包括笔记、概览、问答、译文、导入的字幕、设置、密钥、数据同意和启用确认。删了不能恢复，之后要重新启用、重新同意。只留下一样：B 站限流以后要等多久。留着它是为了清除以后不马上又去请求，它不含你的内容，浏览器关闭后就没了。
- **一条一条删**：笔记和问答可以在侧边栏里单独删。
- **卸载扩展**：Chrome 会删掉扩展存在这台电脑上的数据。
- 这里说的删除，是指简幕和浏览器都读不到了。浏览器的存储文件里可能还留着旧内容，简幕没法保证它从磁盘上消失。
- **导出备份**（设置页）：备份文件里有笔记、概览和问答，没有 API 密钥、设置、缓存、导入的字幕、译文和按频道记住的模式。文件由浏览器下载到你的电脑上，由你自己保管。里面有你的笔记和问答，分享前留意。恢复备份只在本机合并。

### 权限

| 权限 | 用来做什么 |
| --- | --- |
| `sidePanel` | 显示侧边栏 |
| `storage` | 在本机保存资料和设置 |
| `scripting` | 装好、更新或启用以后，给已经打开的 B 站视频页补上简幕的页面脚本，不用刷新 |
| 访问 B 站的网页、接口和存放字幕文件的域名 | 在 B 站视频页放播放页卡片和笔记按钮，读播放状态；读视频信息、字幕、官方总结和稍后再看 |
| 可选：访问你选的 AI 服务地址 | 点「保存并授权」时，浏览器会问你是否允许简幕访问那个域名。清单里把它声明成可选的 https 地址，加上本机的 `http://localhost` 和 `http://127.0.0.1`，实际只申请你选的那一个地址 |

简幕不申请 `tabs`、`activeTab`、`cookies`、`downloads`、`debugger`、`tabCapture`、`desktopCapture`，也不申请访问所有网站和麦克风。没有 `tabs` 权限，简幕只看得到已授权网站的标签页的地址和标题。

### API 密钥

- 默认只存在本次浏览器会话里，不写入磁盘。重启浏览器，或者扩展停用、重新加载、更新以后，要重新填。
- 在设置页勾选「在这台电脑上记住密钥」并保存以后，密钥会存进这台电脑的扩展存储，重启浏览器后还能用。**这份本机副本没有加密。** 能读这台电脑浏览器数据的程序或人，可能拿到它，共用电脑上别开。简幕会先把这份存储限制成只有扩展自己的页面和后台能读，限制不成就不记住。这项限制只挡住简幕放在网页里运行的页面脚本，不等于加密。
- 取消勾选、点「清除密钥」或「清除全部数据」，简幕会删掉本机那份。但删掉以后，浏览器的存储文件里**仍可能残留旧密钥的明文**。卸载扩展时 Chrome 会删掉扩展的数据，这也不是安全擦除，系统备份里的副本也不受影响。担心泄露的话，请到服务商后台撤销这把密钥。
- 换服务商，或者把地址换到别的域名并保存，原来的密钥会被移除，记住的选项也会关掉。
- 不管哪种方式，密钥都不进网页、页面脚本、日志、报错和备份，不随浏览器同步，只随请求发到它绑定的服务商地址。

### 简幕不做的事

- 没有统计、崩溃上报和广告，不加载远程代码。
- 不在 B 站上替你改任何东西：不点赞、不评论、不改稍后再看列表。
- 不出售、不分享你的资料。开发者手里本来就没有。

### 这份政策的变更

改动记录留在本仓库的提交历史里。发给模型服务的内容、用途、接收方或发送方式，超出你原来同意的范围时，简幕会在界面里列出新增的部分，等你重新同意以后才继续发送。读取的内容有实质变化时，也会请你重新确认启用。

### 联系方式

- 问题和建议：到本仓库的 [Issues](https://github.com/TIAN-TOM/jianmu/issues) 页面提。issue 是公开的，别在里面贴 API 密钥、Cookie 或其他个人信息。
- 邮箱：**［待填］** <!-- 待定：联系邮箱由开发者本人定 -->
- 安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。

### 存储明细

IndexedDB 数据库 `jianmu` 里的仓库：

| 名称 | 存什么 | 清除缓存 | 清除全部数据 | 进备份 |
| --- | --- | --- | --- | --- |
| `notes` | 笔记 | 留 | 删 | 是 |
| `overviews` | 概览和一句话结论 | 留 | 删 | 是 |
| `qa` | 问答 | 留 | 删 | 是 |
| `translations` | 译文和整理后的字幕 | 留 | 删 | 否 |
| `imports` | 导入的字幕 | 留 | 删 | 否 |
| `channels` | 按频道记住的模式 | 留 | 删 | 否 |
| `cache` | 字幕、视频信息、官方总结和 UP 主分段的缓存 | 删 | 删 | 否 |

扩展存储里的键，都不进备份。「本机」写在磁盘上；「会话」只在内存里，浏览器关闭，或者扩展停用、重新加载、更新时清空：

| 名称 | 存什么 | 在哪 | 清除缓存 | 清除全部数据 |
| --- | --- | --- | --- | --- |
| `jianmu_settings` | 设置，不含密钥；包括启用确认和数据同意 | 本机 | 留 | 删 |
| `jianmu_api_key` | 默认方式下的 API 密钥 | 会话 | 留 | 删 |
| `jianmu_api_key_local` | 选了记住时的 API 密钥，没有加密 | 本机 | 留 | 删 |
| `jianmu_triage` | 粗筛读到的稍后再看列表和官方总结 | 本机 | 删 | 删 |
| `jianmu_model_caps` | 各个模型能做什么 | 本机 | 删 | 删 |
| `jianmu_relaxed_params` | 模型服务不接受某些请求参数时的记录 | 会话 | 删 | 删 |
| `jianmu_image_probe` | 画面分析的模型能不能看图（只有带「解释当前画面」的版本会写） | 本机 | 删 | 删 |
| `jianmu_frame_results` | 最近几次画面解释的文字，没有截图（只有带「解释当前画面」的版本会写） | 会话 | 删 | 删 |
| `jianmu_watch_sessions` | 每个标签页正在看的视频用哪个模式、播放了多久、卡片展开没有 | 会话 | 留 | 删 |
| `jianmu_auto_ledger` | 「打开就出结论」试过哪些视频、最近几次的时间、暂停的原因 | 会话 | 留 | 删 |
| `jianmu_settings_revision` | 设置的修订号，是个随机值，防止过时的设置页写回旧设置 | 本机 | 留 | 换成新值 |
| `jianmu_appearance` | 外观设置的副本，页面打开时先用它，免得闪一下 | 页面的本地存储 | 留 | 恢复默认 |
| `jianmu_site_backoff` | B 站限流以后要等多久，只有站点、到期时间和次数 | 会话 | 留 | 留 |

### 解释当前画面（还在验证，发布版里没有）

这项功能还在开发者本人的日常使用里验证，目前发布的安装包里没有它。发布版打开它的时候，下面这些会并进上面各节：

- **读什么**：你点播放器上「解释当前画面」的图标，或者侧边栏里的按钮时，读视频当前的一帧画面。只截视频本身，不截整个网页。加密播放（比如番剧、电影）、付费或确认不了是不是付费的视频、正在播广告、视频页不在前台时不截。
- **发什么**：这一帧画面、这一刻前后几句字幕和视频标题，发给你在设置页「按功能选模型」里给画面分析选的模型。和别的功能一样，要先同意数据说明。
- **存什么**：截下的画面只用于这一次请求，不存进任何地方，也不进备份。模型回的解释只有文字，记在扩展的会话存储 `jianmu_frame_results` 里（只在内存，不写磁盘），最多半小时，浏览器关闭、清除缓存或清除全部数据时删掉。
- **能不能看图**：简幕要知道画面分析的模型能不能看图。认不出这个模型时，会发一张 64×64 的红色小图问它是什么颜色（不是视频画面），答得出才算能看，把结果记在 `jianmu_image_probe` 里，清除缓存时删掉。

### 待定

首发前要处理的：

- 换了 AI 服务地址以后，回收旧地址的访问授权：修好并在真实浏览器里验证以后再写进来，同时写明哪些情况下授权可能还留着。<!-- 待定：回收旧授权，实机验证后再写 -->
- 「解释当前画面」在发布版里打开时，把上面那一节并进正文。<!-- 待定：解释当前画面 -->
- 联系邮箱。
- 拿最终的安装包把各节和预设服务商的隐私政策链接再核对一遍。<!-- 待定：按最终安装包核对 -->

YouTube 版加上以后，补上在 YouTube 上读什么、发什么。

## English

### Summary

- Jianmu (简幕) is a Chrome extension. There is no developer server, no account, no ads and no analytics. The developer never receives any of your content.
- Everything Jianmu keeps is stored in the browser on your computer.
- Jianmu only sends content to a model service after you agree to the data notice, and only to the service you chose yourself in Settings.
- YouTube is not supported yet. This policy will be updated when it is added.

### Where the data comes from

- **Bilibili**: the video page you are watching, plus the video details, subtitles, official summaries and Watch Later list that Jianmu reads from Bilibili for you. When a video has no subtitle track, or its subtitle list or subtitle file cannot be read, Jianmu uses the automatically generated subtitles that come with the official summary and labels where they came from. Before each new request to Bilibili it checks that you are signed in, and it requests nothing from Bilibili while you are signed out. Content already stored on this computer and subtitles you imported still show when you are signed out. Playback state on the video page (playing, paused, duration) comes from the page itself and is read whether or not you are signed in. It does not read paid or supporter-only content, or anything it cannot confirm is free. It never downloads audio or video.
- **You**: the questions you type, text you select, notes you take, subtitle files and backups you import, your API key and your settings.
- **The model service**: the overviews, verdicts, translations, answers and explanations the service sends back.

### What Jianmu reads on your computer

After installation, Jianmu reads no video data at all. The first time you open the side panel or Settings, it lists what it will read, and it starts only after you click 启用简幕 (Enable Jianmu). Once enabled, it reads:

- Video details: title, uploader, duration and description.
- Subtitles.
- Bilibili's official summary and the uploader's chapter markers.
- Playback state: playing, paused and total time played.
- Your Bilibili sign-in state: only whether you are signed in. See the next section.
- When you use 本窗口全部生成 (overviews for all videos in this window): the address and title of each tab in the current window that is on a site Jianmu is allowed to access.
- With 打开就出结论 (verdict on open) switched on: the address of the active tab in the current window, so Jianmu can recognise a Bilibili video you have just opened.
- When you click to read on the triage page: your Bilibili Watch Later list and how far you have watched each video.

This is used to show content in the side panel and in the card on the video page, to pick skim or close-reading mode from the video's length, the channel and how you are watching, and as material for overviews and answers later on.

Enabling Jianmu only covers reading and processing on your computer. Sending anything to a model service needs separate consent. See "When content is sent to a model service".

### Cookies and sign-in state

These are two separate things:

- **Jianmu does not read cookie contents.** It has no permission to read cookies, and it never reads, stores or sends your Bilibili cookie values. To tell whether you are signed in, it looks at the sign-in status Bilibili returns, not at the cookies themselves.
- **Your browser attaches your sign-in state to requests.** When Jianmu asks Bilibili for video details, subtitle lists, official summaries or your Watch Later list, the browser includes your Bilibili sign-in cookies in the request, the same as when you open a Bilibili page yourself. These requests only go to Bilibili's own domains. Subtitle file downloads go without them.

### When content is sent to a model service

First you need to read the data notice and agree, either by ticking the box in the AI 服务 (AI service) section of Settings or by clicking 同意并打开 (agree and turn on) in the 打开就出结论 (conclusion on open) section. Until you do, Jianmu sends no AI requests at all, including fetching the model list and testing the connection. Unticking the box takes effect straight away: requests not yet sent are not sent, and a request already on its way is allowed to finish.

**What may be sent**, limited to what the current feature needs:

- Subtitle text, including text from subtitle files you imported and the subtitles that come with the official summary
- Text you selected
- Your questions
- Video title and duration
- Uploader name and video description
- Bilibili's official summary, used by 用官方总结写结论 (verdict from the official summary) and when triage writes verdicts
- When writing the one-line verdict, the chapter titles, summaries and key quotes already generated for that video
- Your API key, which goes with every request so the service knows it is your account

**What it is used for**: translation, tidying subtitles (adding punctuation and fixing obvious sound-alike mistakes), overviews, one-line verdicts, explaining selected text, tidying up notes, answering questions, and writing one-line verdicts during triage.

**When it is sent**:

- Normally only when you do something, such as clicking 生成概览 (generate overview), asking a question, clicking 解释 (explain), clicking 整理字幕 (tidy subtitles), or taking a note (once a note is saved, the model is asked to tidy up the subtitle line from that moment).
- For 本窗口全部生成 and triage, you confirm how many videos first, and they are then sent one at a time.
- With 打开就出结论 switched on: when you open a Bilibili video longer than the set length, Jianmu automatically sends that video's subtitles, title and duration, uploader name and description to generate an overview and a one-line verdict. The switch is off on a new install, and you have to agree to the data notice before turning it on. The set length is 10 minutes by default and can be anywhere from 0 to 180 minutes. A tab opened in the background counts as opened the first time you switch to it. Videos that already have an overview are skipped, and each video is tried automatically at most once per browser session. Foreign-language subtitles are not translated automatically. If the service says your quota has run out or your key is wrong, automatic generation pauses until you generate an overview by hand successfully or switch the setting off and on again.

**Never sent**: your Bilibili cookies or other sign-in credentials, and the subtitle file addresses the platform returns.

### Who receives it

- Content only goes to the service address you chose in Settings. You can pick one of the presets below, or choose 自定义 (custom) and enter an address yourself, including a model service running on your own computer. Only https addresses are accepted, except that local addresses (localhost and 127.0.0.1) may use http. Those requests never leave your computer.
- The developer has no server, so none of this reaches or passes through the developer.
- Requests that carry your key do not follow redirects, so the key cannot be passed on to another address.
- How the service stores and uses what it receives, for example whether it trains models on it and how long it keeps it, depends on its privacy policy, its terms and the settings in your account. Some services say in their privacy policy that content sent through the API falls under separate API or business terms instead, so those are worth reading too.
- If you use a custom address, please read that service's privacy policy yourself.

Privacy policies of the preset services:

- Anthropic Claude: <https://www.anthropic.com/legal/privacy>
- OpenAI: <https://openai.com/policies/row-privacy-policy/>
- DeepSeek: <https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html>
- Google Gemini: <https://policies.google.com/privacy>
- Moonshot Kimi (in Chinese): <https://platform.kimi.com/docs/agreement/userprivacy>
- Zhipu GLM (in Chinese): <https://docs.bigmodel.cn/cn/terms/privacy-policy>
- Alibaba Cloud Model Studio, Qwen (in Chinese): <https://terms.aliyun.com/legal-agreement/terms/suit_bu1_ali_cloud/suit_bu1_ali_cloud202107091605_49213.html>
- SiliconFlow (in Chinese): <https://docs.siliconflow.cn/cn/legals/privacy-policy>
- OpenRouter: <https://openrouter.ai/privacy>. OpenRouter passes requests on to the model providers behind it, and their policies apply as well.

### What is stored on your computer, and for how long

Everything is kept in the extension storage of this Chrome profile on this computer, and none of it is synced with your browser account. Jianmu does not add its own encryption to this data. The name of each item is listed under "Storage details" at the end.

- **Kept until you delete it**: overviews and one-line verdicts, Q&A, notes, translations, imported subtitles, the mode remembered for each channel, and settings.
- **Caches**: subtitles, video details, Bilibili official summaries and chapter markers are kept for up to 60 videos. Entries older than 30 days, or beyond that number, are deleted the next time something new is cached. The Watch Later list and official summaries read for triage, and what each model can do (for example whether it accepts images), stop being used once they expire, but stay in storage until they are read again or you clear the cache. Subtitle file addresses are not stored.
- **Kept only until the browser closes**: which mode each video you are watching uses and how long it has played, which videos 打开就出结论 has already tried, and your API key in the default setup (see "API key"). How long to wait after Bilibili rate-limits requests is also kept only until the browser closes.

### Deleting data and backups

- **Clear cache** (清除缓存, in Settings) deletes the caches above. Overviews, Q&A, notes, translations, imported subtitles, settings and the key stay.
- **Clear all data** (清除全部数据, in Settings) deletes everything Jianmu keeps on this computer, including notes, overviews, Q&A, translations, imported subtitles, settings, the key, your data consent and your confirmation to enable Jianmu. It cannot be undone, and you will need to enable Jianmu and agree again afterwards. Only one thing is left: how long to wait after Bilibili rate-limits requests. It is kept so Jianmu does not start requesting again straight after clearing. It holds none of your content and is gone once the browser closes.
- **One at a time**: notes and Q&A entries can be deleted individually in the side panel.
- **Uninstalling**: Chrome deletes the data the extension kept on this computer.
- Deleting here means neither Jianmu nor the browser can read the data any more. Old content may still be left in the browser's storage files, and Jianmu cannot guarantee it is gone from the disk.
- **Export backup** (导出备份, in Settings): the backup file holds your notes, overviews and Q&A. It leaves out the API key, settings, caches, imported subtitles, translations and per-channel modes. The browser downloads the file to your computer and it is yours to look after. It contains your notes and Q&A, so take care before sharing it. Restoring a backup only merges it into what is already on this computer.

### Permissions

| Permission | What it is for |
| --- | --- |
| `sidePanel` | Showing the side panel |
| `storage` | Keeping data and settings on your computer |
| `scripting` | After installing, updating or enabling, adding Jianmu's page script to Bilibili video pages that are already open, so you don't need to reload them |
| Access to Bilibili's web pages, its API and the domain where it keeps subtitle files | Placing the card and the note button on Bilibili video pages and reading playback state; reading video details, subtitles, official summaries and Watch Later |
| Optional: access to the AI service address you chose | When you click 保存并授权 (save and authorise), the browser asks whether Jianmu may access that domain. The manifest declares this as an optional range of https addresses, plus `http://localhost` and `http://127.0.0.1` on your own computer, but Jianmu only ever requests the one address you chose |

Jianmu does not request `tabs`, `activeTab`, `cookies`, `downloads`, `debugger`, `tabCapture` or `desktopCapture`, and does not request access to all websites or to the microphone. Without the `tabs` permission it can only see the addresses and titles of tabs on sites it has permission for.

### API key

- By default the key lives only in the current browser session and never goes to disk. Restarting the browser, or turning off, reloading or updating the extension, clears it, and you have to enter it again.
- If you tick 在这台电脑上记住密钥 (remember the key on this computer) in Settings and save, the key is written to the extension's storage on this computer and still works after a browser restart. **This copy is not encrypted.** Programs or people that can read this computer's browser data may be able to get it, so don't turn this on on a shared computer. Jianmu first limits that storage so only its own pages and background can read it, and won't remember the key if the limit can't be set. The limit only keeps out the page scripts Jianmu runs inside websites. It is not encryption.
- Unticking the box, clicking 清除密钥 (clear key) or clicking Clear all data deletes the copy on this computer. Even after that, **the old key may still be left in plain text in the browser's storage files**. Chrome deletes the extension's data when you uninstall it, but that is not a secure wipe either, and copies in system backups are not affected. If you are worried about a leak, revoke the key in your provider's dashboard.
- If you switch to another provider, or change the address to a different domain and save, the old key is removed and the remember option is switched off.
- Either way, the key never goes into web pages, page scripts, logs, error messages or backups, is not synced by the browser, and is only sent with requests to the service address it is bound to.

### What Jianmu does not do

- No analytics, crash reporting or ads, and no remotely loaded code.
- It changes nothing on Bilibili for you: no likes, no comments, no edits to your Watch Later list.
- It does not sell or share your data. The developer doesn't have it in the first place.

### Changes to this policy

Changes are recorded in this repository's commit history. If what is sent to a model service, what it is used for, who receives it or how sending is triggered goes beyond what you agreed to, Jianmu lists the new parts in the extension and waits for you to agree again before sending any more. If what it reads changes materially, it asks you to confirm enabling Jianmu again.

### Contact

- Questions and suggestions: open an issue on this repository's [Issues](https://github.com/TIAN-TOM/jianmu/issues) page. Issues are public, so please don't post API keys, cookies or other personal information there.
- Email: **[to be added]** <!-- 待定：联系邮箱由开发者本人定 -->
- Please report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

### Storage details

Object stores in the IndexedDB database `jianmu`:

| Name | What it holds | Clear cache | Clear all data | In backups |
| --- | --- | --- | --- | --- |
| `notes` | Notes | Kept | Deleted | Yes |
| `overviews` | Overviews and one-line verdicts | Kept | Deleted | Yes |
| `qa` | Q&A | Kept | Deleted | Yes |
| `translations` | Translations and tidied subtitles | Kept | Deleted | No |
| `imports` | Imported subtitles | Kept | Deleted | No |
| `channels` | The mode remembered for each channel | Kept | Deleted | No |
| `cache` | Cached subtitles, video details, official summaries and chapter markers | Deleted | Deleted | No |

Keys in extension storage, none of which go into backups. "Local" is written to disk. "Session" is held in memory only and is cleared by closing the browser, or by turning off, reloading or updating the extension:

| Name | What it holds | Where | Clear cache | Clear all data |
| --- | --- | --- | --- | --- |
| `jianmu_settings` | Settings, without the key; includes your enable confirmation and data consent | Local | Kept | Deleted |
| `jianmu_api_key` | The API key in the default setup | Session | Kept | Deleted |
| `jianmu_api_key_local` | The API key when you chose to remember it, not encrypted | Local | Kept | Deleted |
| `jianmu_triage` | The Watch Later list and official summaries read for triage | Local | Deleted | Deleted |
| `jianmu_model_caps` | What each model can do | Local | Deleted | Deleted |
| `jianmu_relaxed_params` | A note of request parameters a model service would not accept | Session | Deleted | Deleted |
| `jianmu_image_probe` | Whether the frame-analysis model accepts images (only versions with 解释当前画面 write it) | Local | Deleted | Deleted |
| `jianmu_frame_results` | The text of recent frame explanations, without the frames (only versions with 解释当前画面 write it) | Session | Deleted | Deleted |
| `jianmu_watch_sessions` | For each tab, the mode of the video being watched, how long it has played and whether the card is expanded | Session | Kept | Deleted |
| `jianmu_auto_ledger` | Which videos 打开就出结论 has tried, the times of recent attempts and why it is paused | Session | Kept | Deleted |
| `jianmu_settings_revision` | A random revision number for settings, so an out-of-date Settings page cannot write old settings back | Local | Kept | Replaced with a new value |
| `jianmu_appearance` | A copy of the appearance settings, used first when a page opens so it doesn't flicker | The page's local storage | Kept | Reset to default |
| `jianmu_site_backoff` | How long to wait after Bilibili rate-limits requests: only the site, an expiry time and a count | Session | Kept | Kept |

### Explain the current frame (still being tested, not in the published version)

This feature is still being tested in the developer's own daily use and is not in the published package. When the published version turns it on, the points below will move into the sections above:

- **What it reads**: when you click the 解释当前画面 icon on the player, or the button in the side panel, it reads the current frame of the video. It captures only the video itself, never the whole page. It does not capture encrypted playback (anime series and films, for example), paid videos or videos whose payment status cannot be confirmed, ads, or a video page that is not in the foreground.
- **What it sends**: that frame, a few subtitle lines either side of that moment and the video title, sent to the model you chose for 画面分析 (frame analysis) under 按功能选模型 in Settings. As with every other feature, you need to agree to the data notice first.
- **What it keeps**: the captured frame is used for that one request only. It is not stored anywhere and never goes into backups. The model's explanation is text only and is kept in the extension's session storage, `jianmu_frame_results` (memory only, never written to disk), for at most half an hour. It is deleted when the browser closes or when you clear the cache or all data.
- **Whether the model accepts images**: Jianmu needs to know whether the frame-analysis model can read images. When it does not recognise the model, it sends one 64×64 red image (not a frame from the video) and asks what colour it is. Only a correct answer counts. The result is recorded in `jianmu_image_probe`, which clearing the cache deletes.

### Still to be settled

To be done before release:

- Revoking access to the old AI service address after you switch to a new one: this will be added once it is fixed and tested in a real browser, together with the cases where access may be kept. <!-- 待定：回收旧授权，实机验证后再写 -->
- When the published version turns on 解释当前画面 (explain the current frame), move the section above into the main text. <!-- 待定：解释当前画面 -->
- The contact email.
- Check every section, and the links to the preset services' privacy policies, against the final release package. <!-- 待定：按最终安装包核对 -->

When the YouTube version ships, this policy will add what Jianmu reads and sends on YouTube.
