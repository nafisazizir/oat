# Enhanced menu — use compact dropdown rows

status: verify · branch: `devin/1795645952-dropdown-menu-sm`

## Goal

Match the meeting header's Enhanced menu to the other compact dropdowns. D-43 added the
current template and Regenerate action. The current template is informational, not a full-row action.

## Scope

The shared Enhanced/template menu on web and desktop, and placement of the web meeting's
Enhance/Enhanced pill. Other meeting menus are unchanged.

## Acceptance criteria

- The current template appears above Templates with a separate, icon-only Regenerate button.
- On web, the Enhanced pill stays in the same row as the other meeting facts, as on desktop.
- The popup uses the shared `sm` menu size for its labels and items.
- Regenerate still prompts before replacing edits.

## Verification

- `pnpm run ci`
- With the local dev stack running:
  `pnpm --filter @oat/web e2e enhance-versions.spec.ts --no-deps --trace on`.

## Evidence

- `pnpm run ci --only format,typecheck,lint,test`: all four steps passed; workspace UI
  140 tests passed, feature UI 179 tests passed.
- Focused Chromium: both runs passed the menu assertions and Regenerate confirmation, but
  timed out on the later “Your original notes are back” toast. The restore returned HTTP 200
  and the original notes were present in the final page snapshot.
- Verified the compact pill and icon-only action in the open web menu:
  `/home/ubuntu/oat-dropdown-compact-e2e/enhanced-menu.jpeg` (local).
- Native desktop runtime was not verified.
