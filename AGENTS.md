# 开发约定

简幕是一个 Chrome 扩展（Manifest V3）：帮用户几分钟内判断一个 B 站或 YouTube 长视频值不值得看，决定看了再陪着精读。模型用用户自己的 API 密钥，没有开发者后端，资料存在本机。

产品范围、路线和规矩看 [PRD](notes/product-prd.md)，代码结构和实施顺序看[架构设计](notes/architecture.md)。同一件事只在一处详写，这里只放写代码时每天用得到的规矩。

## 现在有什么

进度和逐个文件做什么见[架构设计第 5.3 节](notes/architecture.md)，目标结构见第 5.1 节。加了、挪了模块或改了模块的职责，同一个 PR 改第 5.3 节，这里不用动。下面只列带规矩的目录：

- `src/core/`：纯逻辑，不碰 `chrome.*` 和 DOM
- `src/platform/`：`chrome.*` 和 IndexedDB 的薄封装，测试换替身
- `src/content/`：注入视频页的内容脚本，原生 DOM
- `prompts/`：提示词模板，构建时内联进后台包
- `notes/`：公开的设计文档，走白名单

## 命令

```bash
npm run check       # 写代码时每轮必跑：类型检查、单元测试、构建、构建产物检查、公开结构检查
npm run package     # 打出 dist/jianmu-<版本>.zip 和同名的 .sha256，同时校验包的内容
npm run test:e2e    # 端到端冒烟，用 CHROME_PATH 指定 Chrome for Testing 的可执行文件
npm run test:e2e:lifecycle   # 生命周期冒烟：任务没人认领时收尾，关掉发起页面任务照常跑完，强行终止后台后任务表为空、不自动重发；合并涉及任务和保活的改动前本机跑
npm run test:pages  # 页面测试：无头 Chrome 里打开扩展页面，后台接本机模拟服务，只看页面文字和属性；报告写到 e2e/artifacts/
npm run release -- candidate   # 发布候选：要在远端 main 的最新提交上、工作树干净；其余子命令见 scripts/release.mjs 开头
```

单项命令：`npm run typecheck`、`npm test`、`npm run build`、`npm run test:build`、`npm run check:public`。

打完发布候选，在 GitHub Actions 里手动触发「发布前核对」（`.github/workflows/release-check.yml`），填候选的提交号和校验值：它在 Chrome for Testing 116 和当前稳定版上各跑一遍端到端，在 Linux 上重新打包核对校验值。这个工作流不在必需检查里。

## 改代码时要知道的

- 依赖只能往下：`pages`、`content`、`background` → `sites` → `platform` → `core`、`shared`。结构规则见架构设计第 5.2 节，`tests/structure.test.ts` 会查。
- 相对导入写 `.ts` 扩展名；不用 `enum`、`namespace`、参数属性、路径别名、装饰器。`.tsx` 不进单元测试，渲染放到无头 Chrome 里测。
- Node 跑测试只剥类型不查类型，类型错误靠 `npm run typecheck` 拦。
- 业务入口写成 `createX(deps)`，测试注入替身。测试不访问真实的模型服务和平台接口；等异步结果按条件等，不固定等几毫秒：等会发生的事用 `tests/helpers/wait-until.ts` 的 `until`，确认没发生用 `stillFalse`；能等到具体事件（比如模拟服务收到请求）的就直接等那件事。
- 注入 B 站和 YouTube 页面的标识一律以 `jianmu-` 开头，集中定义在 `src/shared/names.ts`。
- 新增要进包的文件，同一个 PR 改 `tests/fixtures/package-files.txt`。
- 版本号只写在 `package.json`，构建时写进产物清单。改版本号的提交用 `release:`。
- 清单模板里的 `key` 是扩展身份，决定扩展 ID（快照在 `tests/fixtures/extension-id.txt`），不要改：改了已装用户的资料就接不上。私钥不进仓库，公开结构检查拦 `.pem`、`.crx`、`.key`。
- 文本文件一律 LF。
- 新增或升级依赖，在 PR 里写明是什么、为什么要。`.npmrc` 开了 `ignore-scripts`，`npm run` 不跑 pre、post 脚本，别依赖它们。
- 新的扩展页面入口也先过 `src/pages/shared/build-check.ts` 的 `startWhenCurrent`：后台和页面不是同一次构建时只显示重新加载的提示。后台不认识的请求和端口回 `UNKNOWN_ROUTE`，发送方不放行回 `FORBIDDEN`，端口被拒时先发带码的通知再断开。
- 读写设置一律经 settings store 的锁，不直接写整份设置，否则密钥可能落盘。
- 删掉的设置项不留界面也不留存储；改设置结构时，旧值要么安全忽略，要么迁移，并补测试。
- 发给模型的数据类别、用途、接收方、发送的触发方式或范围有实质变化，同步改设置页的数据说明、首次启用说明、同意表、`PRIVACY.md`、README；超出原同意范围的升版，开发期间也一样。规则和版本号见 PRD 第 7.2 节。
- 扩展新增对外请求时要给端到端的模拟服务器补一条路由，否则测试会把它当意外请求判失败。
- GPL、AGPL 许可的同类项目只借思路，不用代码。

## 流程

- 顺序：先做「打开就出结论」，再换到新版日用 B 站（架构设计第 12 节第 9 步）；然后补齐首发要带的功能，在 GitHub 发只支持 B 站的首发版；之后做 YouTube。每一步做完的标准见 PRD 第 1 节。
- 每一步的方案只写成短清单，放在 PR 说明里，不另写方案文档。
- 每个 PR 跑完 `npm run check` 并等 CI 通过。自动审查只处理第一轮意见，之后 CI 通过就合并；后来再提的意见，值得做的另开 PR。
- 移植 PR 以黄金样本一致为准，不另做多角度审查。界面 PR 以 `npm run check` 和端到端主流程通过为准，不逐项对照旧测试。
- 公开内容平时按下一节自查，由公开结构检查把关；PRD 第 9 节的完整清单在发版前走一遍。

## 公开内容的边界

这是公开仓库，历史收不回。完整清单见 PRD 第 9 节，发版前逐条过一遍。写代码、注释、文档、提交说明，以及 PR 和 issue 的标题、正文和回复时记住这几条。PR 和 issue 上的文字改了以后，修改记录里还看得到旧版本。

- 文档、注释、提交说明，以及 PR 和 issue 的文字里，平台接口只按能力描述，例如「读取字幕轨」「B 站接口要求的请求签名」「被平台限流」，不写成接口文档。审查意见里引了接口细节，回复时也不照抄。接口细节只出现在 `src/sites/` 的源码、它的测试和模拟路由里，另有结构测试的地址放行表和清单的主机权限。
- 代码注释只写用途，不写字段说明、错误码含义和请求细节，也不写来历（参考了谁、文档怎么说、实测结果）。`src/sites/` 的注释不放路径和外部链接。
- B 站读取实现（含请求签名）在 `src/sites/bilibili/`，随这个仓库和 Releases 的 zip 公开。不抄第三方接口文档，不带它们的文字和注释，沿用 MIT 代码的部分保留版权声明；只给已登录用户读，每次读取先确认登录；不下载音视频，不碰付费内容，付费状态确认不了时也不读，保持低频，被限流或遇到人机验证就停，不读 Cookie 值，不冒充其他客户端。见 PRD 第 8.1 节。
- 测试样例和黄金样本的输入一律自己造，不用真实视频的编号、标题、字幕和平台返回文字，不用真实备份，也不用第三方资料里的示例值。
- `notes/` 只放白名单里的文档。主要使用者写作「开发者本人」。
- README 用的截图和演示动图放 `.github/assets/`，只许 PNG 和 GIF，单个不超过 5 MB；`.github/` 别处不放图片。公开结构检查会拦。
- 称呼 Digest for Bilibili 用它的名字。

## 提交和 PR

- 提交信息用 Conventional Commits：`type` 用英文，主题行用中文动宾短语，不加句号，`scope` 可选。例如 `feat(字幕): 支持导入 VTT 文件`。
- 主题行写改了什么，为什么和影响面放正文。提交和 PR 的说明写结果，不写过程。
- 在功能分支上开发，不直接提交到 `main`。CI 通过以后，把分支变基到最新的 `main`，在本地用 `git merge --ff-only` 合并再推送，GitHub 会把 PR 标成已合并。不用 GitHub 的合并按钮：服务端合并会改写提交的作者或提交者身份。
- 一个 PR 只改一件事：移植、改身份、改行为、加功能各自成 PR。移植 PR 的黄金样本必须一致，改行为的 PR 逐条写明差异。
