// Script Library - standalone app shell (Electron main process)
// The renderer is the same single-file web app; this process gives it
// native folder access so the library can live in a Google Drive folder.
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { spawn } = require('child_process');

// The app was renamed to Scripture in v1.6.0. Pin the userData folder to
// the original "Script Library" location so the rename does not orphan
// the remembered library folder, the backup folder, or the update logs.
app.setPath('userData', path.join(app.getPath('appData'), 'Script Library'));
app.setName('Scripture');

let mainWindow = null;

// ---- auto-update (fed by GitHub Releases) ----
// Only active in the packaged app; in dev there is nothing to update.
// Flow: check quietly on launch -> download in the background -> tell the
// renderer, which shows a "Restart & install" banner.
//
// Windows uses electron-updater. macOS uses a small built-in updater
// instead of electron-updater's Squirrel.Mac: this app is ad-hoc signed
// (no paid Developer ID yet) and is often run from outside /Applications,
// and in both situations Squirrel's install step fails silently. The
// download succeeds and the banner shows, but "Restart & install" and
// install-on-quit do nothing and no error ever reaches the user. The
// built-in Mac updater downloads the release zip itself, verifies it
// against the sha512 in the update feed, and hands it to a detached
// helper script that swaps the app bundle once this process exits.
// Every step is logged to update.log in the userData folder, and install
// problems are surfaced in the banner and Settings instead of vanishing.
let updateState = { status: 'idle', version: null, percent: null, installError: null };
let updatesWired = false;
let stagedMacUpdate = null;      // { version, zipPath } once a Mac update is downloaded
let installHelperSpawned = false;

function updateLog(msg) {
  try {
    const p = path.join(app.getPath('userData'), 'update.log');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, new Date().toISOString() + ' ' + msg + '\n');
  } catch { /* logging must never break updating */ }
}

function pushUpdateState(patch) {
  // A downloaded update is waiting for the user to install it. Later checks
  // (the 6-hour recheck, or the user clicking "Check for updates" in
  // Settings) can produce error / not-available results for the still-running
  // old version; never let those overwrite the ready state, or the install
  // banner in the renderer vanishes before it can be clicked. An install
  // error is the one exception: it is attached to the ready state as
  // `installError` so the user actually sees what went wrong. A genuinely
  // newer update still lands, because it arrives as its own 'downloaded'.
  if (updateState.status === 'downloaded' && patch.status && patch.status !== 'downloaded') {
    if (patch.status === 'error') {
      updateState = { ...updateState, installError: patch.message || 'Something went wrong while installing.' };
      updateLog('error surfaced on the ready state: ' + updateState.installError);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updates:status', updateState);
      }
    }
    return;
  }
  if (patch.status === 'downloaded') patch = { ...patch, installError: null };
  updateState = { ...updateState, ...patch };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updates:status', updateState);
  }
}

/* ---------- shared helpers (also exercised by the test rig) ---------- */

function semverNewer(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

function parseMacFeed(text) {
  const version = (String(text).match(/^version:\s*(\S+)\s*$/m) || [])[1] || null;
  const file = (String(text).match(/-\s*url:\s*(\S+)\s*$/m) || [])[1] || null;
  const sha512 = (String(text).match(/sha512:\s*(\S+)\s*$/m) || [])[1] || null;
  return { version, file, sha512 };
}

function shq(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

// The detached helper that performs a Mac install after the app exits:
// wait for our pid, unzip the verified download, swap the app bundle
// (keeping a backup until the new one is in place), strip the quarantine
// flag, optionally relaunch, and log everything it does.
function buildMacInstallScript(opts) {
  return [
    '#!/bin/sh',
    'PID=' + Number(opts.pid),
    'ZIP=' + shq(opts.zipPath),
    'DEST=' + shq(opts.dest),
    'LOG=' + shq(opts.logPath),
    'RELAUNCH=' + (opts.relaunch ? '1' : '0'),
    'exec >>"$LOG" 2>&1',
    'echo "=== install attempt $(date) pid=$PID dest=$DEST relaunch=$RELAUNCH"',
    'while kill -0 "$PID" 2>/dev/null; do sleep 0.3; done',
    'echo "app exited; installing"',
    'TMP=$(mktemp -d)',
    'if ! ditto -x -k "$ZIP" "$TMP"; then echo "FAIL: unzip"; rm -rf "$TMP"; exit 1; fi',
    'NEWAPP=$(find "$TMP" -maxdepth 2 -name "*.app" -type d | head -1)',
    'if [ -z "$NEWAPP" ]; then echo "FAIL: no .app in the download"; rm -rf "$TMP"; exit 1; fi',
    'FINAL="$(dirname "$DEST")/$(basename "$NEWAPP")"',
    'BACKUP="$FINAL.backup"',
    'rm -rf "$BACKUP"',
    'if [ -e "$FINAL" ]; then mv "$FINAL" "$BACKUP" || { echo "FAIL: could not move the old app aside"; rm -rf "$TMP"; exit 1; }; fi',
    'if ! mv "$NEWAPP" "$FINAL"; then echo "FAIL: could not move the new app in"; [ -e "$BACKUP" ] && mv "$BACKUP" "$FINAL"; rm -rf "$TMP"; exit 1; fi',
    'if [ "$FINAL" != "$DEST" ] && [ -e "$DEST" ]; then rm -rf "$DEST"; echo "removed the old-named bundle"; fi',
    'xattr -dr com.apple.quarantine "$FINAL" 2>/dev/null',
    'rm -rf "$BACKUP" "$TMP" "$ZIP"',
    'echo "installed OK"',
    'if [ "$RELAUNCH" = "1" ]; then open "$FINAL"; echo "relaunched"; fi',
    ''
  ].join('\n');
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const request = (current, redirects) => {
      https.get(current, { headers: { 'User-Agent': 'Script-Library-Updater' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects > 8) return reject(new Error('Too many redirects'));
          return request(new URL(res.headers.location, current).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('Update feed failed: HTTP ' + res.statusCode)); }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { body += d; });
        res.on('end', () => resolve(body));
        res.on('error', reject);
      }).on('error', reject);
    };
    request(url, 0);
  });
}

function downloadToFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const request = (current, redirects) => {
      https.get(current, { headers: { 'User-Agent': 'Script-Library-Updater' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects > 8) return reject(new Error('Too many redirects'));
          return request(new URL(res.headers.location, current).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error('Download failed: HTTP ' + res.statusCode)); }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let received = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (chunk) => { received += chunk.length; if (total && onProgress) onProgress(Math.min(99, Math.round(received / total * 100))); });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(received)));
        out.on('error', reject);
        res.on('error', reject);
      }).on('error', reject);
    };
    request(url, 0);
  });
}

function sha512Base64(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha512');
    const s = fs.createReadStream(file);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('base64')));
    s.on('error', reject);
  });
}

/* ---------- Windows / Linux: electron-updater ---------- */

function setupElectronUpdater() {
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch { return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => pushUpdateState({ status: 'checking', percent: null }));
  autoUpdater.on('update-available', (info) => pushUpdateState({ status: 'available', version: info && info.version || null }));
  autoUpdater.on('update-not-available', () => pushUpdateState({ status: 'none', percent: null }));
  autoUpdater.on('download-progress', (p) => pushUpdateState({ status: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (info) => pushUpdateState({ status: 'downloaded', version: info && info.version || null, percent: 100 }));
  autoUpdater.on('error', (err) => {
    updateLog('updater error: ' + (err && err.message || err));
    pushUpdateState({ status: 'error', message: String(err && err.message || err || 'Update error') });
  });

  const check = () => { try { autoUpdater.checkForUpdates().catch(() => {}); } catch { /* offline etc. */ } };
  setTimeout(check, 4000);
  setInterval(check, 6 * 60 * 60 * 1000);

  ipcMain.handle('updates:check', async () => {
    try { await autoUpdater.checkForUpdates(); } catch { pushUpdateState({ status: 'error', message: 'Could not check for updates.' }); }
    return updateState;
  });
  ipcMain.handle('updates:install', () => {
    updateLog('install requested (electron-updater)');
    try {
      autoUpdater.quitAndInstall(false, true);
    } catch (err) {
      updateLog('quitAndInstall threw: ' + (err && err.message || err));
      pushUpdateState({ status: 'error', message: String(err && err.message || err) });
    }
  });
}

/* ---------- macOS: built-in updater (see the header note) ---------- */

const MAC_FEED_URL = 'https://github.com/NomNomPizza/script-library/releases/latest/download/latest-mac.yml';
let macCheckInFlight = false;

async function macCheck() {
  if (macCheckInFlight) return updateState;
  macCheckInFlight = true;
  try {
    pushUpdateState({ status: 'checking', percent: null });
    const feed = parseMacFeed(await fetchText(MAC_FEED_URL));
    if (!feed.version || !feed.file) throw new Error('The update feed could not be read.');
    updateLog('mac check: running ' + app.getVersion() + ', latest ' + feed.version);
    if (!semverNewer(feed.version, app.getVersion())) {
      stagedMacUpdate = null;
      pushUpdateState({ status: 'none', percent: null });
      return updateState;
    }
    if (stagedMacUpdate && stagedMacUpdate.version === feed.version && fs.existsSync(stagedMacUpdate.zipPath)) {
      pushUpdateState({ status: 'downloaded', version: feed.version, percent: 100 });
      return updateState;
    }
    pushUpdateState({ status: 'available', version: feed.version });
    const dir = path.join(app.getPath('userData'), 'updates');
    await fs.promises.mkdir(dir, { recursive: true });
    const zipPath = path.join(dir, feed.file);
    const partPath = zipPath + '.partial';
    const url = 'https://github.com/NomNomPizza/script-library/releases/download/v' + feed.version + '/' + encodeURIComponent(feed.file);
    await downloadToFile(url, partPath, (pct) => pushUpdateState({ status: 'downloading', version: feed.version, percent: pct }));
    if (feed.sha512) {
      const digest = await sha512Base64(partPath);
      if (digest !== feed.sha512) {
        try { fs.unlinkSync(partPath); } catch { /* ignore */ }
        throw new Error('The downloaded update did not pass its integrity check.');
      }
    }
    fs.renameSync(partPath, zipPath);
    stagedMacUpdate = { version: feed.version, zipPath };
    updateLog('mac update downloaded and verified: ' + feed.version);
    pushUpdateState({ status: 'downloaded', version: feed.version, percent: 100 });
  } catch (err) {
    updateLog('mac check failed: ' + (err && err.message || err));
    pushUpdateState({ status: 'error', message: String(err && err.message || err || 'Check failed') });
  } finally {
    macCheckInFlight = false;
  }
  return updateState;
}

function macBundlePath() {
  // process.execPath is <App>.app/Contents/MacOS/<binary>
  return path.resolve(process.execPath, '..', '..', '..');
}

function macInstallDestination() {
  const current = macBundlePath();
  // A quarantined app launched from outside /Applications runs from a
  // read-only translocated copy; its bundle path cannot be replaced, so
  // install to /Applications instead (which also ends the translocation
  // for good). The same fallback applies if the current folder is not
  // writable for any other reason.
  if (!current.includes('/AppTranslocation/')) {
    try { fs.accessSync(path.dirname(current), fs.constants.W_OK); return current; } catch { /* fall through */ }
  }
  try { fs.accessSync('/Applications', fs.constants.W_OK); return path.join('/Applications', path.basename(current)); } catch { /* fall through */ }
  const homeApps = path.join(app.getPath('home'), 'Applications');
  try { fs.mkdirSync(homeApps, { recursive: true }); return path.join(homeApps, path.basename(current)); } catch { /* fall through */ }
  return current;
}

function spawnMacInstallHelper(relaunch) {
  if (!stagedMacUpdate || installHelperSpawned) return installHelperSpawned;
  installHelperSpawned = true;
  try {
    const dest = macInstallDestination();
    const scriptPath = path.join(app.getPath('userData'), 'updates', 'install-update.sh');
    const script = buildMacInstallScript({
      pid: process.pid,
      zipPath: stagedMacUpdate.zipPath,
      dest,
      logPath: path.join(app.getPath('userData'), 'update-install.log'),
      relaunch
    });
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, script, { mode: 0o755 });
    const child = spawn('/bin/sh', [scriptPath], { detached: true, stdio: 'ignore' });
    child.unref();
    updateLog('install helper spawned: dest=' + dest + ' relaunch=' + relaunch + ' version=' + stagedMacUpdate.version);
    return true;
  } catch (err) {
    installHelperSpawned = false;
    updateLog('could not spawn the install helper: ' + (err && err.message || err));
    pushUpdateState({ status: 'error', message: 'Could not start the installer: ' + String(err && err.message || err) });
    return false;
  }
}

function setupMacUpdater() {
  ipcMain.handle('updates:check', () => macCheck());
  ipcMain.handle('updates:install', () => {
    updateLog('install requested (mac helper)');
    if (!stagedMacUpdate) {
      pushUpdateState({ status: 'error', message: 'No downloaded update is ready to install.' });
      return updateState;
    }
    if (spawnMacInstallHelper(true)) setTimeout(() => app.quit(), 200);
    return updateState;
  });
  // Kyle's rule: if an update has been downloaded, simply closing the app
  // installs it too (without relaunching; he closed it on purpose).
  app.on('before-quit', () => {
    if (stagedMacUpdate && !installHelperSpawned) {
      updateLog('app quitting with a downloaded update staged; helper will install it');
      spawnMacInstallHelper(false);
    }
  });
  setTimeout(() => { macCheck(); }, 4000);
  setInterval(() => { macCheck(); }, 6 * 60 * 60 * 1000);
}

function setupAutoUpdates() {
  if (updatesWired || !app.isPackaged) return;
  updatesWired = true;
  updateLog('updater starting: platform=' + process.platform + ' version=' + app.getVersion());
  ipcMain.handle('updates:getState', () => updateState);
  if (process.platform === 'darwin') setupMacUpdater();
  else setupElectronUpdater();
}

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); }
  catch { return {}; }
}
function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  } catch { /* remembering the folder is a convenience, never fatal */ }
  return next;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 860,
    minHeight: 560,
    title: 'Scripture',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: false
    }
  });

  // The app autosaves continuously, so nothing is ever unsaved: never let a
  // beforeunload handler veto closing the window (this was the real cause of
  // the "close button does nothing, must force-quit" bug).
  win.webContents.on('will-prevent-unload', (event) => {
    event.preventDefault();
  });

  // The app is a single local file: no navigation away, no pop-up windows.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) e.preventDefault();
  });

  win.loadFile(path.join(__dirname, 'app', 'index.html'));
  mainWindow = win;
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
}

app.whenReady().then(() => {
  // ---- folder picking (native dialog, remembers the last library) ----
  ipcMain.handle('dialog:pickDir', async () => {
    const remembered = readSettings().lastLibrary;
    const result = await dialog.showOpenDialog({
      title: 'Choose your Scripture library folder',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: remembered && fs.existsSync(remembered) ? remembered : undefined
    });
    if (result.canceled || !result.filePaths.length) return null;
    const picked = result.filePaths[0];
    writeSettings({ lastLibrary: picked });
    return picked;
  });

  // ---- file system primitives used by the preload's handle polyfill ----
  ipcMain.handle('fs:read', async (_e, filePath) => {
    const buf = await fs.promises.readFile(filePath);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });

  ipcMain.handle('fs:write', async (_e, filePath, arrayBuffer) => {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    await fs.promises.writeFile(filePath, Buffer.from(arrayBuffer));
  });

  ipcMain.handle('fs:mkdir', async (_e, dirPath) => {
    await fs.promises.mkdir(dirPath, { recursive: true });
  });

  ipcMain.handle('fs:touch', async (_e, filePath) => {
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    try { await fs.promises.access(filePath); }
    catch { await fs.promises.writeFile(filePath, ''); }
  });

  ipcMain.handle('fs:exists', async (_e, targetPath) => {
    try { await fs.promises.access(targetPath); return true; }
    catch { return false; }
  });

  ipcMain.handle('fs:list', async (_e, dirPath) => {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    return entries.map(e => ({ name: e.name, isDirectory: e.isDirectory() }));
  });

  ipcMain.handle('fs:remove', async (_e, targetPath) => {
    await fs.promises.rm(targetPath, { recursive: true, force: true });
  });

  // ---- saved library folder (window.scriptLibraryNative bridge) ----
  ipcMain.handle('library:getSaved', async () => {
    const saved = readSettings().lastLibrary;
    if (saved && fs.existsSync(saved)) return saved;
    return null;
  });

  ipcMain.handle('library:clear', async () => {
    const settings = readSettings();
    delete settings.lastLibrary;
    try {
      fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
      fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
    } catch { /* non-fatal */ }
  });

  // ---- automatic local backup mirror ----
  // The user picks a second folder (kept outside the synced library
  // folder); after every save the renderer sends the full serialized
  // library and this process keeps the backup folder identical to it.
  ipcMain.handle('backup:get', () => {
    const p = readSettings().backupLibrary;
    return p ? { path: p, name: path.basename(p) } : null;
  });

  ipcMain.handle('backup:choose', async () => {
    const current = readSettings();
    const result = await dialog.showOpenDialog({
      title: 'Choose a folder for the automatic local backup',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: current.backupLibrary && fs.existsSync(current.backupLibrary) ? current.backupLibrary : undefined
    });
    if (result.canceled || !result.filePaths.length) return null;
    const picked = result.filePaths[0];
    if (current.lastLibrary && path.resolve(picked) === path.resolve(current.lastLibrary)) {
      return { error: 'That is your library folder itself. Pick a different folder, so the backup stays a separate copy.' };
    }
    writeSettings({ backupLibrary: picked });
    return { path: picked, name: path.basename(picked) };
  });

  ipcMain.handle('backup:clear', async () => {
    const settings = readSettings();
    delete settings.backupLibrary;
    try {
      fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
      fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
    } catch { /* non-fatal */ }
    return true;
  });

  ipcMain.handle('backup:mirror', async (_e, payload) => {
    const dir = readSettings().backupLibrary;
    if (!dir || !payload) return { ok: false };
    const lib = readSettings().lastLibrary;
    if (lib && path.resolve(lib) === path.resolve(dir)) return { ok: false };
    const scriptsDir = path.join(dir, 'scripts');
    await fs.promises.mkdir(scriptsDir, { recursive: true });
    await fs.promises.writeFile(path.join(dir, 'library.json'), String(payload.library || ''));
    const keep = new Set();
    for (const item of payload.scripts || []) {
      if (!item || !item.id) continue;
      keep.add(item.id + '.json');
      await fs.promises.writeFile(path.join(scriptsDir, item.id + '.json'), String(item.json || ''));
    }
    const existing = await fs.promises.readdir(scriptsDir);
    for (const name of existing) {
      if (name.endsWith('.json') && !keep.has(name)) {
        await fs.promises.rm(path.join(scriptsDir, name), { force: true });
      }
    }
    return { ok: true };
  });

  ipcMain.handle('app:getVersion', () => app.getVersion());

  // Manual fallback for updates: open the GitHub releases page.
  ipcMain.handle('shell:openReleasePage', () => {
    shell.openExternal('https://github.com/NomNomPizza/script-library/releases/latest');
  });

  createWindow();
  setupAutoUpdates();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // Single-window utility app: closing the window quits, on every platform.
  // (The macOS "stay in the Dock" convention confused the user, who had to
  // force-quit; close means quit here.)
  app.quit();
});
