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
npm run package:daily  # 开发者本人的日用包 dist/jianmu-<版本>-daily.zip：发行构建加上只给他自己用的开关
npm run test:e2e    # 端到端冒烟，用 CHROME_PATH 指定 Chrome for Testing 的可执行文件
npm run test:e2e:youtube     # YouTube 的端到端：打日用包，对着模拟的观看页走读字幕、概览、问答和站内换视频
npm run test:e2e:lifecycle   # 生命周期冒烟：任务没人认领时收尾，关掉发起页面任务照常跑完，强行终止后台后任务表为空、不自动重发；接着看解压覆盖新版以后后台自己重新加载、资料都在；合并涉及任务、保活和后台生命周期的改动前本机跑
npm run test:pages  # 页面测试：无头 Chrome 里打开扩展页面，后台接本机模拟服务，只看页面文字和属性；报告写到 e2e/artifacts/
npm run release -- candidate   # 发布候选：要在远端 main 的最新提交上、工作树干净；其余子命令见 scripts/release.mjs 开头
```

单项命令：`npm run typecheck`、`npm test`、`npm run build`、`npm run test:build`、`npm run check:public`。

`npm run build` 是发行构建，开关取值是 `src/shared/features.ts` 的 `RELEASE_FEATURES`（解释当前画面打开，YouTube 和它的代操作关着）。`node scripts/build.mjs --test-build` 打开全部开关，只给测试用，`npm run test:pages` 用的就是它；`--daily` 是日用构建，开关取值是 `DAILY_FEATURES`（发行构建加上只给开发者本人用的开关，现在是 YouTube），经 `npm run package:daily` 打成文件名带 `-daily` 的包，发布脚本不认；`--youtube-ops` 在发行构建上再打开 YouTube 和它的代开面板、代换语言，给开发者本人在 YouTube 上验证用。这几种可以加 `--watch`，只有发行构建和 `--daily` 能打包。

打完发布候选，在 GitHub Actions 里手动触发「发布前核对」（`.github/workflows/release-check.yml`），填候选的提交号和校验值：它在 Chrome for Testing 116 和当前稳定版上各跑一遍端到端，在 Linux 上重新打包核对校验值。这个工作流不在必需检查里。

## 改代码时要知道的

- 依赖只能往下：`pages`、`content`、`background` → `sites` → `platform` → `core`、`shared`。结构规则见架构设计第 5.2 节，`tests/structure.test.ts` 会查。
- 相对导入写 `.ts` 扩展名；不用 `enum`、`namespace`、参数属性、路径别名、装饰器。`.tsx` 不进单元测试，渲染放到无头 Chrome 里测。
- Node 跑测试只剥类型不查类型，类型错误靠 `npm run typecheck` 拦。
- 要按构建开关裁掉的代码只写裸常量的分支（`FEATURE_X ? … : …`），开关保护的内容放进只从这些分支引用的单独模块，模块顶层只放字面量和函数（函数调用、属性读取、带插值的模板串、算式都会让模块留在包里）；死分支会原样印进包里，所以分支里只写从开关模块导入的名字，不写字符串、JSX 和函数体；不读 `features.ts` 的对象来裁，也不开 `minifySyntax`，`if (FEATURE_X) { … }` 的块会原样留在包里。Node 测试经 `--import ./tests/helpers/build-flags.ts` 把开关定义成测试构建的取值，单跑一个测试文件也要带上；在 Node 里直接读产品模块的脚本第一个导入 `scripts/lib/release-globals.mjs`（发行取值）或 `tests/helpers/build-flags.ts`（测试取值），跟它装的包一致。
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
- 发给模型的数据类别、用途、接收方、发送的触发方式或范围有实质变化，同步改设置页的数据说明、首次启用说明、同意表、`PRIVACY.md`、README；超出原同意范围的要重新同意；首发之前不再升版，新增的条目并进当前这一版，首发以后才每次升版。规则和版本号见 PRD 第 7.2 节。
- 扩展新增对外请求时要给端到端的模拟服务器补一条路由，否则测试会把它当意外请求判失败。
- GPL、AGPL 许可的同类项目只借思路，不用代码。

## 流程

- 顺序：先做「打开就出结论」，再换到新版日用 B 站（架构设计第 12 节第 9 步）；然后补齐首发要带的功能；再做 YouTube，先在日用包里用起来；两站都走通主流程，在 GitHub 发首发版（开发者本人 2026-11-19 定）。每一步做完的标准见 PRD 第 1 节。
- 每一步的方案只写成短清单，放在 PR 说明里，不另写方案文档。
- 每个 PR 跑完 `npm run check` 并等 CI 通过。自动审查只处理第一轮意见，之后 CI 通过就合并；后来再提的意见，值得做的另开 PR。只改文档的 PR 不用等自动审查，CI 通过就合并。
- 移植 PR 以黄金样本一致为准，不另做多角度审查。界面 PR 以 `npm run check` 和端到端主流程通过为准，不逐项对照旧测试。
- 公开内容平时按下一节自查，由公开结构检查把关；PRD 第 9 节的完整清单在发版前走一遍。

## 公开内容的边界

这是公开仓库，历史收不回。完整清单见 PRD 第 9 节，发版前逐条过一遍。写代码、注释、文档、提交说明，以及 PR 和 issue 的标题、正文和回复时记住这几条。PR 和 issue 上的文字改了以后，修改记录里还看得到旧版本。

- 文档、注释、提交说明，以及 PR 和 issue 的文字里，平台接口只按能力描述，例如「读取字幕轨」「B 站接口要求的请求签名」「被平台限流」，不写成接口文档。审查意见里引了接口细节，回复时也不照抄。接口细节只出现在 `src/sites/` 的源码、它的测试和模拟路由里，另有结构测试的地址放行表和清单的主机权限。
- 代码注释只写用途，不写字段说明、错误码含义和请求细节，也不写来历（参考了谁、文档怎么说、实测结果）。`src/sites/` 的注释不放路径和外部链接。
- B 站读取实现（含请求签名）在 `src/sites/bilibili/`，随这个仓库和 Releases 的 zip 公开。不抄第三方接口文档，不带它们的文字和注释，沿用 MIT 代码的部分保留版权声明；字幕、官方总结和稍后再看只给已登录用户读，每次读取先确认登录，没登录时只读视频信息；不下载音视频，不碰确认是付费的内容（确认不了时照读），保持低频，被限流或遇到人机验证就停，不读 Cookie 值，不冒充其他客户端。见 PRD 第 8.1 节。
- 测试样例和黄金样本的输入一律自己造，不用真实视频的编号、标题、字幕和平台返回文字，不用真实备份，也不用第三方资料里的示例值。
- `notes/` 只放白名单里的文档。主要使用者写作「开发者本人」。
- README 用的截图和演示动图放 `.github/assets/`，只许 PNG 和 GIF，单个不超过 5 MB；`.github/` 别处不放图片。公开结构检查会拦。
- 称呼 Digest for Bilibili 用它的名字。

## 提交和 PR

- 提交信息用 Conventional Commits：`type` 用英文，主题行用中文动宾短语，不加句号，`scope` 可选。例如 `feat(字幕): 支持导入 VTT 文件`。
- 主题行写改了什么，为什么和影响面放正文。提交和 PR 的说明写结果，不写过程。
- 在功能分支上开发，不直接提交到 `main`。CI 通过以后（改代码的 PR 还要处理完第一轮自动审查），用 GitHub 的 squash 合并：`gh pr merge <编号> --squash --delete-branch`。不想守着 CI 时加 `--auto`，检查都通过以后 GitHub 自己合并：只改文档的 PR 开出来就可以加；改代码的 PR 等第一轮自动审查处理完再加，自动合并不等审查。`main` 不要求分支跟上最新提交（开发者本人 2026-11-19 关掉了这条，首发前再打开）：分支落后也照样合并，只有和 `main` 冲突时才要变基。两个各自通过的 PR 合在一起可能出毛病，所以合并以后看一眼 `main` 上那次推送的 CI，红了马上修。服务端合并写出来的作者是账号资料里的名字加 GitHub 的匿名邮箱，提交者是 GitHub，开发者本人 2026-11-18 确认可以这样公开；合并以后本地 `main` 用 `git pull --ff-only` 跟上。
- 一个 PR 只改一件事：移植、改身份、改行为、加功能各自成 PR。移植 PR 的黄金样本必须一致，改行为的 PR 逐条写明差异。
