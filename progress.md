# Progress

Working notes — captured at the end of a session so the next one can pick up cold. Append-only history; the most recent entry is at the top.

---

## 2026-05-07 (later) — Phase 2 (b) shipped

### What landed

Two fixes, both visually verified in `pnpm example` on the Phase 1 (Times) and Phase 2 (Inter) slides:

1. **Walker preserves boundary whitespace.** `normalizeLineWhitespace` now takes `keepLeadingSpace` / `keepTrailingSpace` flags driven by `hasContentSibling()`. A text node adjacent to an inline sibling (e.g. text + `<b>` + text) no longer trims the boundary space, so copy-paste yields `"Hello bold and code!"` instead of `"Helloboldandcode!"`. Block-level boundaries still trim source-HTML indentation as before. Locked by `extractSpans > preserves a single space between inline siblings`.

2. **Snap-to-previous layout planner (`layout.ts`).** A pure function `planInlineLayout(items)` groups spans by baseline, sorts by x, and — when `span.x ≈ prev.x + prev.w` (within 1.5px DOM, i.e. inline-adjacent) — snaps the next span's draw-x to where the previous span's PDF glyphs actually end. This eliminates the visible gap that opened at every `<b>` / `<code>` / `<i>` boundary because PDF font metrics ≠ CSS-rendered font metrics. The drift is small per character but accumulates visibly at every inline boundary.

`emit.ts` now does a two-pass loop per page: pass 1 encodes each span and measures `font.widthOfTextAtSize(safeText, …)` to convert drawn width into DOM units; pass 2 draws each span at the planned x. The planner stays pure / serializable — no live DOM, no PDF objects — so it remains compatible with the eventual Worker boundary.

### Tests

7 new tests in `layout.test.ts` (single span, snap, compound snap, gap-preserved, line-break-not-snapped, input-order-preserved, baseline-tolerance). Suite: **55/55**, lint/typecheck/build green.

### Known issue (deferred)

`html-to-image` logs `SecurityError: Cannot access rules` when rasterizing pages that link cross-origin stylesheets (Google Fonts CSS). This is a raster-side warning only — the JPEG still renders, the vector text layer is unaffected. Look at it when we revisit `capture.ts`.

---

## 2026-05-07 — Phase 2 (a) shipped, Phase 2 (b) in progress

### Phase milestones

- ✅ **Phase 0 (PoC)** — DOM → PDF pipeline, raster + vector hybrid, per-stage timing. (commit `0cad936`)
- ✅ **Phase 1 (MVP)** — standard PDF font auto-mapping (Helvetica / Times / Courier × bold / italic), publish-ready package metadata + README, version `0.1.0`, `pnpm pack` verified. (commit `8e797b6`)
- ✅ **Phase 2 (a) — webfont discovery + subsetted embed** — `@font-face` parsing, Google Fonts allowlist (`fonts.gstatic.com` / `fonts.googleapis.com`), fetch + `pdf-lib` `embedFont(bytes, { subset: true })`. Spans matched by family chain + weight/style; non-matching spans fall back to standard PDF fonts. (commit `5066b0d`)
- 🚧 **Phase 2 (b) — visual fidelity bug fixes** — currently uncommitted on `main`. See "Open issue" below.

### TDD adopted

User requested mid-Phase-1. Workflow now:

1. Write a failing test that locks the desired contract (in `packages/core/src/*.test.ts`).
2. Implement the minimum to make it green.
3. Lint + typecheck + build + full test run before commit.

Tests run via `vitest` in **browser mode** through `@vitest/browser` + Playwright Chromium — the library uses real `Range.getClientRects()` / `getComputedStyle` / `document.fonts`, so jsdom-mode would lie.

### What `@vellum/core` looks like now

```
src/
├── capture.ts           # html-to-image wrapper (rasterizer)
├── color.ts             # CSS color → RGB parser
├── dom-to-pdf.ts        # public entry; orchestrates walk → fonts → emit
├── emit.ts              # pdf-lib glue: embed (web)fonts, draw spans, JPEG bg
├── font-discovery.ts    # @font-face parser, family/weight matcher, allowlist
├── font-mapping.ts      # CSS family/weight/style → 12 standard PDF fonts
├── font-resolver.ts     # fetch web fonts, build WebFontCandidate[]
├── timing.ts            # `measure()` helper for onTiming hook
├── types.ts             # public types (DomToPdfOptions, TextSpan, …)
├── walk.ts              # TreeWalker → per-line TextSpan[]
├── index.ts             # public exports (`domToPdf`, `VERSION`, types)
└── *.test.ts            # 48 tests across 5 files
```

Public exports remain `domToPdf` + `VERSION` + types — internal helpers are not re-exported. Locked by `public-api.test.ts`.

### Conventions confirmed in this session

- **No `.js` suffix on local imports.** `moduleResolution: Bundler` + tsup/esbuild handle resolution. Already updated `CLAUDE.md`.
- **Visible-degradation invariant.** Bad font bytes / network errors / disallowed origins push warnings into `result.warnings` and fall back to standard fonts — never throw.
- **Single rasterizer-fonts boundary.** Web font resolution lives in `dom-to-pdf.ts` (needs live `Document`), `emit.ts` only sees serializable `WebFontCandidate[]`. This keeps the path open for OffscreenCanvas / Worker parallelism (PLAN § "Performance philosophy").

### Empirical findings

- Per-page timing on the example deck (5 slides, 800×600): `walk` ≪ 1 ms, `capture` 30–100 ms (first page warmup ~100 ms, subsequent ~30 ms), `fonts` ~10 ms, `emit` ~13 ms. **Capture (rasterization) dominates** — confirms PLAN's framing that WASM doesn't help and Worker parallelism is the scaling lever.
- pdf-lib's `embedFont(bytes, { subset: true })` accepts woff2 directly in the browser (fontkit handles brotli decompression in-browser). One earlier worry was that woff2 would fall back to standard fonts; it doesn't.
- `fontkit` must be imported as `import * as fontkit from 'fontkit'` (no default export when bundled by Vite).

### Open issue (Phase 2 b — uncommitted, fix in progress)

**Symptom:** in the example deck, around bold/inline `<b>` and inline `<code>` elements the visible spacing is "歪んでる" — gap before bold word looks too wide, gap after inline code looks too tight. User-confirmed visually.

**Root cause:** `walk.ts::normalizeLineWhitespace` was `.trim()`-ing every span. For text nodes adjacent to inline siblings (e.g. `"Hello "` + `<b>"bold"</b>` + `" and "`), the leading/trailing space at the inline boundary is semantically meaningful — it's the space between two visible words. Stripping it both:

- Loses the space in copy-paste (`"Helloboldand…"`),
- And — more visibly — the drawn vector text ends earlier than the original layout's run width, so the visible gap to the next inline span widens past one character.

**Fix (uncommitted):**

- New per-line normalize signature: `normalizeLineWhitespace(line, whiteSpace, { keepLeadingSpace, keepTrailingSpace })`.
- `keepLeadingSpace` flips on for the first line of a text node when it has a content-bearing previous sibling. `keepTrailingSpace` mirrors for the last line and next sibling. `hasContentSibling()` walks siblings, skipping pure-whitespace text nodes and `display: none` elements.
- Block-level boundaries (text alone in a `<p>`, with HTML-source indentation) are unaffected — no inline sibling, so trim happens as before. Phase 0's indent-stripping test still passes.

**Status:** new TDD test `extractSpans > preserves a single space between inline siblings` was red, then green after the fix. Full suite 48/48. Visually still needs to be re-verified in the example browser — that's the next concrete step.

### Repo state at session end

```
On branch main; up to date with origin (1 commit ahead before this writeup).

Uncommitted (Phase 2 b — walker whitespace fix):
  packages/core/src/walk.ts                # the fix
  packages/core/src/index.test.ts          # the test that pinned it
  examples/index.html                      # added Inter (Google Fonts) slide for Phase 2 visual check
  examples/main.ts                         # surface result.warnings in the timing log
```

Will be committed and pushed at the end of this writeup.

### To pick up next session

1. Re-run `pnpm example` and visually verify the spacing fix on the bold/code slide.
2. If good: continue Phase 2 to-dos from `PLAN.md` § 9 in priority order:
   - Google Fonts CSS API has multiple `@font-face` rules per family split by `unicode-range` (latin, latin-ext, cyrillic, …). Today we pick the first weight/style match and ignore `unicode-range` — works for ASCII-only decks but will silently misembed for Latin-Ext / CJK. Add `unicode-range` parsing + per-character font selection.
   - Noto Sans JP fallback so CJK characters become selectable.
   - `::before` / `::after` text extraction.
   - Web Worker / OffscreenCanvas parallelism for `capture` (the dominant stage).
3. `@vellum/validator` (canvas detection + warning CSS) is its own package and can wait until A→F above are done.

### Useful commands

```sh
pnpm install
pnpm test             # 48 tests across 5 files (Chromium)
pnpm typecheck
pnpm lint             # biome
pnpm format           # biome --write
pnpm build            # tsup → dist/index.js + dist/index.d.ts
pnpm example          # vite-served playground at http://localhost:5173/
```
