type Manifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/**
 * D-15: `@oat/*` workspace packages ship TypeScript source, so Next.js must compile every one the app
 * depends on (`transpilePackages`). Derived from package.json so a new dependency can't be forgotten.
 */
export function workspacePackages(manifest: Manifest): string[] {
  const names = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
  return names.filter((name) => name.startsWith('@oat/')).toSorted();
}
