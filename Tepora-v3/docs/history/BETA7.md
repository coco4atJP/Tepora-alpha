> Historical Earlier V3 beta document. The current release is **3.0.0-beta.11**; use the [current guide](../../../README.md). This record does not describe the default application.

# beta.7 — implementation and evidence ledger

Baseline: the verified **beta.6 source archive**, not the old remote beta.1 branch. The original
100-scenario file is retained byte-for-byte under `spec/` with its SHA-256. Scope is routing,
connectivity, local vision, bounded Computer Use, and continued work under changing availability.

## Boundaries that changed

The provider/model and the destination's trust domain are separate. A LAN endpoint is not automatically
trusted because it has a private IP. It must match an explicitly pinned profile's origin, port and API
subtree. A cloud HTTP proxy may not redirect credentials or resolve to a private/metadata address.
A same-PC endpoint does not require external DNS. A policy change cancels active disallowed requests
before acknowledging the narrower policy. This is managed egress policy, not an OS firewall.

Roles and fallback chains are saved independently. A job captures its allowed recipients; current
mode can narrow, never silently widen, that set. A new offline job is admitted with only current
allowed recipients, so later turning on Internet does not grant it a cloud destination. Conversation
and child-work role choices are pinned together. Explicit stopped-job rebinding uses consent and an
expected revision, refuses unknown effects, and keeps reconstructible messages/tool results.

The four protocol adapters preserve opaque provider continuation fields only for the matching provider
identity. Authentication failures, refused content and broken protocol responses are not reasons to
switch to an unrelated provider. Transient availability failures can use the configured chain, with
shared cooldowns and bounded deadlines. Route changes are displayed and recorded.

A local VLM receives real pixel bytes. A text-only main receives a lossy description with image hash,
model, provider and observation time. It remains untrusted evidence with the same privacy scope.
No claim is made that this preserves all spatial detail or matches a native multimodal main model.

## Computer Use

`Computer` brokers an owned browser or selected Windows UIA window. Observed controls include IDs,
permitted operations and a revision. Both parent and worker check observations. Optional Laya ranks
only a supplied shortlist plus `none`; it does not execute or grant permission. Password fields are
masked and excluded. Browser network is limited to granted HTTPS origins and routed through common
policy; background mutations and WebSockets are rejected. Local offline HTML has no network.

After one explicit opening grant, actions in the job's bounded offline document do not require
one approval per click. External/native actions still do. Releasing/disconnecting the session aborts
its broker requests. The grant ends on release, expiry, job end or worker failure.

`code_compute` runs a bounded JavaScript function over explicit JSON in a disposable browser worker.
No Node process/require, Python host API, DOM window/document or file handles are passed. Its network
is disabled and an infinite program is terminated at the wall deadline. V8 heap flags are not an OS
resident-memory guarantee, and no “perfect sandbox against all exploits” claim is made.

## Always-on engineering, without a 24/7 certification claim

- Bounded task queue, per-resource inference queue, deadline, session age/action budgets and VLM cache.
- Shared circuit cooldown and request admission with conversation priority and ageing.
- At most five persisted recovery attempts for eligible provider failures; bounded backoff and batch size.
- No automatic retry of operations with uncertain external effects; no foreground context replacement.
- Initial local setup adopts a successfully probed model into the named registry rather than making the
  user configure the same connection twice.
- Manual/global stop, permission change and worker disconnect remain explicit interruption boundaries.

No day/week-long soak test, actual GPU scheduling or end-user task-success comparison was performed.
Durable histories still need deliberate retention/export policies for very long-running installations.

## Executed verification levels

1. **Node regression/contract tests:** real SQLite, local HTTP transport, files, subprocess semantics;
   learned model responses are fixtures. Includes cloud→local mode change, private DNS rejection,
   exact LAN scope, credential isolation, malformed responses, role pinning, stopped-task rebind,
   bounded recovery, image privacy and independent Computer Use permission checks.
2. **Python Laya/speech contracts:** fixed fake recognizers; not ASR accuracy or Laya calibration.
3. **Owned-browser integration:** real Chromium, Python RPC, Node harness, local HTTP decision fixture,
   controlled form actions, offline JS, checked artifact. No learned model, external website or login.
4. **Frontend:** explicit offline preview at 1440×1000 and 390×844, 180% text, modes/profiles/roles,
   first-use/draft/image selection/privacy, and scoped Computer Use settings. No native-WebView claim.
5. **Distribution:** extracted ZIP files and hashes, fresh regression gate, byte-identical regenerated
   preview; logs stored separately from source. Final handoff records exact counts and hashes.

## Reproductions fixed in this iteration

- An encoded API path could attempt to leave a permitted base path. Canonicalize and reject ambiguous
  encodings before accepting the exact subtree. Tests reject direct and nested-encoded traversal.
- A mode change could leave cloud partial text in the UI before a local fallback answered. Clear that
  partial on the fallback boundary and keep route history.
- A child task could use a newly edited global work route. Pin its delegated recipients at parent consent.
- A fallback request could retain a key after endpoint retargeting. Identity changes clear that key.
- Initial named-provider support could strand legacy onboarding in a separate configuration system.
  Verified local setup now registers the first local baseline, while later changes use the registry.
- Provider-form submission did nothing because a control named `id` shadows HTMLFormElement.id.
  Use `getAttribute('id')` and keep the browser regression that found it.
- The first offline computation implementation did not accept async bodies. Use a bounded async function;
  rerun blocked-network and infinite-loop tests, not only the happy-path calculation.
- Computer worker disconnect could leave a broker request pending. Abort its session controller and
  release ownership; test separately from explicit close.

These are reproduction/fix/retest loops, not a test-count-based PDCA claim.
