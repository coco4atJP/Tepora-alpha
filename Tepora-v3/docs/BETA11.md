# beta.11: protected execution boundary and sourced handoffs

> **2026-10-07:** The agent parts of this document describe beta.11 (protected execution, Codex, routines, effect receipts). The agent runtime has since been rebuilt; see [AGENT-HARNESS.md](AGENT-HARNESS.md) for the current design.

This milestone keeps one character in front and asynchronous work behind it. It adds a
small trusted control plane, explicit work-copy capsules, restricted executor protocol,
source/version checks, durable operation receipts, and staged artifact promotion.
It is **not** a finished unrestricted root VM/VPS implementation.

## Working today

- Ordinary conversation, trusted provider/API/file tools and built-in artifact publishing
  remain usable without Docker. New installations default to `protected` mode.
- Public `web_fetch` requires online internet-tool consent and public HTTPS destinations;
  it cannot read loopback, LAN or reserved addresses. Explicit local model, acknowledged
  legacy-host MCP and configured RSS integrations keep their existing scopes.
- Imported routine last-job links are remapped to freshly imported jobs or cleared.
  Imports cannot enable routines or create settings forms. Older stored references are
  escaped, and privileged submissions accept only registered live UI form elements.
  Explicitly re-enabling a routine schedules future work without resuming its imported jobs.
- The character can select bounded prior conversation references for a worker on the same
  already-authorized recipient. Exact source IDs, hashes, task revisions, user decisions
  and latest utterance stay distinguishable. Model plans never become permissions.
- Cross-recipient history is not automatically forwarded. Previously saved consent does not
  authorize the selected-history contract. Stale sources fail closed before model
  transmission, after an approval wait, before execution and before promotion.
- `executor_run` uses a preinstalled, explicitly approved, digest-pinned Node image.
  Docker receives only a JSON capsule over stdin. No core directory, original files,
  backups, Docker socket, credentials, environment secrets or host mounts are passed in.
- The disposable process gets no network, no Linux capabilities, no root, a read-only
  root filesystem, bounded temporary storage/processes/CPU/memory and no-new-privileges.
  No image is pulled and no software is installed automatically. There is no host fallback.
- Capsule provenance and operation starts/results are written to an append-only SQLite
  execution journal. Worker output cannot write the journal or the core through this protocol.
- Executor artifacts remain staged. The character reports the candidate in its normal
  conversation; the person previews exact bytes and promotes a hash/version-bound candidate.
  Promotion and old-version preservation happen in one database transaction. Promotion is
  not acceptance and not independent content verification.
- Exact approved legacy operations use a broker grant bound to task revision, consent epoch,
  action, destination, data hash, expiry and finite use/byte budget. Grants are not created
  by model tool arguments. This is not a universal payment/email/browser broker.
- Approvals no longer time out as refusals. Undecided stackable requests are kept for the
  person and replayed only exactly as approved (same tool, arguments, revision and consent
  epoch); live screen/agent approvals pause instead. See [COMPANION-MONITOR](COMPANION-MONITOR.md).
- A crash, abort, lost connection, unconfirmed container cleanup or unknown operation never
  triggers automatic replay. Reconciliation is an explicit stopped-task operation; it is
  user-reported disposition rather than proof that an external effect was undone.

## First use

Open **設定 → 仕事の実行 → 実行環境を確認**. Protected built-in tools work without an executor image.
To enable restricted code execution, install Docker and a trusted Node-capable image yourself,
then enter the immutable `repository@sha256:...` reference and explicitly approve that image.
The availability check only inspects the installed image; it is not a containment test.
Container execution has no network and cannot install packages. Broad root-capable disposable
VM/VPS workers and automatic provisioning are future adapters, not options hidden behind this UI.

Existing host integrations are kept but require an explicit **legacy-host** risk acknowledgement.
That mode enables uncontained host CLI/Codex/MCP/computer workers/model launchers; it can read or
modify the core and backups, and is not made safe by workspace path checks. Network permissions
and exact action approvals still apply. Switching modes is rejected while jobs/queues or known
host workers are active. Stop them first; already-performed external effects are not rolled back. A mode switch cannot repair core files
already modified by legacy host code or prove that unrelated/background host processes are gone.

Protected live artifact previews show escaped source rather than executing generated HTML.
Interactive HTML remains a legacy-host feature: its browser sandbox protects app origin access,
not a claim that arbitrary scripts cannot navigate or send data. Model-free standalone preview
is also interactive; do not open an untrusted exported HTML file as a security boundary.

## Verified here / not verified here

Local tests use fake model providers, local HTTP, SQLite and a real child-process JSON protocol
fixture. The fixture is explicitly labelled `isolation: none`: it tests serialization, staging,
crash recovery and integration, not OS isolation. The standard gate does not execute Docker, so real container isolation is **not verified**
by these fixture results. No real model, paid API,
Computer Use action, GPU inference, VPS provisioning or model-runtime installation was used
in the branch cutover checks.

Per-candidate user promotion is an interim friction point. Trusted built-in artifacts still
publish automatically as versioned drafts; executor output does not. Task-scoped automatic
promotion and a broad-permission VM with an independently enforced network/effect broker remain
future work. A finite exact-action broker is not permission to send arbitrary future data.

The core still trusts its own process, SQLite, host OS, Docker daemon and configured image.
Append-only SQL triggers prevent accidental journal mutation through normal database operations;
they do not protect against a malicious core owner/administrator, host root or daemon compromise.
No off-device backup or general hostile-host protection is claimed.

## Optional real-container smoke test

After installing and reviewing your own digest-pinned Node image, run:

```sh
node scripts/check-executor.mjs --image repository@sha256:<digest> --approve-image
```

This explicitly executes that image, with no automatic pull. It checks non-root execution,
read-only root, writable temporary storage, missing host sentinel/secret, loopback-only network
interfaces and confirmed cleanup. It is not part of default tests and was not run during the
branch cutover. A smoke pass is not proof against kernel/daemon compromise.
