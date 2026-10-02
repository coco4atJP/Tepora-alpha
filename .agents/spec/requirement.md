# Tepora V3 beta.11 requirements

The original V3 scenario specification and its digest are preserved in `Tepora-v3/spec/`. [Current status](../../Tepora-v3/docs/STATUS.md) distinguishes implemented mechanics from remaining acceptance work.

The main conversation stays with one character while independent workers execute tasks. Worker questions and reports retain provenance and revisions. Users control model destinations, selected sources, operation approvals and artifact acceptance. Unknown external effects are not replayed automatically.

Core startup requires Node.js 22.16.0+; SQLite stores local state. Python capabilities and the Tauri/Rust desktop host are optional. Runtime provisioning, trained-model quality and full scenario acceptance are not established by deterministic regression tests.
