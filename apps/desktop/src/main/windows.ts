/**
 * Window factory. Every window loads the same renderer bundle and picks its UI from the URL hash
 * (`#/main`, `#/widget`); all share the hardened `webPreferences` below.
 */
import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron';

import type { WindowKind } from '@oat/core/bridge';

import { APP_ORIGIN } from './security.ts';

export interface WindowFactoryOptions {
  preloadPath: string;
  rendererDevUrl: string | undefined;
  /** Show windows without focusing them (e2e). */
  inactive: boolean;
  /** From `DesktopConfig.devTools` (always `false` in a packaged app). */
  devTools: boolean;
}

export function rendererUrl(kind: WindowKind, rendererDevUrl: string | undefined): string {
  const base = rendererDevUrl
    ? new URL('/', rendererDevUrl).toString()
    : `${APP_ORIGIN}/index.html`;
  return `${base}#/${kind}`;
}

export function createWindowFactory({
  preloadPath,
  rendererDevUrl,
  inactive,
  devTools,
}: WindowFactoryOptions) {
  const webPreferences: BrowserWindowConstructorOptions['webPreferences'] = {
    preload: preloadPath,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: true,
    devTools,
  };

  function open(kind: WindowKind, options: BrowserWindowConstructorOptions): BrowserWindow {
    const win = new BrowserWindow({ ...options, show: false, webPreferences });
    win.once('ready-to-show', () => (inactive ? win.showInactive() : win.show()));
    void win.loadURL(rendererUrl(kind, rendererDevUrl));
    return win;
  }

  return {
    main(): BrowserWindow {
      return open('main', {
        title: 'Oat',
        width: 1080,
        height: 720,
        minWidth: 720,
        minHeight: 480,
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        trafficLightPosition: { x: 16, y: 18 },
      });
    },
    /** Small always-on-top in-meeting widget (placeholder until 2.5). */
    widget(): BrowserWindow {
      const win = open('widget', {
        title: 'Oat widget',
        width: 320,
        height: 136,
        resizable: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
        frame: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
      });
      win.setAlwaysOnTop(true, 'floating');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      return win;
    },
  };
}
