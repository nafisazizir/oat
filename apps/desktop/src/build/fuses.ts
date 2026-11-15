/**
 * Electron fuses for packaged builds (flipped on the packaged Electron binary before signing; the
 * packaging pipeline, task 9.1, calls `applyFuses` from its after-pack hook). Dev and e2e run the stock
 * Electron binary from node_modules and are unaffected (Playwright needs the inspector fuses there).
 *
 * `strictlyRequireAllFuses` makes an Electron upgrade that adds a fuse fail the build until it's decided.
 */
import { flipFuses, type FuseConfig, FuseV1Options, FuseVersion } from '@electron/fuses';

export const OAT_FUSES = {
  version: FuseVersion.V1,
  strictlyRequireAllFuses: true,
  // macOS: flipping invalidates the ad-hoc signature; re-sign (9.1 signs properly afterwards).
  resetAdHocDarwinSignature: process.platform === 'darwin',
  // No `ELECTRON_RUN_AS_NODE`: the app binary can't be used as a plain Node interpreter.
  [FuseV1Options.RunAsNode]: false,
  // Cookies on disk are encrypted with the OS key (Keychain on macOS).
  [FuseV1Options.EnableCookieEncryption]: true,
  // No `NODE_OPTIONS` (e.g. `--require` injection) and no `--inspect` attach in released builds.
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  // Load the app only from `app.asar`, and verify it against the hash embedded at build time.
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  // The renderer is served from `app://`, so `file://` needs no extra privileges.
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  // Electron's default (on): WebAssembly trap handlers.
  [FuseV1Options.WasmTrapHandlers]: true,
} satisfies FuseConfig;

/** Flips `OAT_FUSES` on a packaged app's Electron binary (or `.app` bundle on macOS). */
export function applyFuses(electronBinaryOrApp: string): Promise<number> {
  return flipFuses(electronBinaryOrApp, OAT_FUSES);
}
