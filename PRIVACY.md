# 简幕隐私政策 · Jianmu Privacy Policy

> **草稿**：这份政策写于首发之前，正文按哔哩哔哩（下称 B 站）来写，YouTube 单列在「YouTube」一节。和首发时的实际行为对不上的地方，以实际行为为准，首发前会再核对一遍。
>
> **Draft**: this policy was written before the first release. The main text covers Bilibili. YouTube has its own section below. Where it differs from how the released version actually behaves, the actual behaviour applies. It will be checked again before release.

[中文](#中文) · [English](#english)

## 中文

### 概要

- 简幕是一个 Chrome 扩展。没有开发者服务器，不要账号，不放广告，不做统计。开发者收不到你的任何内容。
- 简幕存的资料都在你这台电脑的浏览器里。
- 只有在你同意数据说明以后，简幕才会把内容发给模型服务，而且只发给你在设置页自己选的那一家。
- YouTube 上要你自己启用才运行，和 B 站不同的地方见「YouTube」一节。

### 数据从哪来

- **B 站**：你正在看的视频页，以及简幕替你向 B 站读取的视频信息、字幕、官方总结和稍后再看列表。视频没有字幕轨，或者字幕列表、字幕文件读不成时，简幕会用官方总结里附带的 AI 字幕，并在界面上标明来源。每次向 B 站读取字幕、官方总结和稍后再看之前都先确认你已登录；没登录时只读视频信息（标题、作者、时长这些公开信息），用来显示是哪个视频、决定用速读还是精读，别的都不读。本机已经存着的内容和你导入的字幕，不登录也照常显示；播放页上的播放状态（播放、暂停、时长）由页面自己提供，不论是否登录都会读。付费和充电专属的内容不读；确认不了是不是付费内容时照读，确认是付费的才不读。不下载音频和视频。
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
- 打开「打开就出结论」以后，已授权网站各标签页的地址，用来认出打开的视频，包括在后台打开、还没切过去看的。
- 在粗筛页点读取时，你的 B 站稍后再看列表，以及每个视频看到了哪里。
- 你点播放器上「解释当前画面」的图标，或者侧边栏里的按钮时，视频当前的一帧画面。只截视频本身，不截整个网页。加密播放（比如番剧、电影）、确认是付费的视频、正在播广告、视频页不在前台时不截。确认不了是不是付费的照截。

这些内容用来在侧边栏和播放页卡片里显示，按时长、频道和播放情况选速读或精读，以及作为之后生成概览和回答问题的材料。

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
- 点「解释当前画面」时视频当前的一帧画面，连同这一刻前后几句字幕和视频标题，发给你在设置页「按功能选模型」里给画面分析选的模型
- 你的 API 密钥：每个请求都带着，服务商靠它认出是你的账户

**用来做什么**：翻译、整理字幕（补标点、改明显的同音错字）、概览、一句话结论、划词解释、笔记润色、问答、粗筛时写一句话结论，以及解释当前画面。

**什么时候发**：

- 平时只在你操作时发，比如点「生成概览」、提问、点「解释」、点「整理字幕」、点「解释当前画面」，或者记笔记（笔记存下以后，会请模型润色那一刻的字幕）。翻译和整理字幕点了以后在后台分批发完，关掉侧边栏也继续，直到做完、你点停止，或者视频所在的标签页换了视频或关掉。
- 「本窗口全部生成」和粗筛，你先确认数量，之后逐个发送。
- 简幕要知道画面分析的模型能不能看图。认不出这个模型时，会发一张 64×64 的红色小图问它是什么颜色（不是视频画面），答得出才算能看。
- 打开「打开就出结论」以后：在 B 站打开超过设定时长的视频，简幕会自动发送这个视频的字幕、标题和时长、UP 主名和简介，生成概览和一句话结论。这个开关新安装时是关的，打开前要先同意数据说明；设定时长默认 10 分钟，可以在 0 到 180 分钟之间调。在后台打开、还没切过去看的标签页也算，打开开关时已经开着的也算；它们排队生成，正在看的那个先生成，同时最多生成两个，10 分钟最多 40 个。一次开的标签页越多，花的 API 额度越多。已有概览的视频不再生成，同一个视频在一次浏览器会话里只自动试一次。外文字幕不自动翻译。服务商说额度用完或密钥不对时，或者本机的服务拒绝了来自浏览器扩展的请求时，自动生成会停下，等你手动生成成功一次，或者重新开一下开关，才恢复。

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
- Ollama（本机）：请求发到你这台电脑上的 Ollama。按 Ollama 的说明，用本机的模型时内容留在这台电脑上；选了 Ollama 的云端模型时，内容会交给 Ollama 处理：<https://ollama.com/privacy>

### 本机存什么、存多久

所有资料都存在这台电脑上、这个 Chrome 个人资料的扩展存储里，不随浏览器账号同步。简幕不另外加密这些资料。每一项的名称见文末的「存储明细」。

- **长期保存，直到你删掉**：概览和一句话结论、问答、笔记、译文、导入的字幕、按频道记住的模式、设置。
- **缓存**：字幕、视频信息、B 站官方总结和 UP 主分段最多留 500 个视频，超过 90 天或超出条数的，在下次存新内容时删掉。粗筛读到的稍后再看列表和官方总结、各个模型能做什么（比如能不能看图）、画面分析的模型能不能看图的检测结果，过了有效期就不再使用，但要等重新读取或你清除缓存时才从存储里删掉。字幕文件的地址不存。
- **只留到浏览器关闭**：正在看的视频用哪个模式、播放了多久，「打开就出结论」试过哪些视频，最近几次画面解释的文字（超过半小时就不再显示，下次打开侧边栏或解释画面时删掉），每项功能最近一次模型请求用了多少 token，以及默认方式下的 API 密钥（见「API 密钥」一节）。B 站限流以后要等多久，也只留到浏览器关闭。
- **不存**：解释当前画面截下的画面只用于这一次请求，哪里都不存，也不进备份。

### 删除和备份

- **清除缓存**（设置页）：删掉上面说的缓存，以及各项功能最近一次请求的用量。概览、问答、笔记、译文、导入的字幕、设置和密钥都留着。
- **清除全部数据**（设置页）：删掉简幕在这台电脑上存的全部资料，包括笔记、概览、问答、译文、导入的字幕、设置、密钥、数据同意和启用确认。删了不能恢复，之后要重新启用、重新同意。只留下两样：B 站限流以后要等多久，和哪些窗口开着简幕的侧边栏（只有窗口编号）。前一样是为了清除以后不马上又去请求，后一样是为了还开着的侧边栏和播放页卡片对得上。它们都不含你的内容，浏览器关闭后就没了。
- **一条一条删**：笔记和问答可以在侧边栏里单独删。
- **卸载扩展**：Chrome 会删掉扩展存在这台电脑上的数据。
- 这里说的删除，是指简幕和浏览器都读不到了。浏览器的存储文件里可能还留着旧内容，简幕没法保证它从磁盘上消失。
- **导出备份**（设置页）：备份文件里有笔记、概览、问答，以及译文和整理后的字幕，没有 API 密钥、设置、缓存、导入的字幕和按频道记住的模式。文件由浏览器下载到你的电脑上，由你自己保管。里面有你的笔记和问答，分享前留意。恢复备份只在本机合并。

### 权限

| 权限 | 用来做什么 |
| --- | --- |
| `sidePanel` | 显示侧边栏 |
| `storage` | 在本机保存资料和设置 |
| `scripting` | 装好、更新或启用以后，给已经打开的 B 站视频页补上简幕的页面脚本，不用刷新 |
| `contextMenus` | 在工具栏图标的右键菜单里加简幕自己的几项 |
| 访问 B 站的网页、接口和存放字幕文件的域名 | 在 B 站视频页放播放页卡片、笔记按钮和「解释当前画面」的图标，读播放状态，点那个图标时读视频当前的一帧；读视频信息、字幕、官方总结和稍后再看 |
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

### Chrome 应用商店的用户数据政策

简幕对读到的内容的使用，遵守 [Chrome 应用商店的用户数据政策](https://developer.chrome.com/docs/webstore/program-policies/limited-use)，包括其中的「有限使用」（Limited Use）要求：

- 只用来提供这份政策里写的功能。
- 简幕只在你同意以后把它发给你自己选的模型服务，不发给别的接收方。
- 不用于广告，不出售。
- 开发者看不到你的内容：简幕没有开发者服务器，内容到不了开发者手里。模型服务那边怎么处理，以它的政策为准，见上面「接收方」一节。

### 这份政策的变更

改动记录留在本仓库的提交历史里。发给模型服务的内容、用途、接收方或发送方式，超出你原来同意的范围时，简幕会在界面里列出新增的部分，等你重新同意以后才继续发送。读取的内容有实质变化时，也会请你重新确认启用。

### 联系方式

- 问题和建议：到本仓库的 [Issues](https://github.com/TIAN-TOM/jianmu/issues) 页面提。issue 是公开的，别在里面贴 API 密钥、Cookie 或其他个人信息。
- 邮箱：<tiantom.dev@gmail.com>
- 安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。

### 存储明细

IndexedDB 数据库 `jianmu` 里的仓库：

| 名称 | 存什么 | 清除缓存 | 清除全部数据 | 进备份 |
| --- | --- | --- | --- | --- |
| `notes` | 笔记 | 留 | 删 | 是 |
| `overviews` | 概览和一句话结论 | 留 | 删 | 是 |
| `qa` | 问答 | 留 | 删 | 是 |
| `translations` | 译文和整理后的字幕 | 留 | 删 | 是 |
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
| `jianmu_usage` | 每项功能最近一次模型请求的用量：服务回报的输入、输出、思考和合计的 token 数，加上当时的模型名和推理档位，没有请求和回复的内容 | 会话 | 删 | 删 |
| `jianmu_image_probe` | 画面分析的模型能不能看图 | 本机 | 删 | 删 |
| `jianmu_frame_results` | 最近几次画面解释的文字，没有截图；超过半小时不再显示，下次用到时删掉 | 会话 | 删 | 删 |
| `jianmu_transcript_modes` | 最近 50 个手动选过字幕显示方式的视频编号和所选方式 | 会话 | 留 | 删 |
| `jianmu_watch_sessions` | 每个标签页正在看的视频用哪个模式、播放了多久、卡片展开没有 | 会话 | 留 | 删 |
| `jianmu_auto_ledger` | 「打开就出结论」试过哪些视频、最近几次的时间、暂停的原因 | 会话 | 留 | 删 |
| `jianmu_settings_revision` | 设置的修订号，是个随机值，防止过时的设置页写回旧设置 | 本机 | 留 | 换成新值 |
| `jianmu_appearance` | 外观设置的副本，页面打开时先用它，免得闪一下 | 页面的本地存储 | 留 | 恢复默认 |
| `jianmu_site_backoff` | B 站限流以后要等多久，只有站点、到期时间和次数 | 会话 | 留 | 留 |
| `jianmu_open_panels` | 哪些窗口开着简幕的侧边栏，只有窗口编号；同一窗口里的播放页卡片据此让位收起 | 会话 | 留 | 留 |
| `jianmu_self_reload` | 覆盖新版以后简幕自己重新加载过几次，只有新版的构建标识、次数和时间，防止文件没换全时来回重载 | 本机 | 留 | 删 |

### YouTube

上面各节按 B 站写，简幕在 YouTube 上不同的地方是这些：

- **怎么启用**：装好以后简幕不碰 YouTube。你在侧边栏或设置页点「在 YouTube 上启用」，浏览器会问你是否允许简幕访问 `www.youtube.com`，允许以后简幕才在 YouTube 的页面上运行。设置页可以停用，停用就是收回这项授权，已经开着的 YouTube 页面里简幕会撤下，本机存的笔记和概览不删。
- **读什么**：启用以后，在 YouTube 观看页上读视频信息（标题、频道名、时长、简介）和观看状态。字幕在你点「读取字幕」或卡片上的「生成概览」时读；打开「打开就出结论」以后，打开超过设定时长的视频也会读；用「本窗口全部生成」时，确认以后逐个读本窗口里的 YouTube 视频。读的都是页面上文字稿里已经显示的内容。为了标出是哪种语言、是不是自动生成的，同时读播放器在页面上已有的字幕轨列表（每条轨的语言、名字和是不是自动生成），只用来认出文字稿显示的是哪一条，不读字幕的地址；认不出时标成「来源未确认」。
- **替你点开文字稿**：读字幕时文字稿面板没开的话，简幕替你点一下视频简介里打开文字稿的按钮；面板开着但停在章节那一页时，替你点文字稿那一页。只点这一下，点开以后字幕是页面自己取的。卡片上的「生成概览」、「打开就出结论」和「本窗口全部生成」点开的，读完替你点收起按钮关上；你自己开着的不关。正在播广告、文字稿的搜索框里有字时不点。
- **解释当前画面**：播放器上同样有「解释当前画面」的图标，侧边栏里的按钮也能用。点了截视频当前的一帧，连同视频标题发给你给画面分析选的模型；已经读过这个视频的字幕时带上这一刻前后几句，没读过就只发画面，不会为此去读字幕或点开文字稿，标题这时用标签页的标题。截图只用这一次，不存。正在播广告、加密播放、视频页不在前台时不截。
- **不做的事**：简幕在 YouTube 上不向平台发任何请求，不换语言、不滚动、不动播放器，不读 Cookie，也不碰平台自带的机器翻译字幕。
- **发什么**：和 B 站一样，要先同意数据说明：字幕、视频标题和时长、频道名和简介，以及你的问题和选中的文字。平时只在你点按钮时发；打开「打开就出结论」以后，打开超过设定时长的 YouTube 视频也自动发，规矩和 B 站一样。
- **存什么**：读到的字幕和视频信息和 B 站视频一样进缓存，你生成、保存的概览、问答、笔记和译文一样留在本机。
- **权限**：可选的主机权限 `https://www.youtube.com/*`，只在你点启用时申请；授权以后，简幕用 `scripting` 在 YouTube 页面上注册自己的页面脚本，另有一小段只读的脚本跑在页面自己的环境里，只用来读上面说的字幕轨列表；撤销授权时两份一起注销。

### 待定

首发前要处理的：

- 换了 AI 服务地址以后，回收旧地址的访问授权：修好并在真实浏览器里验证以后再写进来，同时写明哪些情况下授权可能还留着。<!-- 待定：回收旧授权，实机验证后再写 -->
- 拿最终的安装包把各节和预设服务商的隐私政策链接再核对一遍。<!-- 待定：按最终安装包核对 -->

## English

### Summary

- Jianmu (简幕) is a Chrome extension. There is no developer server, no account, no ads and no analytics. The developer never receives any of your content.
- Everything Jianmu keeps is stored in the browser on your computer.
- Jianmu only sends content to a model service after you agree to the data notice, and only to the service you chose yourself in Settings.
- On YouTube, Jianmu runs only after you turn it on. See the YouTube section for how it differs from Bilibili.

### Where the data comes from

- **Bilibili**: the video page you are watching, plus the video details, subtitles, official summaries and Watch Later list that Jianmu reads from Bilibili for you. When a video has no subtitle track, or its subtitle list or subtitle file cannot be read, Jianmu uses the automatically generated subtitles that come with the official summary and labels where they came from. Before each request for subtitles, official summaries or the Watch Later list it checks that you are signed in. While you are signed out it reads only the video details (public information such as the title, uploader and length), to show which video you are on and to pick the reading mode, and nothing else. Content already stored on this computer and subtitles you imported still show when you are signed out. Playback state on the video page (playing, paused, duration) comes from the page itself and is read whether or not you are signed in. It does not read paid or supporter-only content. When it cannot tell whether a video is paid, it reads it anyway and only skips videos confirmed as paid. It never downloads audio or video.
- **You**: the questions you type, text you select, notes you take, subtitle files and backups you import, your API key and your settings.
- **The model service**: the overviews, verdicts, translations, answers and explanations the service sends back.

### What Jianmu reads on your computer

After installation, Jianmu reads no video data at all. The first time you open the side panel or Settings, it lists what it will read, and it starts only after you click "Turn on Jianmu". Once enabled, it reads:

- Video details: title, uploader, duration and description.
- Subtitles.
- Bilibili's official summary and the uploader's chapter markers.
- Playback state: playing, paused and total time played.
- Your Bilibili sign-in state: only whether you are signed in. See the next section.
- When you use "Generate all in this window": the address and title of each tab in the current window that is on a site Jianmu is allowed to access.
- With "Verdict on open" switched on: the address of each tab on a site Jianmu is allowed to access, so Jianmu can recognise the videos you open, including tabs opened in the background that you haven't looked at yet.
- When you click to read on the triage page: your Bilibili Watch Later list and how far you have watched each video.
- When you click the "Explain this frame" icon on the player, or the button in the side panel: the current frame of the video. It captures only the video itself, never the whole page. It does not capture encrypted playback (anime series and films, for example), videos confirmed as paid, ads, or a video page that is not in the foreground. Videos whose payment status cannot be confirmed are captured.

This is used to show content in the side panel and in the card on the video page, to pick Skim or Study mode from the video's length, the channel and how you are watching, and as material for overviews and answers later on.

Enabling Jianmu only covers reading and processing on your computer. Sending anything to a model service needs separate consent. See "When content is sent to a model service".

### Cookies and sign-in state

These are two separate things:

- **Jianmu does not read cookie contents.** It has no permission to read cookies, and it never reads, stores or sends your Bilibili cookie values. To tell whether you are signed in, it looks at the sign-in status Bilibili returns, not at the cookies themselves.
- **Your browser attaches your sign-in state to requests.** When Jianmu asks Bilibili for video details, subtitle lists, official summaries or your Watch Later list, the browser includes your Bilibili sign-in cookies in the request, the same as when you open a Bilibili page yourself. These requests only go to Bilibili's own domains. Subtitle file downloads go without them.

### When content is sent to a model service

First you need to read the data notice and agree, either by ticking the box in the "AI service" section of Settings or by clicking "Agree and turn on" in the "Verdict on open" section. Until you do, Jianmu sends no AI requests at all, including fetching the model list and testing the connection. Unticking the box takes effect straight away: requests not yet sent are not sent, and a request already on its way is allowed to finish.

**What may be sent**, limited to what the current feature needs:

- Subtitle text, including text from subtitle files you imported and the subtitles that come with the official summary
- Text you selected
- Your questions
- Video title and duration
- Uploader name and video description
- Bilibili's official summary, used by "Write a verdict from the official summary" and when triage writes verdicts
- When writing the one-line verdict, the chapter titles, summaries and key quotes already generated for that video
- When you click "Explain this frame", the current frame of the video with a few subtitle lines either side of that moment and the video title, sent to the model you chose for "Frame analysis" under "Models per feature" in Settings
- Your API key, which goes with every request so the service knows it is your account

**What it is used for**: translation, tidying subtitles (adding punctuation and fixing obvious sound-alike mistakes), overviews, one-line verdicts, explaining selected text, tidying up notes, answering questions, writing one-line verdicts during triage, and explaining the current frame.

**When it is sent**:

- Normally only when you do something, such as clicking "Generate overview", asking a question, clicking "Explain", clicking "Tidy up subtitles", clicking "Explain this frame", or taking a note (once a note is saved, the model is asked to tidy up the subtitle line from that moment). Once you start a translation or subtitle tidy-up, it keeps sending batches in the background, even after you close the side panel, until it finishes, you click stop, or the tab with that video moves to another video or is closed.
- For "Generate all in this window" and triage, you confirm how many videos first, and they are then sent one at a time.
- Jianmu needs to know whether the frame-analysis model can read images. When it does not recognise the model, it sends one 64×64 red image (not a frame from the video) and asks what colour it is. Only a correct answer counts.
- With "Verdict on open" switched on: when you open a Bilibili video longer than the set length, Jianmu automatically sends that video's subtitles, title and duration, uploader name and description to generate an overview and a one-line verdict. The switch is off on a new install, and you have to agree to the data notice before turning it on. The set length is 10 minutes by default and can be anywhere from 0 to 180 minutes. Tabs opened in the background that you haven't looked at yet count too, and so do tabs that were already open when you switched it on. They are queued, with the video you are watching going first. At most two are generated at a time, and at most 40 in any 10 minutes. The more tabs you open at once, the more of your API quota it uses. Videos that already have an overview are skipped, and each video is tried automatically at most once per browser session. Foreign-language subtitles are not translated automatically. If the service says your quota has run out or your key is wrong, or a service on your computer refuses requests from the browser extension, automatic generation pauses until you generate an overview by hand successfully or switch the setting off and on again.

**Never sent**: your Bilibili cookies or other sign-in credentials, and the subtitle file addresses the platform returns.

### Who receives it

- Content only goes to the service address you chose in Settings. You can pick one of the presets below, or choose "Custom" and enter an address yourself, including a model service running on your own computer. Only https addresses are accepted, except that local addresses (localhost and 127.0.0.1) may use http. Those requests never leave your computer.
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
- Ollama (on this computer): requests go to Ollama on your own computer. According to Ollama, content stays on your computer when you use a local model. If you choose one of Ollama's cloud models, the content is processed by Ollama: <https://ollama.com/privacy>

### What is stored on your computer, and for how long

Everything is kept in the extension storage of this Chrome profile on this computer, and none of it is synced with your browser account. Jianmu does not add its own encryption to this data. The name of each item is listed under "Storage details" at the end.

- **Kept until you delete it**: overviews and one-line verdicts, Q&A, notes, translations, imported subtitles, the mode remembered for each channel, and settings.
- **Caches**: subtitles, video details, Bilibili official summaries and chapter markers are kept for up to 500 videos. Entries older than 90 days, or beyond that number, are deleted the next time something new is cached. The Watch Later list and official summaries read for triage, what each model can do (for example whether it accepts images), and the result of checking whether the frame-analysis model accepts images, stop being used once they expire, but stay in storage until they are read again or you clear the cache. Subtitle file addresses are not stored.
- **Kept only until the browser closes**: which mode each video you are watching uses and how long it has played, which videos "Verdict on open" has already tried, the text of recent frame explanations (no longer shown after half an hour, and deleted the next time you open the side panel or explain a frame), how many tokens each feature's most recent model request used, and your API key in the default setup (see "API key"). How long to wait after Bilibili rate-limits requests is also kept only until the browser closes.
- **Not stored**: a frame captured for "Explain this frame" is used for that one request only. It is not stored anywhere and never goes into backups.

### Deleting data and backups

- **Clear cache** (in Settings) deletes the caches above and the usage of each feature's most recent request. Overviews, Q&A, notes, translations, imported subtitles, settings and the key stay.
- **Clear all data** (in Settings) deletes everything Jianmu keeps on this computer, including notes, overviews, Q&A, translations, imported subtitles, settings, the key, your data consent and your confirmation to enable Jianmu. It cannot be undone, and you will need to enable Jianmu and agree again afterwards. Only two things are left: how long to wait after Bilibili rate-limits requests, and which windows have Jianmu's side panel open (window numbers only). The first is kept so Jianmu does not start requesting again straight after clearing, the second so a side panel that is still open and the card on the watch page stay in step. Neither holds any of your content, and both are gone once the browser closes.
- **One at a time**: notes and Q&A entries can be deleted individually in the side panel.
- **Uninstalling**: Chrome deletes the data the extension kept on this computer.
- Deleting here means neither Jianmu nor the browser can read the data any more. Old content may still be left in the browser's storage files, and Jianmu cannot guarantee it is gone from the disk.
- **Export backup** (in Settings): the backup file holds your notes, overviews, Q&A, translations and tidied subtitles. It leaves out the API key, settings, caches, imported subtitles and per-channel modes. The browser downloads the file to your computer and it is yours to look after. It contains your notes and Q&A, so take care before sharing it. Restoring a backup only merges it into what is already on this computer.

### Permissions

| Permission | What it is for |
| --- | --- |
| `sidePanel` | Showing the side panel |
| `storage` | Keeping data and settings on your computer |
| `scripting` | After installing, updating or enabling, adding Jianmu's page script to Bilibili video pages that are already open, so you don't need to reload them |
| `contextMenus` | Adding a few of Jianmu's own items to the menu you get by right-clicking its toolbar icon |
| Access to Bilibili's web pages, its API and the domain where it keeps subtitle files | Placing the card, the note button and the "Explain this frame" icon on Bilibili video pages, reading playback state, and reading the current frame of the video when you click that icon; reading video details, subtitles, official summaries and Watch Later |
| Optional: access to the AI service address you chose | When you click "Save and authorise", the browser asks whether Jianmu may access that domain. The manifest declares this as an optional range of https addresses, plus `http://localhost` and `http://127.0.0.1` on your own computer, but Jianmu only ever requests the one address you chose |

Jianmu does not request `tabs`, `activeTab`, `cookies`, `downloads`, `debugger`, `tabCapture` or `desktopCapture`, and does not request access to all websites or to the microphone. Without the `tabs` permission it can only see the addresses and titles of tabs on sites it has permission for.

### API key

- By default the key lives only in the current browser session and never goes to disk. Restarting the browser, or turning off, reloading or updating the extension, clears it, and you have to enter it again.
- If you tick "Remember the key on this computer" in Settings and save, the key is written to the extension's storage on this computer and still works after a browser restart. **This copy is not encrypted.** Programs or people that can read this computer's browser data may be able to get it, so don't turn this on on a shared computer. Jianmu first limits that storage so only its own pages and background can read it, and won't remember the key if the limit can't be set. The limit only keeps out the page scripts Jianmu runs inside websites. It is not encryption.
- Unticking the box, clicking "Clear key" or clicking "Clear all data" deletes the copy on this computer. Even after that, **the old key may still be left in plain text in the browser's storage files**. Chrome deletes the extension's data when you uninstall it, but that is not a secure wipe either, and copies in system backups are not affected. If you are worried about a leak, revoke the key in your provider's dashboard.
- If you switch to another provider, or change the address to a different domain and save, the old key is removed and the remember option is switched off.
- Either way, the key never goes into web pages, page scripts, logs, error messages or backups, is not synced by the browser, and is only sent with requests to the service address it is bound to.

### What Jianmu does not do

- No analytics, crash reporting or ads, and no remotely loaded code.
- It changes nothing on Bilibili for you: no likes, no comments, no edits to your Watch Later list.
- It does not sell or share your data. The developer doesn't have it in the first place.

### Chrome Web Store User Data Policy

Jianmu's use of the content it reads complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use), including the Limited Use requirements:

- It is used only to provide the features described in this policy.
- Jianmu sends it only to the model service you chose, and only after you agree. It sends it to no other recipient.
- It is not used for advertising and is not sold.
- The developer cannot read your content. Jianmu has no developer server, so it never reaches the developer. How the model service handles it is set by that service's own policy, as described under "Who receives it" above.

### Changes to this policy

Changes are recorded in this repository's commit history. If what is sent to a model service, what it is used for, who receives it or how sending is triggered goes beyond what you agreed to, Jianmu lists the new parts in the extension and waits for you to agree again before sending any more. If what it reads changes materially, it asks you to confirm enabling Jianmu again.

### Contact

- Questions and suggestions: open an issue on this repository's [Issues](https://github.com/TIAN-TOM/jianmu/issues) page. Issues are public, so please don't post API keys, cookies or other personal information there.
- Email: <tiantom.dev@gmail.com>
- Please report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

### Storage details

Object stores in the IndexedDB database `jianmu`:

| Name | What it holds | Clear cache | Clear all data | In backups |
| --- | --- | --- | --- | --- |
| `notes` | Notes | Kept | Deleted | Yes |
| `overviews` | Overviews and one-line verdicts | Kept | Deleted | Yes |
| `qa` | Q&A | Kept | Deleted | Yes |
| `translations` | Translations and tidied subtitles | Kept | Deleted | Yes |
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
| `jianmu_usage` | The usage of each feature's most recent model request: the input, output and reasoning token counts the service reported, plus the model name and reasoning level used, with nothing from the request or the reply | Session | Deleted | Deleted |
| `jianmu_image_probe` | Whether the frame-analysis model accepts images | Local | Deleted | Deleted |
| `jianmu_frame_results` | The text of recent frame explanations, without the frames; no longer shown after half an hour and deleted the next time it is used | Session | Deleted | Deleted |
| `jianmu_transcript_modes` | The video ID and subtitle display mode for the last 50 videos where you chose a mode | Session | Kept | Deleted |
| `jianmu_watch_sessions` | For each tab, the mode of the video being watched, how long it has played and whether the card is expanded | Session | Kept | Deleted |
| `jianmu_auto_ledger` | Which videos "Verdict on open" has tried, the times of recent attempts and why it is paused | Session | Kept | Deleted |
| `jianmu_settings_revision` | A random revision number for settings, so an out-of-date Settings page cannot write old settings back | Local | Kept | Replaced with a new value |
| `jianmu_appearance` | A copy of the appearance settings, used first when a page opens so it doesn't flicker | The page's local storage | Kept | Reset to default |
| `jianmu_site_backoff` | How long to wait after Bilibili rate-limits requests: only the site, an expiry time and a count | Session | Kept | Kept |
| `jianmu_open_panels` | Which windows have Jianmu's side panel open: window numbers only. The card on a watch page in the same window folds away while the panel is open | Session | Kept | Kept |
| `jianmu_self_reload` | How many times Jianmu has reloaded itself after you copied a new version over it: only the new build's identifier, a count and a time, so it doesn't keep reloading if the files were only partly replaced | Local | Kept | Deleted |

### YouTube

The sections above describe Bilibili. On YouTube, Jianmu differs in these ways:

- **How it is turned on**: after installation Jianmu leaves YouTube alone. When you click "Turn on for YouTube" in the side panel or in Settings, the browser asks whether Jianmu may access `www.youtube.com`. Only after you allow it does Jianmu run on YouTube pages. You can turn it off in Settings, which withdraws that access. Jianmu then removes itself from YouTube pages that are already open. Notes and overviews kept on your computer stay.
- **What it reads**: once turned on, it reads the video details on a YouTube watch page (title, channel name, length, description) and the playback state. Subtitles are read when you click "Read subtitles" or the card's "Generate overview" button. With "Verdict on open" switched on, they are also read when you open a video longer than the set length, and when you use "Generate all in this window", the YouTube videos in the window are read one by one after you confirm. Subtitles always come from the transcript as it is already shown on the page. To record which language it is and whether it was auto-generated, Jianmu also reads the list of subtitle tracks the player already has on the page (each track's language, name and whether it was auto-generated). It uses that list only to work out which track the transcript is showing, and does not read subtitle addresses. When it cannot tell, it marks the source as unconfirmed.
- **Opening the transcript for you**: when it reads subtitles and the transcript panel is not open, Jianmu clicks the button in the video description that opens the transcript. If the panel is open but showing chapters, it clicks the transcript tab. It clicks only that once, and the page itself then loads the subtitles. When the card's "Generate overview" button, "Verdict on open" or "Generate all in this window" opened the panel, Jianmu clicks its close button once it has read it. A panel you opened yourself stays open. It does not click anything while an ad is playing or while there is text in the transcript's search box.
- **Explaining the current frame**: the "Explain this frame" icon on the player and the button in the side panel work on YouTube too. Clicking captures the current frame of the video and sends it, with the video title, to the model you chose for "Frame analysis". If Jianmu has already read this video's subtitles, it adds the few lines either side of that moment. If not, it sends the frame on its own and does not read subtitles or open the transcript to get them, and the title comes from the tab. The frame is used for that one request and is not stored. Nothing is captured while an ad is playing, during encrypted playback, or when the video page is not in the foreground.
- **What it does not do**: on YouTube, Jianmu sends no requests to the platform. It does not change the language, scroll or touch the player. It does not read cookies and never uses the platform's machine-translated subtitles.
- **What it sends**: as on Bilibili, only after you agree to the data notice: the subtitles, the video title and length, the channel name and description, and your question or selected text. Normally this is sent when you click a button. With "Verdict on open" switched on, it is also sent automatically for YouTube videos longer than the set length, under the same rules as on Bilibili.
- **What it keeps**: subtitles and video details go into the same cache as Bilibili videos. Overviews, Q&A, notes and translations you create stay on your computer in the same way.
- **Permissions**: the optional host permission `https://www.youtube.com/*`, requested only when you click to turn it on. Once granted, Jianmu uses `scripting` to register its page script on YouTube pages, plus a small read-only script that runs in the page's own environment, only to read the track list described above. Both are removed when access is withdrawn.

### Still to be settled

To be done before release:

- Revoking access to the old AI service address after you switch to a new one: this will be added once it is fixed and tested in a real browser, together with the cases where access may be kept. <!-- 待定：回收旧授权，实机验证后再写 -->
- Check every section, and the links to the preset services' privacy policies, against the final release package. <!-- 待定：按最终安装包核对 -->
