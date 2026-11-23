# Graphite UI foundation

status: done
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

- [x] Both apps use the Graphite ramps in light and dark and use Ziiz controls.
- [x] App controls use the default radius even when placed inline together.
- [x] Settings show current values with ghost triggers, secondary fields and small menus.
- [x] Fast CI, web Playwright and representative light and dark screenshots are recorded.

## Verification

- `pnpm run ci --fast`
- `pnpm --filter @oat/web e2e` with the compose stack and Chromium
- `pnpm --filter @oat/desktop exec electron-vite build` and built renderer snapshots with a fixture bridge

## Design notes

Keep the route-based settings layout and use the Claude showcase's compact, grouped
navigation and field/control choices. Use default Ziiz control shapes with round avatars,
badges and status dots. For a value in a settings row, use `SelectTrigger` or a menu
trigger rendered as a button with `variant="ghost"` and `size="sm"`. `ThemeMenu showValue`
uses this pattern on the web. Inputs, textareas and input groups default to secondary,
and dropdown and context menus default to small.

## Review

Independent Claude showcase and registry audit checked the component choices and Oat
keyboard and accessibility behavior. The sync retains the sidebar shortcut guard,
tooltip role, and Select and Command icon/separator semantics.

Update 2026-11-21: the ramp-based dialog overlay kept by this sync (`bg-gray-alpha-400`) was dropped for
Ziiz's `bg-black/10` in `dialog.tsx` and `alert-dialog.tsx`. In dark the ramp token is 11% white, so the
backdrop lightened the app behind a dialog instead of dimming it; light is visually unchanged.

## Evidence

Web Appearance and the built desktop renderer's Storage screen were checked in both
themes. Web used a signed-in session and desktop used a fixture bridge. The four
screenshots are in [PR #22](https://github.com/nafisazizir/oat/pull/22).
The local fast gate passed. Local Chromium Playwright finished with 87 passed and 17
skipped, including both Appearance theme and axe checks among the passing tests.
Native Electron e2e requires macOS.
