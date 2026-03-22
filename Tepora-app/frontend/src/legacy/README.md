# Legacy Frontend Archive

`src/legacy/` is an archive of the retired V1 frontend.

- It is not part of the runtime path.
- It is excluded from active TypeScript, Vitest, and ESLint targets.
- Do not route new production code through this tree.
- If behavior from this archive is still needed, port it into `src/app/`, `src/features/`, or `src/shared/` instead of reviving the old path in place.

This directory is kept only for reference while the canonical frontend continues from `/` and `/settings`.
