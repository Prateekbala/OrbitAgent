import { readFile } from 'node:fs/promises';
import { dialog, app } from 'electron';
import updater from 'electron-updater';
import { digestArtifact, sameOrigin, trustedOrigin, verifyManifest } from './policy.js';
export interface UpdateSettings {
  origin: string;
  publicKey: string;
}
export async function checkUpdates(settings: UpdateSettings) {
  if (!app.isPackaged || !['darwin', 'win32'].includes(process.platform))
    throw new Error('Signed packaged builds are required for updates.');
  const origin = trustedOrigin(settings.origin),
    base = `${origin}/${process.platform}/${process.arch}/`;
  const response = await fetch(base + 'release.json', {
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 16384)
    throw new Error('Update manifest unavailable.');
  let signature = response.headers.get('x-orbit-signature');
  if (!signature) {
    const signed = await fetch(base + 'release.json.sig', {
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
    });
    if (!signed.ok) throw new Error('The release manifest is unsigned.');
    signature = await signed.text();
  }
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature.trim()))
    throw new Error('The release signature is invalid.');
  signature = signature.trim();
  if (!response.body) throw new Error('Empty update manifest.');
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.byteLength;
    if (size > 16384) throw new Error('Update manifest is too large.');
    parts.push(part);
  }
  const manifest = verifyManifest(
    Buffer.concat(parts),
    signature,
    settings.publicKey,
    app.getVersion(),
    origin,
  );
  const { autoUpdater } = updater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.setFeedURL({ provider: 'generic', url: base });
  const result = await autoUpdater.checkForUpdates();
  if (
    !result ||
    result.updateInfo.version !== manifest.version ||
    result.updateInfo.files.length !== 1
  )
    throw new Error('Release metadata differs from its signature.');
  const file = result.updateInfo.files[0]!;
  if (
    new URL(file.url, base).href !== manifest.artifact ||
    file.sha512 !== manifest.sha512 ||
    !sameOrigin(manifest.artifact, origin)
  )
    throw new Error('Update artifact differs from the signed manifest.');
  const consent = await dialog.showMessageBox({
    type: 'info',
    buttons: ['Download update', 'Later'],
    defaultId: 1,
    cancelId: 1,
    message: `Orbit ${manifest.version} is available.`,
    detail:
      'The download must match the signed release manifest and pass publisher signature verification.',
  });
  if (consent.response !== 0) return;
  const paths = await autoUpdater.downloadUpdate();
  if (paths.length !== 1 || digestArtifact(await readFile(paths[0]!)) !== manifest.sha512)
    throw new Error('Downloaded update integrity failed.');
  const restart = await dialog.showMessageBox({
    type: 'info',
    buttons: ['Restart and install', 'Later'],
    defaultId: 1,
    cancelId: 1,
    message: 'The update is ready.',
    detail: 'Restart when your current work is saved.',
  });
  if (restart.response === 0) autoUpdater.quitAndInstall(false, true);
}
