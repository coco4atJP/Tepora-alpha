# Tepora Rust state core

This crate owns SQLite persistence for the existing Tepora V3 service: documents,
FTS indexes, durable events, atomic artifact revisions, session transcripts,
evidence, and pending input. It uses the existing database filename and schemas.
There is no data conversion and no JavaScript storage fallback.

The HTTP service, web GUI, provider adapters, execution policy, event listeners,
import validation, lexical tokenization, and portable process-ownership checks
remain in JavaScript during this migration stage.

## Build and test

From this directory, with an official stable Rust toolchain installed:

```sh
cargo test --locked --no-default-features
cargo fmt --check
cargo build --locked
```

From the repository root, `npm run build:core` builds and copies the native
library into the service's ignored binary directory. The `node` feature is
enabled by default and exports the N-API `StateCore` class. Disabling it leaves a
Node-independent Rust library with the `NativeState` API.

## Boundary

`new StateCore(databaseFilename)` opens one connection. Calling
`call(operation, payloadJson)` returns JSON. The Rust equivalent is
`NativeState::open` followed by `call_json`. `NativeState::call` is a convenience
interface for Unicode-only `serde_json::Value` callers; use `call_json` when
reading arbitrary existing JavaScript strings.

The JSON codec retains unpaired UTF-16 surrogate escapes from existing JavaScript
data, escapes its internal markers to prevent collisions, preserves object key
order, and retains floating-point roundtrip precision. Its internal encoding is
never written into stored JSON. Ordinary SQLite TEXT parameters follow Node's
UTF-8 conversion for isolated surrogate units.

Operations are grouped as `kv.*`, `document.*`, `artifact.put`, `event.*`,
`session.*`, `evidence.*`, and `inbox.*`. All operations are synchronous. Composite
writes use savepoints on the same connection, preserving callers' outer
transactions. Session sequence allocation and inbox consumption reserve the
writer before reading. Artifact revision checks and historical copies are one
atomic operation.

`exec` and `sql` provide the narrow compatibility path used by existing outer
transactions and diagnostic fixtures. They are not exposed as HTTP endpoints.
Production document and session methods use the domain operations rather than
generic SQL. `close` is idempotent; later operations fail explicitly.
