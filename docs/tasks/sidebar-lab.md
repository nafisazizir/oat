# Sidebar lab — mock navigation comparison
status: done
milestone: prototype · deps: none · branch: devin/1795398368-sidebar-lab

## Goal
Compare four sidebar compositions without touching production navigation or accessing auth/data.

## Context
User brief; SPEC §4 workspace; research/granola/ui-design.md (behavior only).

## Scope
In: dev-probes/sidebar-lab server gate and local client mock. Out: real AppSidebar, services, persistence.

## Acceptance criteria
- [x] A/B/C/D selectable via query and controls, live local navigation, mock workspace switching.
- [x] Variant-specific utilities/chat structure, shared upward account menu, sensible icon collapse.
- [x] Production route calls notFound; no session/DB dependencies (source-reviewed, no production build).
- [x] Typecheck/lint and Chromium 1280×800 screenshots including A menu.

## Design notes
Full-height shared Sidebar primitives left, quiet placeholder canvas right. Token colors/typography,
shared Avatar, Kbd, tooltips and Base UI menus. No network loading/error state: mock-only local state.
Unknown/absent query defaults to A. Empty main is skeleton placeholder by design.

## Verification
`pnpm --filter @oat/web exec tsc --noEmit`; eslint new files; external Playwright capture/interaction
checks. User requested focused prototype checks, not the full infrastructure gate.

## Review
Self-review against brief; independent factory review not performed in this bounded handoff.

## Evidence
`pnpm --filter @oat/web exec tsc --noEmit` and
`pnpm --filter @oat/web exec eslint src/app/dev-probes/sidebar-lab/*.tsx` exit 0:

```text
Sidebar lab typecheck and lint: PASS
PASS: A/B/C/D screenshots, navigation, Home, collapsed menus, workspace switch, invalid/empty query, variant control; no browser errors.
```

External Playwright harness: `/home/ubuntu/sidebar-lab-shots/check.mjs`.
Screenshots personally inspected: `a.png`, `b.png`, `c.png`, `d.png`, `a-switcher.png`,
and `a-collapsed.png`, `b-collapsed.png`, `c-collapsed.png`, `d-collapsed.png` in that directory.
Initial check had an exact-name fixture mismatch (avatar initials are accessible); harness corrected.
Visual review caught B's bottom utility clipping: tightened B group spacing, retained scrollability,
rechecked screenshots and checks. Menu capture waits for its entrance animation to finish.
Next dev remains running at `http://localhost:3000/dev-probes/sidebar-lab`.
No full CI, production-runtime, mobile or dark-mode visual pass; no existing tests target this new probe.
