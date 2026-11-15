/**
 * Templates the eval fixtures reference, by slug: the real built-ins (`src/templates.ts`, task 4.3), so evals
 * score exactly what users get.
 */
import type { EnhanceTemplate } from '../src/enhance.ts';
import { BUILTIN_TEMPLATES, type BuiltinTemplateSlug } from '../src/templates.ts';

export const EVAL_TEMPLATES: Readonly<Record<BuiltinTemplateSlug, EnhanceTemplate>> =
  Object.fromEntries(BUILTIN_TEMPLATES.map((t) => [t.slug, t] as const)) as Record<
    string,
    EnhanceTemplate
  > as Record<BuiltinTemplateSlug, EnhanceTemplate>;

export type EvalTemplateId = BuiltinTemplateSlug;
