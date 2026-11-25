# Enhanced menu — use compact dropdown rows

status: verify · branch: `devin/1795645952-dropdown-menu-sm`

## Goal

Match the meeting header's Enhanced menu to the other compact dropdowns. D-43 added the
current template and Regenerate action; the action previously occupied a custom icon-only row.

## Scope

The shared Enhanced/template menu on web and desktop. Keep the current template visible and
retain the existing regeneration confirmation. Other meeting menus are unchanged.

## Acceptance criteria

- The current template and Regenerate form one standard actionable menu item above Templates.
- The popup uses the shared `sm` menu size for its labels and items.
- Regenerate still prompts before replacing edits.

## Verification

- `pnpm run ci`
- With the local dev stack running:
  `pnpm --filter @oat/web e2e enhance-versions.spec.ts --no-deps --trace on`.

## Evidence

- `pnpm run ci --only format,typecheck,lint,test`: all four steps passed; workspace UI
  140 tests passed, feature UI 179 tests passed.
- Focused Chromium spec: `1 passed (59.7s)`, including the compact menu, top Regenerate row,
  and edit-replacement warning. Trace: `/home/ubuntu/oat-dropdown-e2e/` (local).
- Native desktop runtime and visual appearance were not verified.
