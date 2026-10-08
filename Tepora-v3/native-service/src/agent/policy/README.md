# ECMAScript approval matcher oracle

The matcher uses pinned `regress 0.11.1` with the `utf16` feature. Compile patterns
from UTF-16 code units with `unicode: false`, then search JSON.stringify output via
`find_from_ucs2`. Rust's `regex` crate and regress's UTF-8 scalar search do not
preserve these JavaScript non-`u` semantics.

Official API references checked for this implementation:
- https://docs.rs/crate/regress/0.11.1/source/README.md
- https://docs.rs/regress/0.11.1/regress/struct.Regex.html
- `regress-0.11.1/src/api.rs` (`Flags`, `Regex::from_unicode`, `find_from_ucs2`)

`native-service/scripts/policy-fixtures.mjs` regenerates 795 fixtures from the
original `validateRules` and `Policy.rule` implementation using Node only at test
fixture generation time. Coverage includes first-rule order, exact/suffix-prefix
matching, case-insensitive lookahead/lookbehind/backreferences, named references,
legacy identity/octal escapes, lone surrogates, astral literals/classes/dot,
non-Unicode case folding, JSON key order, private-use marker collisions, invalid
syntax and note coercion/UTF-16 truncation.

All rules are validated and compiled before admission, even unreachable rules.
Compile failure is a configuration error, never a no-match/implicit permission.
Like the source's backtracking ECMAScript RegExp, this engine does not promise
linear runtime for pathological user-authored regexes. No arbitrary new pattern
length or argument-size policy was added beyond the source's 500 UTF-16-unit
pattern and 100-rule limits.
