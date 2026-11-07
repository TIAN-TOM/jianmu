# 开发约定

简幕是一个 Chrome 扩展（Manifest V3）：帮用户几分钟内判断一个 B 站或 YouTube 长视频值不值得看，决定看了再陪着精读。模型用用户自己的 API 密钥，没有开发者后端，资料存在本机。

产品范围看 [PRD](notes/product-prd.md)，阶段和发布条件看[方案](notes/dual-site-launch-plan.md)，代码结构看[架构设计](notes/architecture.md)。同一件事只在一处详写，这里只放写代码时每天用得到的规矩。

## 现在有什么

核心逻辑、设置、同意和授权已经移植完（架构设计第 12 节第 3、5 步），第 4 步（身份和存储）还差备份，还没有用户能用的功能。下表只列已有的东西。目标结构见架构设计第 5.1 节。

| 位置 | 做什么 |
| --- | --- |
| `manifest.template.json` | 清单模板，手写；版本号由构建写入 |
| `src/core/` | 纯逻辑，不碰 `chrome.*` 和 DOM：视频身份、并发、任务、清除闸门、高亮、同意表和启用说明，以及 `transcript/`、`qa/`、`triage/`、`ai/`、`notes/` |
| `src/shared/` | `names.ts` 存储键，`storage-plan.ts` 每份本机数据的清除和备份归属，`settings-schema.ts` 设置的结构、规整和校验 |
| `src/platform/` | `idb.ts` IndexedDB 驱动，`storage.ts`、`locks.ts`、`permissions.ts` 是扩展存储、Web Locks 和主机权限的薄封装，`settings-store.ts` 设置读写、会话密钥、记住密钥的本机记录和设置修订号 |
| `src/sites/` | 站点适配层：`types.ts`、`page-types.ts` 是契约，`rules.ts` 是地址规则，`bilibili/` 是 B 站的地址解析和播放页 |
| `src/background/`、`src/pages/` | 后台入口、内联的提示词、`grants.ts` 回收用不上的主机授权，侧边栏占位页 |
| `src/background/stores/` | 字幕缓存、笔记、概览三个仓储，`write-gate.ts` 是它们共用的写入关口 |
| `prompts/` | 提示词模板，构建时内联进后台包 |
| `static/` | 原样复制进构建产物 |
| `scripts/` | `build.mjs` 构建，`package.mjs` 打包和校验，`check-public.mjs` 公开结构检查 |
| `tests/` | `unit/` 单元测试，`structure.test.ts` 结构规则，`build-output.test.ts` 构建产物检查，`fixtures/golden/` 黄金样本 |
| `e2e/` | 把打好的包装进断网的 Chrome for Testing 跑冒烟 |
| `notes/` | 公开的设计文档，走白名单 |

## 命令

```bash
npm run check       # 写代码时每轮必跑：类型检查、单元测试、构建、构建产物检查、公开结构检查
npm run package     # 打出 dist/jianmu-<版本>.zip，同时校验包的内容
npm run test:e2e    # 端到端冒烟，用 CHROME_PATH 指定 Chrome for Testing 的可执行文件
```

单项命令：`npm run typecheck`、`npm test`、`npm run build`、`npm run test:build`、`npm run check:public`。

## 改代码时要知道的

有些条目说的模块还没写出来，是给后面的移植先定的规矩。

- 依赖只能往下：`pages`、`content`、`background` → `sites` → `platform` → `core`、`shared`。结构规则见架构设计第 5.2 节，`tests/structure.test.ts` 会查。
- 相对导入写 `.ts` 扩展名；不用 `enum`、`namespace`、参数属性、路径别名、装饰器。`.tsx` 不进单元测试，渲染放到无头 Chrome 里测。
- Node 跑测试只剥类型不查类型，类型错误靠 `npm run typecheck` 拦。
- 业务入口写成 `createX(deps)`，测试注入替身。测试不访问真实的模型服务和平台接口；等异步结果按条件等，不固定等几毫秒。
- 注入 B 站和 YouTube 页面的标识一律以 `jianmu-` 开头，集中定义在 `src/shared/names.ts`。
- 新增要进包的文件，同一个 PR 改 `tests/fixtures/package-files.txt`。
- 版本号只写在 `package.json`，构建时写进产物清单。改版本号的提交用 `release:`。
- 文本文件一律 LF。
- 新增或升级依赖，在 PR 里写明是什么、为什么要。`.npmrc` 开了 `ignore-scripts`，`npm run` 不跑 pre、post 脚本，别依赖它们。
- 读写设置一律经 settings store 的锁，不直接写整份设置，否则密钥可能落盘。
- 删掉的设置项不留界面也不留存储；改设置结构时，旧值要么安全忽略，要么迁移，并补测试。
- 发给模型的数据类别、用途、接收方、发送的触发方式或范围有实质变化，同步改设置页的数据说明、首次启用说明、同意表、`PRIVACY.md`、README；超出原同意范围的升版，开发期间也一样。规则见 PRD 第 9.2 节，版本号见方案第 7.3 节。
- 端到端的模拟服务器建好以后，扩展新增对外请求时要给它补一条路由，否则测试会把它当意外请求判失败。
- GPL、AGPL 许可的同类项目只借思路，不用代码。

## 公开内容的边界

这是公开仓库，历史收不回。完整清单见方案第 5.2 节，每次发版前逐条过一遍。写代码、注释、文档、提交说明时记住这几条：

- 文档、注释和提交说明里，平台接口只按能力描述，例如「读取字幕轨」「B 站接口要求的请求签名」「被平台限流」，不写成接口文档。接口细节只出现在 `src/sites/` 的源码、它的测试和模拟路由里，另有结构测试的地址放行表和清单的主机权限。
- 代码注释只写用途，不写字段说明、错误码含义和请求细节，也不写来历（参考了谁、文档怎么说、实测结果）。`src/sites/` 的注释不放路径和外部链接。
- B 站读取实现（含请求签名）在 `src/sites/bilibili/`，随这个仓库和 Releases 的 zip 公开。不抄第三方接口文档，不带它们的文字和注释，沿用 MIT 代码的部分保留版权声明；只给已登录用户读，每次读取先确认登录；不下载音视频，不碰付费内容，付费状态确认不了时也不读，保持低频，被限流或遇到人机验证就停，不读 Cookie 值，不冒充其他客户端。见方案第 4.4 节。
- 测试样例和黄金样本的输入一律自己造，不用真实视频的编号、标题、字幕和平台返回文字，不用真实备份，也不用第三方资料里的示例值。
- `notes/` 只放白名单里的文档。主要使用者写作「开发者本人」。
- 称呼 Digest for Bilibili 用它的名字。

## 提交和 PR

- 提交信息用 Conventional Commits：`type` 用英文，主题行用中文动宾短语，不加句号，`scope` 可选。例如 `feat(字幕): 支持导入 VTT 文件`。
- 主题行写改了什么，为什么和影响面放正文。提交和 PR 的说明写结果，不写过程。
- 在功能分支上开发，不直接提交到 `main`。CI 通过以后，把分支变基到最新的 `main`，在本地用 `git merge --ff-only` 合并再推送，GitHub 会把 PR 标成已合并。不用 GitHub 的合并按钮：服务端合并会改写提交的作者或提交者身份。
- 一个 PR 只改一件事：移植、改身份、改行为、加功能各自成 PR。移植 PR 的黄金样本必须一致，改行为的 PR 逐条写明差异。
