# Test-only historical Rust migration oracle

These four modules preserve the immutable checkpoint published as commit
`44a5ec0bd0bb6973da275d2956540bd3a91ecadf` (tree-identical to the original local source
`f9ba118404ed7240a370171b75c1e4d7c59350ee`). The original paths are in
each module header. Only relative imports and these provenance headers differ.

They are independent historical comparison implementations for
`tests/rust-context.test.mjs` and `tests/rust-protocols.test.mjs`, not a
production fallback. Production code must never import this directory.
The context oracle imports the copied token estimator and historical image-cost
helper. Only the unchanged policy and formatting helper remain production imports.

Keep the oracle immutable when fixing migrated behavior; update test cases or
record an intentional contract change instead of silently changing the oracle.
