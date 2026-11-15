import { ancestorsOf, findDocument, type ShellData } from './tree';

export type Crumb = { label: string; href?: string };

/** Top-level app sections, shared by the sidebar, the command palette and breadcrumbs. */
export const sections = {
  home: { label: 'Home', href: '/home' },
  templates: { label: 'Templates', href: '/templates' },
  settings: { label: 'Settings', href: '/settings' },
} as const;

/**
 * Breadcrumbs for an app pathname: workspace › section, or workspace › Private/Shared › ancestors ›
 * page. Pure: the tree comes from the shell data. The last crumb has no link.
 */
export function breadcrumbsFor(
  tree: Pick<ShellData, 'workspace' | 'documents'>,
  pathname: string,
): Crumb[] {
  const workspace: Crumb = { label: tree.workspace.name, href: sections.home.href };
  const [first, second] = pathname.split('/').filter(Boolean);

  for (const section of Object.values(sections)) {
    if (section.href === `/${first ?? ''}` && second === undefined) {
      return [workspace, { label: section.label }];
    }
  }

  if (first === 'd' && second) {
    const id = decodeURIComponent(second);
    const doc = findDocument(tree.documents, id);
    if (!doc) return [workspace, { label: 'Not found' }];
    const area: Crumb = { label: doc.visibility === 'private' ? 'Private' : 'Shared' };
    const ancestors = ancestorsOf(tree.documents, id).map((a) => ({
      label: a.title,
      href: `/d/${a.id}`,
    }));
    return [workspace, area, ...ancestors, { label: doc.title }];
  }

  return [workspace];
}
