import { ancestorsOf, findDocument, sectionOf, type ShellData, titleOf } from './tree';

export type Crumb = { label: string; href?: string };

/** Top-level app sections, shared by the sidebar, the command palette and breadcrumbs. */
export const sections = {
  home: { label: 'Home', href: '/home' },
  search: { label: 'Search', href: '/search' },
  tasks: { label: 'My tasks', href: '/tasks' },
  assistant: { label: 'Assistant', href: '/assistant' },
  templates: { label: 'Templates', href: '/templates' },
  settings: { label: 'Settings', href: '/settings' },
} as const;

/** Settings sub-pages by path segment (`/settings/<segment>`), as their page titles name them. */
const settingsPages: Record<string, string> = {
  profile: 'About me',
  integrations: 'Integrations',
};

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
  const [first, second, third] = pathname.split('/').filter(Boolean);

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

  // Settings pages: workspace › Settings › About me | Integrations | Workspace (› Members).
  if (first === 'settings' && second) {
    const settings: Crumb = { label: sections.settings.label, href: sections.settings.href };
    if (second === 'workspace') {
      return third === 'members'
        ? [
            workspace,
            settings,
            { label: 'Workspace', href: '/settings/workspace' },
            { label: 'Members' },
          ]
        : [workspace, settings, { label: 'Workspace' }];
    }
    const label = settingsPages[second];
    return label ? [workspace, settings, { label }] : [workspace, { label: settings.label }];
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
