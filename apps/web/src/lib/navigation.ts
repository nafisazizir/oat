import { ancestorsOf, findDocument, sectionOf, type ShellData, titleOf } from './tree';

export type Crumb = { label: string; href?: string };

/** Top-level app sections, shared by the sidebar, the command palette and breadcrumbs. */
export const sections = {
  home: { label: 'Home', href: '/home' },
  templates: { label: 'Templates', href: '/templates' },
  settings: { label: 'Settings', href: '/settings' },
} as const;

/** Whether `pathname` is a section's page or one of its sub-pages (`/templates/…` → Templates). */
export function inSection(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Breadcrumbs for an app pathname: workspace › section, or workspace › Private/Shared › ancestors ›
 * page (or workspace › Trash › page). Pure: the tree comes from the shell data. The last crumb has no
 * link. A document outside the active workspace's tree (e.g. opened from a link) shows as "Page".
 */
export function breadcrumbsFor(
  tree: Pick<ShellData, 'workspace' | 'documents'> & Partial<Pick<ShellData, 'trash'>>,
  pathname: string,
): Crumb[] {
  const workspace: Crumb = { label: tree.workspace.name, href: sections.home.href };
  const [first, second] = pathname.split('/').filter(Boolean);

  for (const section of Object.values(sections)) {
    if (section.href === `/${first ?? ''}` && second === undefined) {
      return [workspace, { label: section.label }];
    }
  }

  // Template pages: workspace › Templates › New template | Template (names aren't in the shell data).
  if (first === 'templates' && second) {
    const templates: Crumb = { label: sections.templates.label, href: sections.templates.href };
    return [workspace, templates, { label: second === 'new' ? 'New template' : 'Template' }];
  }

  if (first === 'd' && second) {
    const id = decodeURIComponent(second);
    const doc = findDocument(tree.documents, id);
    if (!doc) {
      const trashed = tree.trash && findDocument(tree.trash, id);
      if (trashed) return [workspace, { label: 'Trash' }, { label: titleOf(trashed) }];
      return [workspace, { label: 'Page' }];
    }
    const area: Crumb = {
      label: sectionOf(tree.documents, id) === 'private' ? 'Private' : 'Shared',
    };
    const ancestors = ancestorsOf(tree.documents, id).map((a) => ({
      label: titleOf(a),
      href: `/d/${a.id}`,
    }));
    return [workspace, area, ...ancestors, { label: titleOf(doc) }];
  }

  return [workspace];
}
