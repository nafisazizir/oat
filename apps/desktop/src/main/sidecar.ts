/**
 * Options for finding the `oat-audio` sidecar (`@oat/audio/node` `locateSidecarBinary`, also used by
 * `@oat/calendar`). `OAT_AUDIO_BIN` is a development convenience only: in a packaged app the environment
 * must not choose a binary that would inherit Oat's microphone / screen-recording permission (2.4 review),
 * so it is stripped and only the bundled binary (`<resources>/oat-audio`, 9.1) or the dev build count.
 */
export interface SidecarLocateOptions {
  env: NodeJS.ProcessEnv;
  resourcesPath?: string;
}

export function sidecarLocateOptions({
  isPackaged,
  env,
  resourcesPath,
}: {
  isPackaged: boolean;
  env: NodeJS.ProcessEnv;
  resourcesPath?: string;
}): SidecarLocateOptions {
  if (!isPackaged) return { env, ...(resourcesPath ? { resourcesPath } : {}) };
  const { OAT_AUDIO_BIN: _ignored, ...rest } = env;
  return { env: rest, ...(resourcesPath ? { resourcesPath } : {}) };
}
