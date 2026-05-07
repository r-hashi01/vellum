# vellum

DOM → high-quality PDF in the browser. Hybrid: **raster background (JPEG of the page with text invisibly suppressed) + vector text overlay (positioned via Range API)**. The full design is in `PLAN.md` at the repo root — read it before making non-trivial decisions.

## Core invariants (do not break)

- **Browser-only.** No Node-specific code in `@vellum/core`. The library must run on a static host (e.g. Cloudflare Pages) without a server.
- **Text is real PDF text**, not pixels. The whole point of this project is selectable / searchable / copyable text. Anything that compromises that is a regression.
- **Failures must be visible, never silent.** If text extraction misses a node, the rasterized background still shows the text — the user sees a degraded but not lost result. Don't add fallbacks that hide problems.
- **Single source of truth for coordinate scaling.** Source DOM dimensions → PDF page dimensions is one transform, applied in exactly one place. Don't sprinkle scale factors across the pipeline.
- **No dependency on Dify-Deck-Template / astlide.** This is a generic library; consumers shape their own DOM.

## Repo layout

```
vellum/
├── PLAN.md               # full design doc (read this first)
├── packages/
│   ├── core/             # @vellum/core — Walker + Rasterizer + PDF Emitter
│   ├── validator/        # @vellum/validator — placeholder
│   ├── react/            # @vellum/react — placeholder
│   └── astro/            # @vellum/astro — placeholder
├── examples/             # `pnpm example` — vite-served playground for manual visual verification
├── .github/workflows/    # CI (ci.yml: lint + typecheck + build + browser test)
├── .claude/              # session-start hook + per-project Claude settings
├── package.json          # pnpm workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json    # shared strict TS config
├── biome.json            # lint + format
└── CLAUDE.md             # you are here
```

Only `@vellum/core` is active. The other three are stubs (private, no implementation) until their phase begins.

## Toolchain

- **Package manager:** pnpm workspace. Always use `pnpm`, not `npm` / `yarn`.
- **Build:** `tsup` (ESM-only, `.d.ts` emitted). Browser-targeted.
- **Test:** `vitest` in **browser mode** via `@vitest/browser` + `playwright` (Chromium). The library uses `Range.getClientRects()`, `getComputedStyle`, `document.fonts` etc. — jsdom/happy-dom return wrong values, so node-mode tests are useless here.
- **Lint/Format:** `biome` (one config, fast). `pnpm lint` / `pnpm format`.
- **TypeScript:** `strict: true` + `noUncheckedIndexedAccess`. Module resolution is `Bundler`, output is ESM.
- **Node:** ≥ 20 (for tooling only — runtime is the browser).

## Common commands

```bash
pnpm install              # install everything
pnpm build                # build all packages (currently just @vellum/core)
pnpm test                 # run tests (boots a real Chromium via Playwright)
pnpm typecheck            # tsc --noEmit across packages
pnpm lint                 # biome check
pnpm format               # biome format --write
pnpm example              # vite-served playground in examples/ for manual visual verification

# Per-package:
pnpm --filter @vellum/core build
pnpm --filter @vellum/core test
```

First-time test runs need Playwright browsers: `pnpm exec playwright install chromium`.

## CI / CD

**CI:** `.github/workflows/ci.yml` runs on every push to `main` and on every PR. Two parallel jobs:

- `check` — `pnpm lint` + `pnpm typecheck` + `pnpm build`
- `test` — `pnpm test` (Playwright Chromium, with browser binaries cached by `pnpm-lock.yaml` hash)

Both jobs use Node from `.nvmrc` and `pnpm install --frozen-lockfile`, so the lockfile is the source of truth — never let CI run with a drifted lockfile. If you bump a dep, commit the updated `pnpm-lock.yaml` in the same PR.

**CD (npm publish):** intentionally **not wired up**. The recommended path when it's time:

- `changesets` for version + changelog management (works well with pnpm workspace)
- A `release.yml` workflow that consumes a `NPM_TOKEN` secret to publish `@vellum/core`
- The other `@vellum/*` packages stay `private: true` until their phase ships

Don't add CD pre-emptively. An npm token + accidental publish on `main` is a real failure mode.

## Volatile state (do NOT add it to this file)

Anything that changes as the project advances — current phase, version, list of in-progress modules, what's uncommitted, what's next — is **auto-injected at session start** by `.claude/hooks/session-status.sh`. That hook reads `git log`, `package.json` version, and the file tree, then prints a status block into this session's context.

The roadmap itself lives in `PLAN.md` § 9.

This file (`CLAUDE.md`) only changes when the project's *nature* changes: invariants, toolchain, layout, conventions, philosophy. Don't put a "current phase" line here — it will go stale.

## Performance philosophy

Measure first, optimize second. Specifically:

- **The slowest stage (rasterization) is browser-native code** — it cannot be replaced by WASM. WASM is on the table only for targeted hot paths (font subsetting via harfbuzzjs, deflate, pixel-diff in self-check) and only after profiling shows a problem.
- **Web Worker / OffscreenCanvas parallelism is the default scaling story** for multi-page decks. Design the `Rasterizer` interface so its inputs are serializable (no live DOM references in/out of the worker boundary). This unlocks parallelism without committing to Workers in v1.
- Cache aggressively across pages within one PDF generation: union font glyph sets before subsetting once, reuse `embedJpg` results for repeated images.
- Don't add WASM dependencies pre-emptively — bundle size is a real cost for a static-host library.

## Conventions

- New files in `@vellum/core/src/`: ESM, `.ts`. Local imports are extensionless (`from './foo'`) — `moduleResolution: Bundler` resolves them, and tsup/esbuild handles emit. Do **not** add `.js` suffixes.
- Prefer pure functions over classes. The pipeline is: `walk(page) → spans`, `capture(page) → raster`, `emit(spans, raster) → PDF`. Each stage should be testable in isolation.
- Don't mutate the user's DOM permanently. Style injection for the transparency trick must be reverted in a `finally` block, even on throw.
- No `console.log` in shipped code. Use a typed `onProgress` / `onWarning` hook on the public API.
