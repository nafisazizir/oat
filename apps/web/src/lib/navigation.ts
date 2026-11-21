/** Top-level app sections, shared by the sidebar, the command palette. */
export const sections = {
  home: { label: 'Home', href: '/home' },
  search: { label: 'Search', href: '/search' },
  tasks: { label: 'My tasks', href: '/tasks' },
  assistant: { label: 'Assistant', href: '/assistant' },
  templates: { label: 'Templates', href: '/templates' },
  settings: { label: 'Settings', href: '/settings' },
} as const;

/** Whether `pathname` is a section's page or one of its sub-pages (`/templates/…` → Templates). */
export function inSection(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
