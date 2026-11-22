# Phase 3a — Graphite visual hill-climb, final polish and gate

status: done
milestone: M9 · branch: devin/1795313870-phase3a-visual-hillclimb

## Goal

Complete the final visual pass across both renderers, preserve their behavior, gate with fast CI and
the full web Playwright suite including axe, then publish final screenshot evidence and push.

## Scope and design

- Sidebar section captions return to the icon column; tighter section spacing, quiet actions retained.
- Shared name/email header (body-14 strong name, muted email; email-local-part fallback when unnamed).
  Menu order: Profile/Settings, Workspace, sync, desktop utilities, Sign out. Existing routes and actions stay.
  Web's quiet connected/reconnecting row reads the existing SSE `data-sync-live` marker through CSS;
  desktop retains its real outbox status. No transport logic changes.
- Web Google sign-in is secondary; Google/email/CTA are all 40px with default radius. Divider has rules.
  Desktop retains secure browser-based sign-in rather than introducing a separate provider form.
- Auth/expired/invite/handoff/not-found/unavailable screens share centered AuthPanel geometry.
- Task segmented control and selects are 32px/default radius; tasks, search and trash reuse Home's EmptyState.
  Trash omits the redundant inner border inside its dialog.
- No transport/recording/permission changes, generated registry edits or screenshot tooling in the diff.

## Acceptance criteria

- [x] Shared sidebar captions and account grouping follow the final feedback.
- [x] Sign-in controls/divider and centered notice surfaces are consistent.
- [x] Task controls and empty states use shared component geometry.
- [x] Final fast CI and complete web E2E/axe gate pass.
- [x] Rebuilt desktop and captured/inspected every round-three screenshot in both themes.
- [x] Final screenshot set ready for publication under `/home/ubuntu/shots/after` with baseline layout.

## Verification

1. `pnpm run ci --fast`
2. `DATABASE_URL=postgres://oat:oat@localhost:54329/oat pnpm run ci --only e2e`
3. `pnpm --filter @oat/desktop exec electron-vite build`
4. `bash /home/ubuntu/shots/run.sh /home/ubuntu/shots/r3`
5. Inspect every web/desktop light/dark PNG; copy the finished set to `after` with baseline layout.

CI allocates a free E2E port, but Next's shared dev directory still required stopping the :3000
server for the gate. Restarted afterward with the seeded dev database; desktop/reference stayed live.

## Review and evidence

Added shared-menu ordering/name/fallback regression assertions and shared empty-state assertions.
Updated E2E assertions only for intended Round 1–2 relocations (New note/Settings/toggle) and visible
Home typography. Restored accessible member-count metadata on the compact switcher. Retained geometry,
interaction, typeface/weight and axe checks; added sync connected/reconnecting presentation assertions.
Collapsed-footer geometry found a real 0.5px centering offset: fixed the layout instead of relaxing
the alignment assertion.

Final code gates:

```text
━━ ci summary (--fast)
step        status     time  note
format      pass      13.3s
actionlint  pass       0.3s
typecheck   pass       7.6s
lint        pass       7.6s
test        pass       6.0s
total                 34.8s

ci: ok

Web: 88 passed (6.1m), 17 skipped (opt-in/evidence/production-only).
Editor: 16 passed (8.1s), 2 skipped (opt-in screenshots).
Desktop: renderer build passed (822ms); 29 native tests skipped on Linux.

━━ ci summary (--only e2e)
step  status     time  note
e2e   pass     378.7s
total           378.7s

ci: ok
```

Light/dark route axe and all-tag WCAG 2.2 shell scans pass. Existing large-chunk build warning remains.
Logs: `/home/ubuntu/shots/r3-ci.log`, `/home/ubuntu/shots/r3-e2e.log`.
Capture output:

```text
RESULT 126 screenshots; 0 failed surfaces
RESULT 82 captures; 0 failures
RESULT 8 settled empty captures; 0 failures
ROUND 3: 120 screenshots; invalid dimensions: 0
```

Inspected all 120 app screenshots (web/desktop, light/dark) through the 14 review sheets under
`/home/ubuntu/shots/r3-review/`, plus full-resolution auth/account/tasks/notice surfaces. The first
post-E2E dev restart reused Next's stale dev cache and reloaded sign-in repeatedly; stopped it,
cleared only generated `.next/dev`, restarted, and the complete capture passed. Initial cold-route
task/conversation empties showed loading skeletons; recovered all eight empty-state images after
waiting for the real empty markers. No product source changes after the passing gates.

Additional scratch geometry checks passed: task tabs/selects all 32px; Google/input/email CTA all
40px; each row has matching default radius; section caption and primary icon both start at x=16px.
Log: `/home/ubuntu/shots/r3-geometry.log`.

Final images: `/home/ubuntu/shots/r3/{web,desktop}/{light,dark}/`, published identically to
`/home/ubuntu/shots/after/{web,desktop}/{light,dark}/`; all 116 baseline paths retained, plus four
explicit account-menu images. Screenshot tooling/logs remain outside the repository. Final diff
review found only scoped changes; no CI/build/shared configuration or dependency edits.

Commit/push uses the existing Phase 3a feature branch; command results are reported with the handoff.
Native Electron/macOS recording, permissions, Finder and playback remain unverified. Desktop keeps
browser-based sign-in (no new Google/email flow in Electron), its real recording controls and native
sync/device utilities. No fake contextual assistant action or saved-state indicator was introduced.
