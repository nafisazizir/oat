# Graphite UI foundation

status: in-progress
milestone: M9 · deps: shared Ziiz UI · branch: devin/1795302208-graphite-ui-foundation

## Goal

Give the web and desktop renderer the same Graphite palette and control patterns as the
foundation for sharing more features.

## Context

- [D-32 and D-33](../DECISIONS.md) cover the preceding UI pass and Inter / Geist Mono.
- Ziiz source components live in `apps/www/components/ui`, its Graphite recipe in
  `apps/www/lib/palettes.ts`, and its Claude showcase in `apps/www/components/claude-ai`.

## Scope

Shared registry components and tokens, small web and desktop control updates, and the
shared meeting UI. Desktop main, bridge types, web API, feature parity and page layouts
are separate work.

## Acceptance criteria

- [ ] Both apps use the Graphite ramps in light and dark and use Ziiz controls.
- [ ] App controls use the default radius even when placed inline together.
- [ ] Settings show current values with ghost triggers, secondary fields and small menus.
- [ ] Fast CI, web Playwright and representative light and dark screenshots are recorded.

## Verification

- `pnpm run ci --fast`
- `pnpm --filter @oat/web e2e` with the compose stack and Chromium
- `pnpm --filter @oat/desktop exec electron-vite build` and built renderer snapshots with a fixture bridge

## Design notes

Keep the route-based settings layout and use the Claude showcase's compact, grouped
navigation and field/control choices. Use default Ziiz control shapes with round avatars,
badges and status dots.

## Review

Pending.

## Evidence

Pending.
