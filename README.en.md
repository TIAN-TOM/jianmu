<p align="center">
  <img src="static/icons/icon-128.png" width="96" height="96" alt="Jianmu icon">
</p>

<h1 align="center">Jianmu (简幕): Watch or Skip, Then Study</h1>

<p align="center">Work out in a few minutes whether a long Bilibili or YouTube video is worth watching and which parts matter.<br>Once you decide to watch, it helps you study it closely.</p>

<p align="center">
  <a href="https://github.com/TIAN-TOM/jianmu/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/TIAN-TOM/jianmu/actions/workflows/ci.yml/badge.svg?branch=main"></a>
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/license-MIT-blue"></a>
  <img alt="Requires Chrome 116 or later" src="https://img.shields.io/badge/Chrome-116%2B-4285F4?logo=googlechrome&amp;logoColor=white">
</p>

<p align="center"><a href="README.md">简体中文</a> · English</p>

> [!NOTE]
> The first version hasn't been released yet. The package will go on the [Releases](https://github.com/TIAN-TOM/jianmu/releases) page. To hear about it first, click Watch at the top right of this page and tick Releases under Custom.

![Demo: the card beside the player shows a recommendation and a one-line verdict; the side panel opens and a key chapter expands to its summary and subtitles; in Study, a question gets an answer with timestamps, and clicking one jumps the video there](.github/assets/demo-en.gif)

Jianmu is a Chrome extension (Manifest V3). Open a long video and it tells you first whether it's worth your time and where the key parts are. If you decide to watch, the subtitles follow playback and you can ask questions or take notes as you go. There is no developer backend and no account. You use your own API key, notes and overviews stay on your computer, and subtitles and similar content only go to the model service you choose.

## Features

- **Verdict on open**: once you switch it on, any video longer than a set length (10 minutes by default) gets an overview and a one-line verdict as soon as you open it, shown on the card beside the player with no clicking.
- **Skim**: a one-line verdict comes with a rating from 1 star (Skip) to 5 stars (Must watch). A 3-star verdict marks the key chapters and their timestamps. If there’s too little material to judge, you’ll see “Not enough info”. Expand a chapter to read its subtitles.
- **Study**: subtitles follow playback, and you can ask questions, get selected text explained and take timestamped notes at any time. Long videos switch here automatically after a minute of continuous playback.
- **Q&A with citations**: answers come with timestamps and the subtitle lines they quote. Click one to jump back to the video and check. Citations are verified, and when the evidence is thin the answer says so.
- **Explain this frame**: click the icon on the player and Jianmu sends that frame, with a few subtitle lines either side, to a model that can read images, so it can explain the slide, formula, code or chart on screen. The screenshot is used once and never stored.
- **Translation**: subtitles are translated with your own model and shown beside the original.
- **Tidy up subtitles**: speech-recognised subtitles have no punctuation. One click has your own model add punctuation and fix obvious sound-alike mistakes, and nothing else. Any line it rewrites is shown as the original.
- **Batch decisions**: Generate all in this window writes overviews for every video open in the current window in one go, and Watch Later triage shows videos in the same order as your Bilibili Watch Later list. You can filter by star rating or export the list grouped by rating, highest first.
- **Your own model**: use as strong a model as you like, and set the reasoning effort for each feature separately. New installs start on the cheap settings.
- **Two sites, one tool**: Bilibili and YouTube share one side panel for verdicts, chapters and subtitles.
- **Three languages**: the interface and what the model writes (overviews, verdicts, answers and explanations) can be in Simplified Chinese, Traditional Chinese or English.

## Screenshots

The video, channel and subtitles in the animation and screenshots were made up for the demo. The made-up lecture is in Chinese, so its title, subtitles and quoted lines stay in Chinese in the animation above, which otherwise shows the English interface. The screenshots below show the Chinese interface.

<p>
  <img src=".github/assets/skim.png" width="49%" alt="Skim view: a one-line verdict with a star rating, timestamped chapters with the key ones marked, and an expanded chapter showing its summary and subtitles">
  <img src=".github/assets/study-qa.png" width="49%" alt="Close reading: subtitles highlighted as the video plays, and an answer with timestamps and the subtitle lines it cites">
</p>
<p>
  <img src=".github/assets/card.png" width="49%" alt="The card beside the player: a star rating in the header, then the reason and summary, chapters and a question box">
  <img src=".github/assets/settings-ai.png" width="49%" alt="Settings: choose the AI service and model, and set the reasoning effort for each feature">
</p>

## Before you start

- **Key and costs**: you need your own API key, and you pay the model service for what you use.
- **Verdict on open**: the switch is off on a new install, and you have to agree to the data notice before turning it on. While it is on, for videos on Bilibili and on YouTube once it's turned on, the video's subtitles, title and length, creator or channel name, and description are sent automatically to the model service you chose. Tabs opened in the background are queued too, with the one you are watching going first, so the more tabs you open, the more of your API quota it uses. Foreign-language videos are not translated automatically.
- **Translation and tidying**: once started, the whole video is done in the background, even after you close the side panel, and keeps using your quota until it finishes or you stop it. Translation follows the language setting. With it set to English, English subtitles are translated into Simplified Chinese and everything else into English. With it set to Simplified or Traditional Chinese, Chinese subtitles in either script go into English and everything else into the Chinese you chose.
- **Language**: choose under Language in the Appearance section of Settings. By default it matches the browser: Traditional Chinese if the browser uses Chinese as written in Taiwan, Hong Kong or Macao, Simplified Chinese for other Chinese, and English otherwise. Traditional Chinese follows Taiwanese usage. Anything already generated stays in the language it was written in.
- **Bilibili**: Jianmu reads subtitles and official summaries only for signed-in users (while signed out it reads just the video details such as title and length), never downloads audio or video, and leaves content confirmed as paid alone. The rules are in section 8.1 of the [PRD](notes/product-prd.md) (in Chinese).
- **YouTube**: you first click Turn on for YouTube in the side panel or in Settings, and Jianmu runs on YouTube pages only after you grant access. On a video, click Read subtitles in the side panel, and Jianmu opens the transcript on the page for you, reads it and closes it again. If the page has no transcript, Jianmu reads the subtitles in the player instead, turning them on for you if needed and off again afterwards. Verdict on open and Generate all in this window work on YouTube too and read subtitles the same way. On YouTube, Jianmu sends no requests to the platform. It reads what the transcript already shows, plus the list of subtitle tracks the player already has (to mark the language and whether it was auto-generated). When the page has no transcript, it reads the subtitles the player has loaded itself. While reading, it leaves the player alone, except for turning subtitles on and off in that case. The rules are in section 8.2.

## Install and update

There is no package yet. The steps below are how it will work after the first release.

Requires Chrome 116 or later. Earlier versions can't install it.

The Chrome versions tested by hand on real pages will be listed before release. <!-- 待定：实机验证过的 Chrome 版本 -->

### Install

1. Go to this repository's [Releases](https://github.com/TIAN-TOM/jianmu/releases) page and download the latest `jianmu-<version>.zip`. The `.sha256` file with the same name lets you check the download is complete.
2. Unzip it into a folder that will stay put, for example one called `jianmu`, so that `manifest.json` sits directly inside it. You will use the same folder for updates, so don't delete or move it.
3. Open `chrome://extensions` in Chrome and turn on Developer mode in the top right corner.
4. Click Load unpacked and choose that folder.
5. Click the Jianmu icon in the toolbar to open the side panel, read the notice and click Turn on Jianmu. At first the icon sits in the puzzle-piece menu, and you can pin it to the toolbar from there. Right-click the icon to open Watch Later triage directly, or to switch the card on the video page and Verdict on open on or off.
6. Open Jianmu's settings page, pick a provider, enter your API key, tick the box to agree to the data notice and click Save. The AI features are then ready to use.

### Update

Jianmu doesn't check for new versions itself. To get notified, click Watch on this repository's page and tick Releases under Custom.

1. Download the new zip, unzip it and copy all of its files into your existing folder, replacing the old ones.
2. That's it. Jianmu notices that its files have changed and reloads itself, usually the next time you use it. If an overview, translation or similar job is running, or you're exporting, restoring a backup or clearing data, it waits for that to finish first. The side panel and Settings close when it reloads, and reopening them gives you the new version. To switch over straight away, open `chrome://extensions` and click the reload button on Jianmu's card.

Your notes, overviews, Q&A and settings are kept. Unless you ticked Remember the key on this computer, you will need to enter your API key again after updating. Don't remove the extension and load it again: removing it deletes the data Jianmu keeps on this computer.

## Privacy

There is no developer server. Notes, overviews, Q&A, settings and caches are all kept in the browser on your computer. Content such as subtitles, the title and description, your questions, and the frame you ask Jianmu to explain is only sent to the model service you chose after you agree to the data notice. Normally it is sent when you use an AI feature, and with Verdict on open switched on it is also sent automatically. See the [privacy policy](PRIVACY.md#english) for details.

## Why it's built this way

- **No backend.** The developer never receives users' content, so there are no accounts, no analytics and no server costs. The trade-off is that you bring your own key and pay for your own usage.
- **Site differences stay in the adapter layer.** Overviews, Q&A, tasks and storage are shared by both sites. Site-specific features are optional methods in the contract: when a site lacks one it simply isn't shown, and no data is faked.
- **Only one way to identify a video.** Every key is derived from `{platform, videoId, segment?}`. Subtitles and official summaries carry a content fingerprint, and every result records which version it was based on.
- **Enabling, permissions and consent are handled separately.** Reading on your computer needs your confirmation first, site access depends on browser permissions, and sending to a model needs separate consent. None of them stands in for another.
- **Anything that costs money has a known source and a limit.** A signal from a web page can't trigger a paid request on its own, and nothing is resent automatically after a cancel or a background interruption.
- **A lean toolchain.** TypeScript plus a hand-written esbuild build script. Unit tests run `.ts` files directly in Node, and the core logic doesn't depend on the browser.

For how the code is organised and why, see the [architecture design](notes/architecture.md) (in Chinese).

## Contributing

- [PRD](notes/product-prd.md) (in Chinese): what is being built, for whom, the release plan and what counts as done at each step.
- [Architecture design](notes/architecture.md) (in Chinese): code structure, data, testing and build order.
- [Contributing guide](.github/CONTRIBUTING.md#contributing-to-jianmu): how to report a problem and how to send a pull request. Development conventions are in [AGENTS.md](AGENTS.md) (in Chinese), and how to report a security issue is in [SECURITY.md](SECURITY.md) (in Chinese).

Requires Node 24.12 or later and npm 11.10 or later.

```bash
npm ci
npm run check
```

## Licence and acknowledgements

Released under the MIT License, see [LICENSE](LICENSE).

YouTube is a trademark of Google LLC. 哔哩哔哩 and bilibili are trademarks of their respective owners. Jianmu is an independent tool made by one person. It is not affiliated with Google, YouTube or Bilibili, and is not authorised or endorsed by them.

Acknowledgements: Jianmu started from [Digest for Bilibili](https://github.com/biuworks/bilibili-digest), which in turn builds on [youtube-digest](https://github.com/zarazhangrui/youtube-digest).
