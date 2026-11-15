import pkg from '../../package.json' with { type: 'json' };

/** The web app's version (`apps/web/package.json`), reported by `/api/health`. */
export const appVersion: string = pkg.version;
