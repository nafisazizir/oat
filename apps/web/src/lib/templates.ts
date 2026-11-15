/**
 * Templates API contract (task 4.3), shared by the route handlers and the browser. JSON over
 * `/api/templates`:
 *
 * | Method | Path                     | Body                                                 | Result            |
 * |--------|--------------------------|------------------------------------------------------|-------------------|
 * | GET    | /api/templates?workspaceId=… | –                                                | `TemplateList`    |
 * | POST   | /api/templates           | `{ workspaceId, name, instructions, sections }` or `{ workspaceId, fromTemplateId }` (duplicate) | 201 `TemplateDetail` |
 * | GET    | /api/templates/:id       | –                                                    | `TemplateDetail`  |
 * | PATCH  | /api/templates/:id       | any of `{ name, instructions, sections }`           | `TemplateDetail`  |
 * | DELETE | /api/templates/:id       | –                                                    | 204               |
 *
 * Built-ins are readable by every signed-in user and never writable. Custom templates belong to one
 * workspace: members read them, editor roles (owner/admin/member) create, edit and delete; viewers are
 * read-only. Templates in a workspace the caller isn't in are 404. Errors use the shared API shape
 * (`ApiErrorBody` in `api-types.ts`; built-in writes are `403 builtin_read_only`).
 */
import type { TemplateSection } from '@oat/core';

export type TemplateDto = {
  id: string;
  /** `null` for built-ins. */
  workspaceId: string | null;
  name: string;
  /** The template's description: what it is for, plus note-wide guidance for the AI. */
  instructions: string;
  sections: TemplateSection[];
  isBuiltin: boolean;
  createdAt: string;
  updatedAt: string;
};

export type TemplateDetail = {
  template: TemplateDto;
  /** Whether the caller may edit/delete it (always false for built-ins). */
  canEdit: boolean;
  /** Whether the caller may create templates in the template's (or, for built-ins, the requested) workspace. */
  canDuplicate: boolean;
};

export type TemplateList = {
  builtins: TemplateDto[];
  custom: TemplateDto[];
  /** Whether the caller may create templates in the workspace. */
  canCreate: boolean;
};
