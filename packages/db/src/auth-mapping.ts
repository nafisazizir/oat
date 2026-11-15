/**
 * How Better Auth (D-9, wired in task 1.6) maps onto this schema. Plain data, no `better-auth` import, so
 * `@oat/db` doesn't depend on it at runtime; `auth-mapping.int.test.ts` runs real Better Auth flows with
 * these options to prove the shapes line up.
 *
 * Usage in 1.6:
 * ```ts
 * betterAuth({
 *   database: drizzleAdapter(db, { provider: 'pg', schema }),
 *   advanced: { database: { generateId: () => newId() } },
 *   plugins: [organization({ ...organizationOptions, organizationHooks: {
 *     beforeCreateOrganization: async ({ organization, user }) =>
 *       ({ data: { ...organization, createdBy: user.id } }),
 *   } })],
 * });
 * ```
 *
 * `organizationOptions.disableOrganizationDeletion` is `true` (D-22): a Better Auth delete would hard-delete
 * the workspace and cascade through every document, transcript and enhancement. Workspace deletion will be our
 * own soft-delete path.
 *
 * Core tables (`user`, `session`, `account`, `verification`) use Better Auth's default model and field
 * names, so they need no mapping. Organization → `workspace`, member → `membership`,
 * invitation → `invite`; `organizationId` → `workspaceId` everywhere; session `activeOrganizationId` →
 * `activeWorkspaceId`. `workspace.kind` defaults to `team`; `createdBy` must be set by the
 * `beforeCreateOrganization` hook (it's NOT NULL). Better Auth fieldNames are Drizzle property names.
 */
export const organizationSchema = {
  organization: {
    modelName: 'workspace',
    additionalFields: {
      kind: {
        // Mutable tuple + literal flags: Better Auth's types infer the `createOrganization` body from these.
        type: ['personal', 'team'] as ['personal', 'team'],
        required: false as const,
        defaultValue: 'team',
        input: true as const,
      },
      createdBy: { type: 'string' as const, required: false as const, input: false as const },
    },
  },
  member: {
    modelName: 'membership',
    fields: { organizationId: 'workspaceId' },
  },
  invitation: {
    modelName: 'invite',
    fields: { organizationId: 'workspaceId' },
  },
  session: {
    fields: { activeOrganizationId: 'activeWorkspaceId' },
  },
};

/** Organization-plugin options 1.6 spreads into `organization({...})` (plus its hooks). */
export const organizationOptions = {
  schema: organizationSchema,
  disableOrganizationDeletion: true as const,
};
