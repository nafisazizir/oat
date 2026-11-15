/**
 * `@oat/detection/node`: Node-only parts (child processes) for the Electron main process and tests. Never
 * import this from renderer code. Re-exports everything from `@oat/detection`.
 */
export * from './index.ts';
export { SidecarMicAppsSource, type SidecarMicAppsSourceOptions } from './sidecar-source.ts';
