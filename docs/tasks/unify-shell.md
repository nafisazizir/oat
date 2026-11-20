# Unify desktop/web shell and note layout

Human-approved PR 1. Scope: renderer layout only; no capture, IPC or main-process changes.

## Acceptance

- Shared 44rem NoteColumn and 360/280/600 transcript dimensions; separate stored widths.
- Desktop ziiz collapsible sidebar, local search dialog, compact account dropdown and draggable inset toolbar.
- Preserve recording, upcoming events, conflicts, onboarding and E2E selectors where applicable.
- Renderer tests, fast CI, web/desktop builds and light/dark visual evidence.

## Implementation

- `packages/meeting-ui`: NoteColumn uses the web's 44rem measure/padding and accepts div attributes/className. Shared transcript default/min/max are 360/280/600. Both apps retain their own stored panel widths.
- Desktop: ziiz SidebarProvider/Header/Content/Footer/Group/Menu/Inset; workspace switcher, branded new-meeting button, local search in a Dialog (Command-K/Control-K), active meeting rows and compact account dropdown. Upcoming meetings and conflicts remain available.
- A 48px empty sidebar drag strip reserves native traffic-light space. The inset toolbar contains breadcrumbs, sidebar trigger and existing recording controls portaled from the note view; interactive areas opt out of dragging. Collapsed/mobile macOS chrome reserves additional horizontal space. Signed-out/onboarding views remain draggable.
- Existing recording actions and desktop bridge contracts are unchanged. Desktop E2E selectors now open the account dropdown/search dialog before operating their existing controls.
- Four renderer tests cover recording click/shortcut, Command-K with empty results, all account actions and failed connection feedback. Shared component coverage checks note geometry and spacing overrides. React checklist reviewed: effect cleanup, state ownership, accessible dialogs/menu actions and unchanged async recording flow.

## Verification

`pnpm run ci --fast`:

```text
format      pass      10.2s
actionlint  pass       0.3s
typecheck   pass       8.7s
lint        pass      10.6s
test        pass      15.2s
total                 45.1s

ci: ok
```

- Desktop production build passed (`✓ built in 668ms`); existing large-chunk warning remains.
- Web production build passed (optimized production compilation and TypeScript completed).
- Compose-backed web light surface capture: `2 passed (42.3s)` (auth setup + Home/document/meeting/Settings surfaces).
- Built desktop renderer capture: `errors: []`. Light/dark screenshots were inspected alongside the web meeting note: note inset/measure and transcript width align; no broken surfaces. Captures wait for autosave/theme transitions to settle.

Screenshots:

- `/home/ubuntu/shell-desktop-light.png`
- `/home/ubuntu/shell-desktop-dark.png`
- `/home/ubuntu/shell-web-light.png`

Desktop captures use stubbed IPC, not native Electron/macOS. Native traffic-light placement, real recording and desktop Playwright E2E were not exercised on Linux. No Swift, IPC-contract or main-process files changed. Initial checks caught two removed imports still used elsewhere (`cn`, `IconRefresh`); both were restored before the final green run.

## Follow-up — sidebar action parity

- Replaced the filled New meeting note button with the web's SidebarMenuItem/SidebarMenuButton composition, `IconEdit`, `tooltip="New note"` and `text-brand-900 hover:text-brand-1000`. Preserved the label, aria-label, test ID, pending spinner, disabled state and recording shortcut handler.
- New meeting and Search use SidebarMenuBadge with plain Kbd (`⌘N`/`⌘K`); removed the opacity-based shortcut styling. Renderer regression assertions cover both badges and the brand-text row.
- Fast CI: format/typecheck/lint/test/actionlint all passed, `ci: ok` (35.1s). Desktop rebuilt (`✓ built in 613ms`, existing chunk-size warning). Regenerated and inspected `/home/ubuntu/shell-desktop-light.png`; built-renderer stub capture reported `errors: []`. The capture helper also refreshed the dark image.
