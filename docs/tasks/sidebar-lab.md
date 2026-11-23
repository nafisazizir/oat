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

## Follow-up — collapsible groups
Added controlled, initially expanded Private/Shared/Chats/Ask Oat groups, with independent local state
retained when switching variants. Matched TreeSection's SidebarGroup/Label/Action/Content structure,
trailing chevron geometry and hover/focus/popup-open add affordances. Labels render native buttons
with aria-expanded; note groups offer New page/New folder and chat groups start a mock chat.
The real TreeSection currently renders a static rotated chevron, not a section toggle; this probe adds
the requested toggle behavior without changing the production component.

Focused typecheck/lint exit 0; extended external Playwright harness exit 0:

```text
Sidebar lab typecheck and lint: PASS
PASS: A/B/C/D screenshots, navigation, Home, collapsed menus, workspace switch, invalid/empty query, variant control; no browser errors.
PASS: all group labels toggle independently via click/Enter; hidden rows removed; hover/focus add actions work without toggling; state retained across variants; collapsed-groups screenshot.
```

Refreshed and inspected `/home/ubuntu/sidebar-lab-shots/{a,b,c,d}.png` plus
`/home/ubuntu/sidebar-lab-shots/a-groups-collapsed.png` (Shared and Chats collapsed).
Harness first hit simultaneous outgoing/incoming menu animation nodes; scoped the New folder locator
to its Shared menu, with no product change needed. Server still responds on port 3000.

## B-selected iteration — B1–B4
Replaced the old variants with B-based comparisons; default/unknown/old query values now select B1.
Kept B's New note, Search/shortcut, Tasks and collapsible trees, and the common switcher menu.
B1 uses title-aligned muted text-only View all and bottom utilities; B2 uses muted Dots/More and
tooltip footer utilities beside the switcher; B3 separates Chats-label navigation from its collapse
button, exposes a hover arrow, shows task count 4, and retains bottom utilities; B4 has text-only chat
rows, muted Messages/All chats, and switcher Library utilities. No production sidebar changes.

Focused typecheck/lint exit 0; external `/home/ubuntu/sidebar-lab-shots/check-b.mjs` exit 0:

```text
Sidebar lab typecheck and lint: PASS
PASS: B1–B4 query/control selection, default/invalid query fallback, navigation/Home, independent group toggles, B-specific chat treatments/utilities/count, collapsed switchers, and state retention; no browser errors.
Dev server port 3000: HTTP 200
```

Chromium 1280×800 captures personally inspected: `/home/ubuntu/sidebar-lab-shots/b1.png`, `b2.png`,
`b3.png`, `b4.png`; supplemental icon-collapse captures saved alongside them. Harness corrected an
exact accessible-name expectation for the intentional Tasks count (Tasks 4), no product defect.
No full CI, production-runtime, mobile or dark-mode visual pass in this iteration.

## Refined B1 — final layout and icon exploration
Removed B2–B4 and all layout selection; any v query is ignored. Tasks, Templates and Trash now appear
only in the switcher's Library group, in that order, between workspace actions and Theme. Header,
New note, Search/shortcut, collapsible Private/Shared/Chats and the sole footer switcher remain.
The new View all icon control/query supports none/dots/arrow/list/bubbles with a fixed 16px icon slot,
muted glyph/text and none as the absent/invalid/empty query default. View all opens local All chats.

Focused tsc and new-file eslint exit 0; `/home/ubuntu/sidebar-lab-shots/check-final.mjs` exit 0:

```text
Sidebar lab typecheck and lint: PASS
PASS: refined B1 only; Library Tasks/Templates/Trash navigation; group click/keyboard toggles; all five icon queries/controls; identical View all text alignment; empty/invalid/old-query defaults; collapsed switcher; no browser errors.
PASS: final.png, final-switcher.png and five-option viewall-strip.png captured at 1280px width.
Dev server port 3000: HTTP 200
```

Personally inspected `/home/ubuntu/sidebar-lab-shots/final.png` and `final-switcher.png` (1280×800),
and `viewall-strip.png` (1280×201). The strip combines actual Playwright Chats element captures for
all five options, with option captions, in a simple HTML image grid; no synthetic redraw of the UI.
Bounding-box assertions verify every View all text position matches the chat titles and stays identical
across options. Dev server remains on 3000; no production sidebar/auth/data changes. Prior full-CI,
production-runtime, mobile and dark-visual limitations remain.

## Avatar fix and dots default
Replaced both hand-rolled workspace avatar sites with settings-ui WorkspaceAvatar, preserving sizes
while sharing matching rounded-md fill/ring geometry. Default and invalid icon queries now use dots;
explicit none remains supported. Focused tsc/eslint exit 0; external check-avatar.mjs exit 0:

```text
Sidebar lab typecheck and lint: PASS
PASS: dots default/invalid-query fallback, explicit none; all three workspace avatar ring/fill radii match; Personal switch works; final-switcher and workspace-list crop captured.
Avatar zoom: 4x crop saved
Dev server port 3000: HTTP 200
```

Personally inspected refreshed `/home/ubuntu/sidebar-lab-shots/final-switcher.png` (1280×800) and
`/home/ubuntu/sidebar-lab-shots/avatar-zoom.png` (984×352). Zoom is the actual workspace-list element
capture enlarged 400% with ImageMagick point filtering; no circular ring over the square fill remains.
Real sidebar and shared avatar implementation unchanged. Server left on 3000; local commit, no push.
