import { app, BrowserWindow, Menu, dialog, session, shell } from 'electron';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { externalLink, sameOrigin, trustedOrigin } from './policy.js';
import { checkUpdates, type UpdateSettings } from './updates.js';
interface Settings {
  origin: string;
  updates?: UpdateSettings;
}
app.enableSandbox();
if (!app.requestSingleInstanceLock()) app.quit();
else {
  let window: BrowserWindow | undefined;
  app.on('second-instance', () => {
    window?.show();
    window?.focus();
  });
  if (!app.isPackaged && process.env.ORBIT_DESKTOP_USER_DATA)
    app.setPath('userData', process.env.ORBIT_DESKTOP_USER_DATA);
  void app
    .whenReady()
    .then(async () => {
      const settings: Settings = app.isPackaged
        ? JSON.parse(await readFile(join(process.resourcesPath, 'client.json'), 'utf8'))
        : { origin: process.env.ORBIT_DESKTOP_ORIGIN ?? 'http://localhost:3000' };
      const origin = trustedOrigin(settings.origin, !app.isPackaged);
      const profile = session.fromPartition('orbit-private');
      profile.setPermissionCheckHandler((contents, permission, requestingOrigin) =>
        Boolean(
          contents &&
          sameOrigin(contents.getURL(), origin) &&
          sameOrigin(requestingOrigin, origin) &&
          ['media', 'notifications', 'fullscreen'].includes(permission),
        ),
      );
      profile.setPermissionRequestHandler(async (contents, permission, callback, details) => {
        if (
          contents.isDestroyed() ||
          !details.isMainFrame ||
          !sameOrigin(details.requestingUrl, origin) ||
          !sameOrigin(contents.getURL(), origin) ||
          !['media', 'notifications', 'fullscreen'].includes(permission)
        ) {
          callback(false);
          return;
        }
        if (permission === 'fullscreen') {
          callback(true);
          return;
        }
        const result = await dialog.showMessageBox({
          type: 'question',
          buttons: ['Allow', 'Deny'],
          defaultId: 1,
          cancelId: 1,
          message:
            permission === 'media'
              ? 'Allow Orbit to use your microphone or camera?'
              : 'Allow Orbit notifications?',
        });
        callback(
          result.response === 0 && !contents.isDestroyed() && sameOrigin(contents.getURL(), origin),
        );
      });
      profile.setDisplayMediaRequestHandler((_request, callback) => callback({}));
      profile.on('will-download', (event, item) => {
        if (!sameOrigin(item.getURL(), origin)) {
          event.preventDefault();
          return;
        }
        item.setSaveDialogOptions({ title: 'Save Orbit file' });
      });
      function open() {
        if (window) {
          window.show();
          return;
        }
        window = new BrowserWindow({
          width: 1440,
          height: 960,
          minWidth: 850,
          minHeight: 600,
          show: false,
          title: 'Orbit',
          backgroundColor: '#18181b',
          webPreferences: {
            session: profile,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            webviewTag: false,
            spellcheck: true,
          },
        });
        window.webContents.on('will-navigate', (event, url) => {
          if (!sameOrigin(url, origin)) {
            event.preventDefault();
            if (externalLink(url)) void shell.openExternal(url);
          }
        });
        window.webContents.on('will-redirect', (event, url) => {
          if (!sameOrigin(url, origin)) event.preventDefault();
        });
        window.webContents.setWindowOpenHandler(({ url }) => {
          if (externalLink(url)) void shell.openExternal(url);
          return { action: 'deny' };
        });
        window.webContents.on('will-attach-webview', (event) => event.preventDefault());
        window.on('closed', () => {
          window = undefined;
        });
        window.once('ready-to-show', () => {
          if (process.env.ORBIT_DESKTOP_SMOKE !== '1') window?.show();
        });
        void window.loadURL(origin + '/app');
      }
      let checking = false;
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: 'Orbit',
            submenu: [
              {
                label: 'Check for updates',
                enabled: Boolean(settings.updates) && app.isPackaged,
                click: async () => {
                  if (checking || !settings.updates) return;
                  checking = true;
                  try {
                    await checkUpdates(settings.updates);
                  } catch {
                    await dialog.showMessageBox({
                      type: 'error',
                      message: 'The update could not be verified. No update was installed.',
                    });
                  } finally {
                    checking = false;
                  }
                },
              },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
          { role: 'editMenu' },
          { role: 'viewMenu' },
          { role: 'windowMenu' },
        ]),
      );
      open();
      app.on('activate', open);
      app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
      });
      app.on('before-quit', () => {
        void profile.clearStorageData();
      });
    })
    .catch(() => {
      dialog.showErrorBox('Orbit could not start', 'Check the trusted client configuration.');
      app.quit();
    });
}
