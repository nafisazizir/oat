/**
 * The Postgres schema (SPEC §6). Every table, keyed by the name Better Auth's Drizzle adapter and
 * drizzle-kit see. Generate migrations with `pnpm --filter @oat/db db:generate` after changing it.
 */
export * from './enums.ts';
export * from './auth.ts';
export * from './profile.ts';
export * from './workspace.ts';
export * from './documents.ts';
export * from './meetings.ts';
export * from './ai.ts';
export * from './integrations.ts';
export * from './tasks.ts';
export * from './sync.ts';
export * from './pipeline.ts';
