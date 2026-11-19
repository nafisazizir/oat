# UI overhaul — web settings & workspace (ziiz)

status: review
branch: devin/1795121502-ziiz-settings-workspace

## Goal

Move `/settings/**`, `components/settings/**` and `components/workspace/**` onto ziiz: ramp vocabulary,
type roles, Tabler icons, ziiz Field/Item/Select/Switch/Alert/AlertDialog/Empty/Spinner composition, with
optimistic member/invite mutations.

## Acceptance criteria

- [x] No shadcn aliases, raw type utilities, `dark:` overrides or lucide imports in the area.
- [x] Role changes, member removals and invite revokes are optimistic with rollback + toast on failure.
- [x] Destructive confirmations (remove member, leave, delete workspace) use `AlertDialog`.
- [x] Suspense fallbacks on Integrations match the loaded geometry.
- [x] `pnpm run ci --fast` green; workspace/settings e2e specs pass locally.
- [x] Before/after screenshots, light + dark.

## Verification

`pnpm run ci --fast`; `pnpm --filter @oat/web exec playwright test workspaces smoke a11y enhance-versions
notion calendar pipeline`; unit tests for the optimistic reducer (`src/lib/members-optimistic.test.ts`).

## Notes

- Shared files touched: `components/pipeline/pipeline-settings.tsx` (only used on Integrations; restyled +
  `PipelineSwitchSkeleton`), `apps/web/package.json` (`@tabler/icons-react`).
- `components/page.tsx` (PageHeader/BackLink) still uses aliases; owned by the shell area.
