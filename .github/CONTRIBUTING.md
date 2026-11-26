# 参与简幕

[English](#contributing-to-jianmu)

简幕是一个人业余维护的项目。会尽量回复 issue 和 PR，但不保证时间。

## 报问题、提建议

- 用 [issue 表单](https://github.com/TIAN-TOM/jianmu/issues/new/choose)：出了问题、想要一个功能、使用问题各有一张。
- 安全漏洞走[私密漏洞报告](https://github.com/TIAN-TOM/jianmu/security/advisories/new)，规矩见 [SECURITY.md](../SECURITY.md)。
- 不要在 issue、PR 和截图里留 API 密钥、Cookie 或其他凭证。

## 改代码

1. 先开 issue 说清想改什么、为什么，等回复再动手，免得做了用不上。拼写和文档错误可以直接开 PR。
2. 开发约定都在 [AGENTS.md](../AGENTS.md)：目录分层、命令、提交信息格式，还有「公开内容的边界」一节。这是公开仓库，平台接口只按能力描述，测试样例一律自己造，这几条请先读一遍。
3. 一个 PR 只改一件事。提交前跑一遍：

   ```bash
   npm ci
   npm run check
   ```

4. 改了界面上能看到的东西，在 PR 里附上改动前后的截图。

提交的代码按本仓库的 [MIT 许可](../LICENSE)发布。

---

# Contributing to Jianmu

Jianmu is maintained by one person in their spare time. Issues and pull requests get a reply when time allows, with no set turnaround.

## Reporting problems and asking for features

- Use the [issue forms](https://github.com/TIAN-TOM/jianmu/issues/new/choose): there is one for bugs, one for feature requests and one for questions.
- Report security issues through a [private vulnerability report](https://github.com/TIAN-TOM/jianmu/security/advisories/new). See [SECURITY.md](../SECURITY.md) for scope.
- Leave API keys, cookies and other credentials out of issues, pull requests and screenshots.

## Changing the code

1. Open an issue first to say what you want to change and why, and wait for a reply before starting, so the work doesn't go to waste. Typo and documentation fixes can go straight to a pull request.
2. The development conventions are in [AGENTS.md](../AGENTS.md) (in Chinese): module layers, commands, commit message format and the section on what may go into this public repository. In short, describe platform interfaces only by what they do, and make up all test data yourself.
3. Keep each pull request to one change, and run this before you push:

   ```bash
   npm ci
   npm run check
   ```

4. If you change something visible in the interface, add before and after screenshots to the pull request.

Contributions are released under the repository's [MIT licence](../LICENSE).
