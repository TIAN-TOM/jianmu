# 开发约定

简幕是一个 Chrome 扩展（Manifest V3）：帮用户几分钟内判断一个 B 站或 YouTube 长视频值不值得看，决定看了再陪着精读。模型用用户自己的 API 密钥，没有开发者后端，资料存在本机。

产品范围看 [PRD](notes/product-prd.md)，阶段和发布条件看[方案](notes/dual-site-launch-plan.md)，代码结构看[架构设计](notes/architecture.md)。同一件事只在一处详写，这里只放写代码时每天用得到的规矩。

## 现在有什么

核心逻辑、设置、同意、授权和 B 站适配层已经移植完（架构设计第 12 节第 3、5、6 步），第 4 步（身份和存储）还差备份，问答、译文两个仓储跟后台服务一起在第 7 步写；后台服务还没接上，还没有用户能用的功能。推迟到后面步骤的事见架构设计第 12 节表后。下表只列已有的东西。目标结构见架构设计第 5.1 节。

| 位置 | 做什么 |
| --- | --- |
| `manifest.template.json` | 清单模板，手写；版本号由构建写入 |
| `src/core/` | 纯逻辑，不碰 `chrome.*` 和 DOM：视频身份、并发、任务（`task-keys.ts` 是互斥键和等价键）、清除闸门、高亮、同意表和启用说明，`errors.ts` 错误码和结果形状（各领域的码在 `errors/`），`mode/` 模式和观看会话的类型、`decide.ts` 模式规则，以及 `transcript/`、`qa/`、`triage/`、`ai/`、`notes/` |
| `src/shared/` | `names.ts` 存储键和扩展页面路径，`storage-plan.ts` 每份本机数据的清除和备份归属，`settings-schema.ts` 设置的结构、规整和校验，`messages.ts` 消息类型（各领域在 `messages/`，发给内容脚本的指令在 `messages/content.ts`） |
| `src/platform/` | `idb.ts` IndexedDB 驱动，`storage.ts`、`locks.ts`、`permissions.ts`、`messaging.ts`、`tabs.ts` 是扩展存储、Web Locks、主机权限、消息、标签页、侧边栏和脚本注入的薄封装，`settings-store.ts` 设置读写、会话密钥、记住密钥的本机记录和设置修订号，`site-backoff.ts` 站点限速和退避，`keepalive.ts` 任务在跑时撑着 service worker 不被回收 |
| `src/sites/` | 站点适配层：`types.ts`、`page-types.ts` 是契约，`rules.ts` 是地址规则，`bilibili/` 是 B 站的地址解析、播放页和读取实现，`services.ts` 是后台用的服务注册表 |
| `src/background/`、`src/pages/` | 内联的提示词、`grants.ts` 回收用不上的主机授权，侧边栏占位页 |
| `src/background/` 入口和路由 | `main.ts` 一次注册全部顶层监听，都先过 `wake.ts` 的醒来钩子；`app.ts` 拼依赖；`router.ts`、`senders.ts`、`routes/` 是路由表、端口表、发送方核对和首次启用闸门，放行规则见架构设计第 10.2 节的允许矩阵；端口连接走同一道闸门，启用失效时断开，会发起工作的端口消息逐条重查 |
| `src/background/ai.ts` | 模型服务接线：传输层按设置规则建，主机权限只查不申请，参数放宽记在会话存储里，模型能力只经核对过同意的读取取得，写缓存过清除闸门；服务按任务取冻结的地址和模型；配置检查、拉模型列表、测试连接三条路由在 `routes/ai.ts` |
| `src/background/tasks.ts` | 任务运行：登记、认领、没人认领到点收尾，互斥键和等价键，跟着页面走的任务在页面都断开时停下，整个任务和每次模型请求两层保活；任务表只在内存里。`limits.ts` 是卡片的限频和一次性令牌，列出、登记、取消三条路由在 `routes/tasks.ts` |
| `src/background/sessions.ts` | 观看会话：按标签页记在会话存储里，刷新同一视频沿用，换视频开新的；播放上报只改界面模式，拿不到任务和模型入口。路由在 `routes/session.ts`，播放上报每个标签页 10 秒一条的限频在 `limits.ts` |
| `src/background/reinject.ts` | 安装、更新后和确认启用时往已开的视频页补注入内容脚本，脚本和匹配规则从清单取，确认前不做；`routes/grants.ts` 把授权回收接给设置页，确认前也放行 |
| `src/background/services/transcript/` | 取字幕服务，接上了 B 站读取：缓存优先，同一视频同一语言的在途读取合并；每次读取新建读取环境，用核对过的视频信息定下这次读取的视频和媒体版本，之后的请求只用它；字幕文件下载有总预算，被限流就停，点名语言时字幕文件读不成就重新列一次轨；字幕文件地址不进缓存。官方总结和字幕列表同时问，跟着字幕进缓存，读不成字幕时也带回去；字幕先到时最多再等一会儿，等不到先交字幕、回来后填回；排队中、要登录、没问成的过一阵再问，命中缓存时在后台问（导入的字幕只用本机的，不问）；官方总结附带的 AI 字幕当字幕用的兜底默认关（`official.ts`）。时间轴和视频时长对不上的字幕只记在内存里（`memory.ts`）；用户导入的字幕文件排在读视频信息之前，命中就不向平台发请求，导入和移除只作废缓存里的字幕，作废不掉就撤回（`imports.ts`）。卡片只用轻量读取（`light.ts`）：只要视频信息、官方总结和本机已有的概览，没缓存时不读字幕，问到的只记在内存里；同一视频的完整读取在路上就并进去，等不及就用它已经读到的。路由在 `routes/transcript.ts`（取字幕、查原视频还在不在）和 `routes/imports.ts`（导入、移除字幕文件） |
| `src/background/stores/` | 字幕缓存、导入的字幕、笔记、概览、频道偏好五个仓储，`write-gate.ts` 是它们共用的写入关口，`drivers.ts` 第一次读写时才建数据库驱动 |
| `prompts/` | 提示词模板，构建时内联进后台包 |
| `static/` | 原样复制进构建产物 |
| `scripts/` | `build.mjs` 构建，`package.mjs` 打包和校验（同一个提交打两次得到同一个 zip，旁边写校验值文件），`release.mjs` 发布候选、候选之后的核对、发布说明草稿和发布前检查，`check-public.mjs` 公开结构检查 |
| `tests/` | `unit/` 单元测试，`structure.test.ts` 结构规则，`build-output.test.ts` 构建产物检查，`fixtures/golden/` 黄金样本，`helpers/` 替身（`fake-ai.ts` 是后台各服务测试共用的模型服务替身，`fake-site-service.ts` 是站点读取服务的替身，`manual-timers.ts` 是手动推进的计时器） |
| `e2e/` | 把打好的包装进 Chrome for Testing 跑冒烟，站点请求都指向本机模拟服务器（能中途切场景），其余域名解析失败；`lifecycle.mjs` 单独看任务表在 service worker 被终止前后的样子 |
| `notes/` | 公开的设计文档，走白名单 |

## 命令

```bash
npm run check       # 写代码时每轮必跑：类型检查、单元测试、构建、构建产物检查、公开结构检查
npm run package     # 打出 dist/jianmu-<版本>.zip 和同名的 .sha256，同时校验包的内容
npm run test:e2e    # 端到端冒烟，用 CHROME_PATH 指定 Chrome for Testing 的可执行文件
npm run test:e2e:lifecycle   # 生命周期冒烟：任务没人认领时收尾，强行终止后台后任务表为空、不自动重发；合并涉及任务和保活的改动前本机跑
npm run release -- candidate   # 发布候选：要在远端 main 的最新提交上、工作树干净；其余子命令见 scripts/release.mjs 开头
```

单项命令：`npm run typecheck`、`npm test`、`npm run build`、`npm run test:build`、`npm run check:public`。

打完发布候选，在 GitHub Actions 里手动触发「发布前核对」（`.github/workflows/release-check.yml`），填候选的提交号和校验值：它在 Chrome for Testing 116 和当前稳定版上各跑一遍端到端，在 Linux 上重新打包核对校验值。这个工作流不在必需检查里。

## 改代码时要知道的

有些条目说的模块还没写出来，是给后面的移植先定的规矩。

- 依赖只能往下：`pages`、`content`、`background` → `sites` → `platform` → `core`、`shared`。结构规则见架构设计第 5.2 节，`tests/structure.test.ts` 会查。
- 相对导入写 `.ts` 扩展名；不用 `enum`、`namespace`、参数属性、路径别名、装饰器。`.tsx` 不进单元测试，渲染放到无头 Chrome 里测。
- Node 跑测试只剥类型不查类型，类型错误靠 `npm run typecheck` 拦。
- 业务入口写成 `createX(deps)`，测试注入替身。测试不访问真实的模型服务和平台接口；等异步结果按条件等，不固定等几毫秒。
- 注入 B 站和 YouTube 页面的标识一律以 `jianmu-` 开头，集中定义在 `src/shared/names.ts`。
- 新增要进包的文件，同一个 PR 改 `tests/fixtures/package-files.txt`。
- 版本号只写在 `package.json`，构建时写进产物清单。改版本号的提交用 `release:`。
- 清单模板里的 `key` 是扩展身份，决定扩展 ID（快照在 `tests/fixtures/extension-id.txt`），不要改：改了已装用户的资料就接不上。私钥不进仓库，公开结构检查拦 `.pem`、`.crx`、`.key`。
- 文本文件一律 LF。
- 新增或升级依赖，在 PR 里写明是什么、为什么要。`.npmrc` 开了 `ignore-scripts`，`npm run` 不跑 pre、post 脚本，别依赖它们。
- 读写设置一律经 settings store 的锁，不直接写整份设置，否则密钥可能落盘。
- 删掉的设置项不留界面也不留存储；改设置结构时，旧值要么安全忽略，要么迁移，并补测试。
- 发给模型的数据类别、用途、接收方、发送的触发方式或范围有实质变化，同步改设置页的数据说明、首次启用说明、同意表、`PRIVACY.md`、README；超出原同意范围的升版，开发期间也一样。规则见 PRD 第 9.2 节，版本号见方案第 7.3 节。
- 扩展新增对外请求时要给端到端的模拟服务器补一条路由，否则测试会把它当意外请求判失败。
- GPL、AGPL 许可的同类项目只借思路，不用代码。

## 公开内容的边界

这是公开仓库，历史收不回。完整清单见方案第 5.2 节，每次发版前逐条过一遍。写代码、注释、文档、提交说明时记住这几条：

- 文档、注释和提交说明里，平台接口只按能力描述，例如「读取字幕轨」「B 站接口要求的请求签名」「被平台限流」，不写成接口文档。接口细节只出现在 `src/sites/` 的源码、它的测试和模拟路由里，另有结构测试的地址放行表和清单的主机权限。
- 代码注释只写用途，不写字段说明、错误码含义和请求细节，也不写来历（参考了谁、文档怎么说、实测结果）。`src/sites/` 的注释不放路径和外部链接。
- B 站读取实现（含请求签名）在 `src/sites/bilibili/`，随这个仓库和 Releases 的 zip 公开。不抄第三方接口文档，不带它们的文字和注释，沿用 MIT 代码的部分保留版权声明；只给已登录用户读，每次读取先确认登录；不下载音视频，不碰付费内容，付费状态确认不了时也不读，保持低频，被限流或遇到人机验证就停，不读 Cookie 值，不冒充其他客户端。见方案第 4.4 节。
- 测试样例和黄金样本的输入一律自己造，不用真实视频的编号、标题、字幕和平台返回文字，不用真实备份，也不用第三方资料里的示例值。
- `notes/` 只放白名单里的文档。主要使用者写作「开发者本人」。
- README 用的截图和演示动图放 `.github/assets/`，只许 PNG 和 GIF，单个不超过 5 MB；`.github/` 别处不放图片。公开结构检查会拦。
- 称呼 Digest for Bilibili 用它的名字。

## 提交和 PR

- 提交信息用 Conventional Commits：`type` 用英文，主题行用中文动宾短语，不加句号，`scope` 可选。例如 `feat(字幕): 支持导入 VTT 文件`。
- 主题行写改了什么，为什么和影响面放正文。提交和 PR 的说明写结果，不写过程。
- 在功能分支上开发，不直接提交到 `main`。CI 通过以后，把分支变基到最新的 `main`，在本地用 `git merge --ff-only` 合并再推送，GitHub 会把 PR 标成已合并。不用 GitHub 的合并按钮：服务端合并会改写提交的作者或提交者身份。
- 一个 PR 只改一件事：移植、改身份、改行为、加功能各自成 PR。移植 PR 的黄金样本必须一致，改行为的 PR 逐条写明差异。
