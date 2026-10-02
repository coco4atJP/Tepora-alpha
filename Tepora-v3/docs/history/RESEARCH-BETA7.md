> Historical Earlier V3 beta document. The current release is **3.0.0-beta.11**; use the [current guide](../../../README.md). This record does not describe the default application.

# Research → design → implemented tests (beta.7)

Research checked for the September 2026 request. Only first-party documentation, source and issues
were used for technical choices. Issue reports are **reports for their stated versions**, not proof
that every current version has the same fault. Published performance numbers were not imported as
Tepora measurements. No product-wide benchmark superiority is claimed.

| Primary source | Observation supported by source | Tepora decision / evidence |
|---|---|---|
| https://opencode.ai/docs/providers/ | Named providers, custom base URLs, local models; broad ecosystem relies on per-provider integrations. | Four explicit wire protocols, not a claim of matching all providers. `provider-protocols.mjs`; routing-policy canonical tool tests. |
| https://hermes-agent.nousresearch.com/docs/user-guide/features/fallback-providers/ | Main and auxiliary fallback policies differ; a last-resort path can matter independently of the chosen primary. | One trust policy and explicit role chains, no built-in implicit third-party fallback. `network-policy.mjs`; credential/mode tests. |
| https://github.com/NousResearch/hermes-agent/issues/19002 | User requests one auditable way to stop scattered fallback paths from sending data to third parties. | All managed calls share policy, including vision/feeds/workers; uncontained external apps are blocked in restricted modes. |
| https://github.com/NousResearch/hermes-agent/issues/40565 | A user reports auxiliary→main fallback disturbing a single-slot local model's cache and latency. | Explicit auxiliary roles; Laya never occupies main by silent fallback; shared resource admission. No equivalent speedup claimed. |
| https://github.com/NousResearch/hermes-agent/issues/35419 | A user reports successful fallback without a delivered user-facing notification. | `route.selected` persists destination and one bounded visible notice; tests verify selected profile sequence. |
| https://github.com/anomalyco/opencode/issues/25229 | Missing/undocumented input modalities can make custom vision models unusable or silently strip images. | Unknown vision stays unknown; real pixel content encoded per protocol; clear capability config and image tests. |
| https://github.com/NousResearch/hermes-agent/issues/78884 | Picker can expose text-only models for vision; failure appears at runtime. | Filter vision selection and validate the route on save; fail closed if no permitted VLM. |
| https://developers.openai.com/api/docs/guides/tools-computer-use | Computer Use requires an execution environment and observation/action loop; custom control/code tools can be used. | Owned browser/UIA controller; shortlist decisions separate from permission and post-action observation. Real controlled-browser integration. |
| https://learn.chatgpt.com/docs/permissions | Permissions/sandbox/network scope must be interpreted for the actual execution environment. | Do not label host CLI or native UIA as offline-contained. Keep Codex and host execution separate from browser-worker calculation. |
| https://playwright.dev/python/docs/network | Request routing, isolated browser contexts and network controls. | Parent-brokered public requests, exact origin allowlist, no preexisting login profile. Public authenticated-site completion remains untested. |
| https://pywinauto.readthedocs.io/en/latest/getting_started.html | Windows UIA can identify/control selected application elements. | Optional selected-window implementation, no free desktop coordinate controller. Windows-specific operation remains untested here. |
| https://github.com/NandhaKishorM/laya | Typed multilingual decisions and explicit model/runtime configuration; upstream calibration caveats. | `laya-multilingual` retained as advisory shortlist scorer; not an authorizer, VLM or general text editor. |

## Resulting architectural choices

1. **Local is a complete permitted execution route, not merely an emergency endpoint string.** The
   task's model, image interpretation, managed network and permitted tools must all agree on the mode.
2. **Provider freedom is not freedom to redirect user data without consent.** Routing snapshots and
   explicit rebind separate user-directed switching from transient-failure fallback.
3. **Auxiliary composition has limits.** Text describing an image can help a strong text model but is
   lossy; the derived text can still contain private information. No universal model ranking follows.
4. **Use the cheapest adequate observation, not the cheapest unverified action.** Accessibility text,
   candidate ranking, pixels only when needed, then observe after acting. Classification confidence
   never substitutes for permission or measured success.
5. **Retry budgets and observable progress matter more than agent count.** Keep failures bounded,
   preserve checkpoints and unknown effect states, and protect the conversation from auxiliary work.

See `docs/BETA7.md` and `spec/answers.mjs` for scope limits and test locations. The 100 fictional
personas/scenarios are design requirements, not research participants or empirical user studies.
