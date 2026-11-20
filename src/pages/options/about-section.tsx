// 设置页「关于」一节：装的是哪一版、哪一次构建，以及隐私政策和反馈问题的链接。不受构建开关控制，启用前后都有。
import { useId } from "preact/hooks";
import { BUILD_ID } from "../../shared/build-id.ts";
import { ISSUES_URL, PRIVACY_POLICY_URL } from "../../shared/names.ts";

export function AboutSection({ version }: { readonly version: string }) {
  const id = useId();
  return (
    <section class="card" id="about" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>关于</h2>
      <dl class="about-facts">
        <dt>版本</dt>
        <dd>
          <span id="aboutVersion">{version}</span>
          <span class="about-build" id="aboutBuild">
            {BUILD_ID}
          </span>
        </dd>
      </dl>
      <p class="about-links">
        <a id="aboutPrivacy" href={PRIVACY_POLICY_URL} target="_blank" rel="noopener noreferrer">
          隐私政策
        </a>
        <a id="aboutIssues" href={ISSUES_URL} target="_blank" rel="noopener noreferrer">
          反馈问题
        </a>
      </p>
    </section>
  );
}
