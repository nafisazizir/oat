/**
 * Private / Shared (D-36): how the sidebar of a workspace is split, on the web and on the desktop, and the
 * words used for who an item reaches.
 *
 * This is **display only**. Who may read what is decided by `permissions.ts`; these helpers are given items
 * the viewer can already read and only say where each one is shown. They never widen access: an item that
 * is `private` and not the viewer's is not put under Private (it should not have been listed at all), and
 * nothing here is used to authorise a read.
 */
import type { DocumentVisibility } from './types.ts';

export type SidebarSection = 'private' | 'shared';

export const SIDEBAR_SECTIONS: readonly SidebarSection[] = ['private', 'shared'];

/** What the sidebar says for each section. An empty section is just its label. */
export const SECTION_INFO: Readonly<Record<SidebarSection, { label: string }>> = {
  private: { label: 'Private' },
  shared: { label: 'Shared' },
};

/** The fields that decide an item's section (documents, folders and desktop note summaries all fit). */
export interface SectionItem {
  readonly ownerId: string;
  readonly visibility: DocumentVisibility;
}

/** Private = mine and `private`. Everything else I can read is Shared. */
export function sidebarSection(item: SectionItem, userId: string): SidebarSection {
  return item.visibility === 'private' && item.ownerId === userId ? 'private' : 'shared';
}

/** `items` split by section, each keeping the order it came in. */
export function splitSections<T extends SectionItem>(
  items: readonly T[],
  userId: string,
): Record<SidebarSection, T[]> {
  const sections: Record<SidebarSection, T[]> = { private: [], shared: [] };
  for (const item of items) sections[sidebarSection(item, userId)].push(item);
  return sections;
}

/** A section item that sits in a tree (`parentId` = containing folder, `null` = top level). */
export interface SectionNode extends SectionItem {
  readonly id: string;
  readonly parentId: string | null;
}

/**
 * The items of one section and which of them are its top level: those at the workspace root, and those
 * whose folder is not shown in this section (my private note inside a shared folder is a top-level item
 * of Private; a folder I can't see never hides something I can read).
 */
export function sectionTree<T extends SectionNode>(
  items: readonly T[],
  section: SidebarSection,
  userId: string,
): { items: T[]; roots: T[] } {
  const own = items.filter((item) => sidebarSection(item, userId) === section);
  const ids = new Set(own.map((item) => item.id));
  return {
    items: own,
    roots: own.filter((item) => item.parentId === null || !ids.has(item.parentId)),
  };
}

/**
 * Who an item reaches, said from its own visibility — never from how many people are in the workspace
 * right now: a `workspace` item is for everyone in the workspace even while that is one person, because it
 * is readable by whoever joins next.
 */
export function visibilityLabel(visibility: DocumentVisibility, workspaceName: string): string {
  const everyone = `Everyone in ${workspaceName.trim() || 'the workspace'}`;
  switch (visibility) {
    case 'private':
      return 'Only you';
    case 'workspace':
      return everyone;
    case 'link':
      return `${everyone} + link`;
  }
}

/**
 * The same, as the short badge on an item's header: a private item is named after the section it is in
 * ("Private"); anything else says who it reaches.
 */
export function visibilityBadge(visibility: DocumentVisibility, workspaceName: string): string {
  return visibility === 'private'
    ? SECTION_INFO.private.label
    : visibilityLabel(visibility, workspaceName);
}
