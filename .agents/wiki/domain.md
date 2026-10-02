# Tepora V3 beta.11 terminology

- **Character session**: persistent foreground dialogue independent of job navigation.
- **Worker job**: asynchronous work with its own persona, inputs, route, permissions and revision.
- **Persona**: style/instructions pinned at execution time; it does not grant authority.
- **Capsule**: bounded immutable selected context with source identity, hashes and revisions.
- **Candidate**: untrusted executor artifact staged for explicit hash/version-bound promotion.
- **Artifact**: versioned output; promotion and task acceptance are separate from independent verification.
- **Memory**: scoped local source records and optional endpoint-bound embeddings, not automatically injected into new character/worker contexts.
- **Unknown effect**: an operation whose outcome cannot be confirmed and must not be automatically replayed.
