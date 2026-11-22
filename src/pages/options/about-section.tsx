// 设置页「关于」一节：装的是哪一版、哪一次构建，以及更新记录、源码、隐私政策和反馈问题的链接。不受构建开关控制，启用前后都有。
import { useId } from "preact/hooks";
import { BUILD_ID } from "../../shared/build-id.ts";
import { ISSUES_URL, PRIVACY_POLICY_URL, RELEASES_URL, SOURCE_URL } from "../../shared/names.ts";
import { optionsText } from "./text.ts";

export function AboutSection({ version }: { readonly version: string }) {
  const t = optionsText().about;
  const id = useId();
  return (
    <section class="card" id="about" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>{t.title}</h2>
      <dl class="about-facts">
        <dt>{t.version}</dt>
        <dd>
          <span id="aboutVersion">{version}</span>
          <span class="about-build" id="aboutBuild">
            {BUILD_ID}
          </span>
        </dd>
      </dl>
      <p class="about-links">
        <a id="aboutReleases" href={RELEASES_URL} target="_blank" rel="noopener noreferrer">
          {t.releases}
        </a>
        <a id="aboutSource" href={SOURCE_URL} target="_blank" rel="noopener noreferrer">
          {t.source}
        </a>
        <a id="aboutPrivacy" href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer">
          {t.privacy}
        </a>
        <a id="aboutIssues" href={ISSUES_URL} target="_blank" rel="noopener noreferrer">
          {t.issues}
        </a>
      </p>
    </section>
  );
}
