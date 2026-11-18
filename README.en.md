# Jianmu (简幕)

[中文](README.md)

Helps you work out within a few minutes whether a long Bilibili or YouTube video is worth watching and which parts matter. Once you decide to watch, it helps you read along closely.

> **Status: being rewritten, not released yet, and there is no package to download.** On Bilibili, the main flow (reading subtitles, generating overviews, Q&A with citations, taking notes, the card on the video page and the settings page), Watch Later triage, generating for every video in the window, 打开就出结论 (verdict on open) and the features listed below are on the main branch, and automated tests run them against locally simulated pages. The developer now uses it day to day on Bilibili. Next, the first Bilibili-only version goes out on GitHub, with YouTube to follow ([PRD](notes/product-prd.md), section 1, in Chinese).

Screenshots and a demo GIF aren't ready yet. They will be added before the first release. <!-- 待定：演示截图和动图 -->

Jianmu is a Chrome extension (Manifest V3). There is no developer backend and no account. You need your own API key. Notes and overviews are kept on your computer, and subtitles and similar content only go to the model service you choose. The interface is in Simplified Chinese.

## Planned features

This describes where the project is heading. Only part of it is built so far, and the [PRD](notes/product-prd.md) (in Chinese) is what defines the scope. The first version supports Bilibili only. YouTube comes in a later version.

- **Verdict on open** (打开就出结论): once you switch it on, any Bilibili video longer than a set length (10 minutes by default) gets an overview and a one-line verdict as soon as you open it, shown right on the card on the video page with no clicking. Tabs opened in the background are queued too, with the one you are watching going first, so the more tabs you open, the more of your API quota it uses. The switch is off on a new install, and you have to agree to the data notice before turning it on. While it is on, the video's subtitles, title and duration, uploader name and description are sent automatically to the model service you chose. Foreign-language videos are not translated automatically.
- **Skim**: a one-line verdict with a recommendation (worth watching, fine to watch, skippable, not enough information), plus timestamped chapters. Expand a chapter to read its subtitles.
- **Close reading**: subtitles follow playback, and you can ask questions, get selected text explained and take timestamped notes at any time. Long videos switch here automatically after a minute of continuous playback.
- **Explain the current frame**: click the icon on the player and Jianmu sends that frame, with a few subtitle lines either side, to a model that can read images, so it can explain the slide, formula, code or chart on screen. The screenshot is used once and never stored.
- **Q&A with citations**: answers come with timestamps and the original subtitle lines. Click one to jump back to the video and check. Citations are verified, and when the evidence is thin the answer says so.
- **Chinese and English side by side**: foreign-language subtitles are translated with your own model. Once started, the whole video is translated in the background, even after you close the side panel, and keeps using your quota until it finishes or you stop it.
- **Tidy subtitles**: speech-recognised subtitles have no punctuation. One click has your own model add punctuation and fix obvious sound-alike mistakes, and nothing else; any line it rewrites is shown as the original. Like translation, it runs to the end in the background once started.
- **Batch decisions**: generate overviews for every Bilibili video open in the current window in one go, and run a quick triage over your Watch Later list.
- **Your own model**: use as strong a model as you like, and set the reasoning effort for each feature separately. New installs start on the cheap settings.
- **Two sites, one tool** (YouTube version): Bilibili and YouTube share one side panel for verdicts, chapters and subtitles. It ships only after it passes checks on real pages.

On Bilibili, Jianmu only reads what a signed-in user can already see, never downloads audio or video, and leaves paid content alone. The rules are in section 8.1 of the [PRD](notes/product-prd.md) (in Chinese).

## Install and update

There is no package yet. The steps below are how it will work after the first release.

Requires Chrome 116 or later. Earlier versions can't install it.

The Chrome versions tested by hand on real pages will be listed before release. <!-- 待定：实机验证过的 Chrome 版本 -->

### Install

1. Go to this repository's [Releases](https://github.com/TIAN-TOM/jianmu/releases) page and download the latest `jianmu-<version>.zip`. The `.sha256` file with the same name lets you check the download is complete.
2. Unzip it into a folder that will stay put, for example one called `jianmu`, so that `manifest.json` sits directly inside it. You will use the same folder for updates, so don't delete or move it.
3. Open `chrome://extensions` in Chrome and turn on Developer mode in the top right corner.
4. Click Load unpacked and choose that folder.
5. Click the Jianmu icon in the toolbar to open the side panel, read the notice and click 启用简幕 (Enable Jianmu). At first the icon sits in the puzzle-piece menu, and you can pin it to the toolbar from there.
6. Open Jianmu's settings page, pick a provider, enter your API key, tick the box to agree to the data notice and click 保存并授权 (save and authorise). The AI features are then ready to use.

### Update

Jianmu doesn't check for new versions itself. To get notified, click Watch on this repository's page and tick Releases under Custom.

1. Download the new zip, unzip it and copy all of its files into your existing folder, replacing the old ones.
2. Open `chrome://extensions` and click the reload button on Jianmu's card.

Your notes, overviews, Q&A and settings are kept. Unless you chose 在这台电脑上记住密钥 (remember the key on this computer), you will need to enter your API key again after updating. Don't remove the extension and load it again: removing it deletes the data Jianmu keeps on this computer.

## Privacy

There is no developer server. Notes, overviews, Q&A, settings and caches are all kept in the browser on your computer. Content such as subtitles, the title and description, your questions, and the frame you ask Jianmu to explain is only sent to the model service you chose after you agree to the data notice. Normally it is sent when you use an AI feature, and with 打开就出结论 switched on it is also sent automatically. See the [privacy policy](PRIVACY.md#english) for details.

## Key design choices

The design below is settled. The code is still being ported.

- **No backend.** The developer never receives users' content, so there are no accounts, no analytics and no server costs. The trade-off is that you bring your own key and pay for your own usage.
- **Site differences stay in the adapter layer.** Overviews, Q&A, tasks and storage are shared by both sites. Site-specific features are optional methods in the contract: when a site lacks one it simply isn't shown, and no data is faked.
- **Only one way to identify a video.** Every key is derived from `{platform, videoId, segment?}`. Subtitles and official summaries carry a content fingerprint, and every result records which version it was based on.
- **Enabling, permissions and consent are handled separately.** Reading on your computer needs your confirmation first, site access depends on browser permissions, and sending to a model needs separate consent. None of them stands in for another.
- **Anything that costs money has a known source and a limit.** A signal from a web page can't trigger a paid request on its own, and nothing is resent automatically after a cancel or a background interruption.
- **A lean toolchain.** TypeScript plus a hand-written esbuild build script. Unit tests run `.ts` files directly in Node, and the core logic doesn't depend on the browser.

For how the code is organised and why, see the [architecture design](notes/architecture.md) (in Chinese).

## Documents

- [PRD](notes/product-prd.md) (in Chinese): what is being built, for whom, the release plan and what counts as done at each step.
- [Architecture design](notes/architecture.md) (in Chinese): code structure, data, testing and build order.

## Development

Requires Node 24.12 or later and npm 11.10 or later.

```bash
npm ci
npm run check
```

Development conventions are in [AGENTS.md](AGENTS.md) (in Chinese). For how to report a security issue, see [SECURITY.md](SECURITY.md) (in Chinese).

## Licence and acknowledgements

Released under the MIT License, see [LICENSE](LICENSE).

YouTube is a trademark of Google LLC. 哔哩哔哩 and bilibili are trademarks of their respective owners. Jianmu is an independent tool made by one person. It is not affiliated with Google, YouTube or Bilibili, and is not authorised or endorsed by them.

Originally forked from [Digest for Bilibili](https://github.com/biuworks/bilibili-digest), now being rewritten.
