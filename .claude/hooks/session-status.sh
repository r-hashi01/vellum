#!/usr/bin/env bash
# Auto-injected at session start (see .claude/settings.json).
# Surfaces volatile state (version / recent commits / in-progress files /
# inferred phase) that's intentionally kept *out* of CLAUDE.md so the latter
# stays a stable repo description.
#
# Edit CLAUDE.md only when the project's nature changes (invariants, toolchain,
# layout). Edit this script when you want a new volatile signal injected.

set -uo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

VERSION=$(node -p "require('./packages/core/package.json').version" 2>/dev/null || echo "?")

echo "# vellum — session status (auto-generated)"
echo
echo "\`@vellum/core\` version: **$VERSION**"
echo
echo "## Recent commits"
echo '```'
git log --oneline -10 2>/dev/null || echo "(no git history)"
echo '```'
echo
echo "## Active modules in \`packages/core/src/\`"
echo '```'
ls packages/core/src/ 2>/dev/null | grep -E '\.ts$' | grep -v '\.test\.ts$' | sort
echo '```'
echo
echo "## Uncommitted changes"
echo '```'
status_out=$(git status --short 2>/dev/null | head -30)
if [ -z "$status_out" ]; then echo "(clean)"; else echo "$status_out"; fi
echo '```'
echo
echo "## Inferred phase"
if [ -f packages/core/src/font-resolver.ts ] || [ -f packages/core/src/font-discovery.ts ]; then
  echo "Phase 2 (webfont subsetting) in progress — \`@font-face\` discovery / fontkit-style resolver modules present."
elif [ -f packages/core/src/font-mapping.ts ]; then
  echo "Phase 1 (MVP) shipped (standard PDF font auto-mapping). Phase 2 (webfont subsetting) not yet started."
elif [ -f packages/core/src/dom-to-pdf.ts ]; then
  echo "Phase 0 (PoC) shipped. Phase 1 (MVP) is next per PLAN.md § 9."
else
  echo "Pre-Phase-0 / skeleton."
fi
echo
echo "_Stable context: see CLAUDE.md. Roadmap: see PLAN.md § 9. This block is regenerated every session — do not cite it as authoritative for past work; check git log instead._"
