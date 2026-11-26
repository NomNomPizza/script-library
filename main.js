// Script Library - standalone app shell (Electron main process)
// The renderer is the same single-file web app; this process gives it
// native folder access so the library can live in a Google Drive folder.
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

app.setName('Script Library');

let mainWindow = null;

// ---- auto-update (electron-updater, fed by GitHub Releases) ----
// Only active in the packaged app; in dev there is nothing to update.
// Flow: check quietly on launch -> download in the background -> tell the
// renderer, which shows a "Restart & install" banner. Nothing is ever
// installed without the user clicking that button (or quitting the app,
// since autoInstallOnAppQuit is on).
let updateState = { status: 'idle', version: null, percent: null };
let updatesWired = false;

function pushUpdateState(patch) {
  // A downloaded update is waiting for the user to install it. Later checks
  // (the 6-hour recheck, or the user clicking "Check for updates" in
  // Settings) can produce error / not-available results for the still-running
  // old version; never let those overwrite the ready state, or the install
  // banner in the renderer vanishes before it can be clicked. A genuinely
  // newer update still lands, because it arrives as its own 'downloaded'.
  if (updateState.status === 'downloaded' && patch.status && patch.status !== 'downloaded') return;
  updateState = { ...updateState, ...patch };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updates:status', updateState);
  }
}

function setupAutoUpdates() {
  if (updatesWired || !app.isPackaged) return;
  updatesWired = true;
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
  autoUpdater.on('error', () => pushUpdateState({ status: 'error' }));

  const check = () => { try { autoUpdater.checkForUpdates().catch(() => {}); } catch { /* offline etc. */ } };
  setTimeout(check, 4000);
  setInterval(check, 6 * 60 * 60 * 1000);

  ipcMain.handle('updates:getState', () => updateState);
  ipcMain.handle('updates:check', async () => {
    try { await autoUpdater.checkForUpdates(); } catch { pushUpdateState({ status: 'error' }); }
    return updateState;
  });
  ipcMain.handle('updates:install', () => { autoUpdater.quitAndInstall(); });
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
    title: 'Script Library',
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
      title: 'Choose your Script Library folder',
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

  ipcMain.handle('app:getVersion', () => app.getVersion());

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
