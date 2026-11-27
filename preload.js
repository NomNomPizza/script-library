// Script Library - preload
// Implements the small slice of the File System Access API the app uses
// (showDirectoryPicker + directory/file handles) on top of native IPC,
// so the exact same app file runs in Chrome and in this standalone app.
const { ipcRenderer } = require('electron');
const path = require('path');

function notFound(what) {
  const err = new Error(`Not found: ${what}`);
  err.name = 'NotFoundError';
  return err;
}

class FileHandlePolyfill {
  constructor(fullPath, name) {
    this._path = fullPath;
    this.name = name;
    this.kind = 'file';
  }

  async getFile() {
    const buf = await ipcRenderer.invoke('fs:read', this._path);
    return new File([buf], this.name);
  }

  async createWritable() {
    const target = this._path;
    const chunks = [];
    let closed = false;
    return {
      async write(data) {
        if (closed) throw new Error('Cannot write after close');
        if (typeof data === 'string') {
          chunks.push(new TextEncoder().encode(data));
        } else if (data instanceof Blob) {
          chunks.push(new Uint8Array(await data.arrayBuffer()));
        } else if (data instanceof ArrayBuffer) {
          chunks.push(new Uint8Array(data));
        } else if (ArrayBuffer.isView(data)) {
          chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        } else if (data && typeof data === 'object' && 'data' in data) {
          // { type: 'write', data } form
          const d = data.data;
          if (typeof d === 'string') chunks.push(new TextEncoder().encode(d));
          else if (d instanceof Blob) chunks.push(new Uint8Array(await d.arrayBuffer()));
          else chunks.push(new Uint8Array(d));
        } else {
          chunks.push(new TextEncoder().encode(String(data)));
        }
      },
      async close() {
        closed = true;
        const total = chunks.reduce((n, c) => n + c.byteLength, 0);
        const merged = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) { merged.set(c, off); off += c.byteLength; }
        await ipcRenderer.invoke('fs:write', target, merged.buffer);
      },
      async abort() { closed = true; }
    };
  }
}

class DirectoryHandlePolyfill {
  constructor(fullPath, name) {
    this._path = fullPath;
    this.name = name;
    this.kind = 'directory';
  }

  _child(name) { return path.join(this._path, name); }

  async getDirectoryHandle(name, options = {}) {
    const child = this._child(name);
    if (options.create) {
      await ipcRenderer.invoke('fs:mkdir', child);
    } else if (!(await ipcRenderer.invoke('fs:exists', child))) {
      throw notFound(name);
    }
    return new DirectoryHandlePolyfill(child, name);
  }

  async getFileHandle(name, options = {}) {
    const child = this._child(name);
    if (options.create) {
      await ipcRenderer.invoke('fs:touch', child);
    } else if (!(await ipcRenderer.invoke('fs:exists', child))) {
      throw notFound(name);
    }
    return new FileHandlePolyfill(child, name);
  }

  async removeEntry(name) {
    await ipcRenderer.invoke('fs:remove', this._child(name));
  }

  async *values() {
    const entries = await ipcRenderer.invoke('fs:list', this._path);
    for (const e of entries) {
      const child = this._child(e.name);
      yield e.isDirectory
        ? new DirectoryHandlePolyfill(child, e.name)
        : new FileHandlePolyfill(child, e.name);
    }
  }

  async *keys() { for await (const h of this.values()) yield h.name; }

  async *entries() { for await (const h of this.values()) yield [h.name, h]; }

  [Symbol.asyncIterator]() { return this.values(); }
}

// Replace the browser API with the native-backed version. The main process
// remembers the last library folder and opens the dialog there.
window.showDirectoryPicker = async function showDirectoryPicker() {
  const picked = await ipcRenderer.invoke('dialog:pickDir');
  if (!picked) {
    const err = new Error('The user aborted a request.');
    err.name = 'AbortError';
    throw err;
  }
  return new DirectoryHandlePolyfill(picked, path.basename(picked));
};

// Bridge used by the app when running in the standalone shell. The main
// process remembers the chosen library folder, so the app can reconnect to
// it automatically on every launch with no dialog and no user action.
window.scriptLibraryNative = {
  isNative: true,
  async getSavedFolder() {
    const saved = await ipcRenderer.invoke('library:getSaved');
    if (!saved) return null;
    return new DirectoryHandlePolyfill(saved, path.basename(saved));
  },
  async chooseFolder() {
    const picked = await ipcRenderer.invoke('dialog:pickDir');
    if (!picked) return null;
    return new DirectoryHandlePolyfill(picked, path.basename(picked));
  },
  async clearSavedFolder() {
    await ipcRenderer.invoke('library:clear');
  },
  // ---- automatic local backup mirror ----
  async getBackupFolder() {
    return ipcRenderer.invoke('backup:get');
  },
  async chooseBackupFolder() {
    return ipcRenderer.invoke('backup:choose');
  },
  async clearBackupFolder() {
    return ipcRenderer.invoke('backup:clear');
  },
  async mirrorBackup(payload) {
    return ipcRenderer.invoke('backup:mirror', payload);
  },
  // ---- Safe Sync bridge (edit locks + library watcher) ----
  // The lock this window currently holds, remembered here so beforeunload
  // can release it with a fire-and-forget send (invoke may not complete
  // while the window is tearing down).
  _heldLock: null,
  async getSyncIdentity() {
    return ipcRenderer.invoke('sync:getIdentity');
  },
  async watchStart(handle) {
    if (!handle || !handle._path) return false;
    return ipcRenderer.invoke('sync:watchStart', handle._path);
  },
  async watchStop() {
    return ipcRenderer.invoke('sync:watchStop');
  },
  async lockAcquire(handle, scriptId, title, force) {
    if (!handle || !handle._path) return { ok: false, holder: null };
    const res = await ipcRenderer.invoke('sync:lockAcquire', handle._path, scriptId, { title: title || '' }, !!force);
    if (res && res.ok) this._heldLock = { root: handle._path, scriptId };
    return res;
  },
  async lockHeartbeat(handle, scriptId) {
    if (!handle || !handle._path) return false;
    return ipcRenderer.invoke('sync:lockHeartbeat', handle._path, scriptId);
  },
  async lockRelease(handle, scriptId) {
    if (this._heldLock && this._heldLock.scriptId === scriptId) this._heldLock = null;
    if (!handle || !handle._path) return false;
    return ipcRenderer.invoke('sync:lockRelease', handle._path, scriptId);
  },
  async lockStatus(handle, scriptId) {
    if (!handle || !handle._path) return { locked: false, mine: false, stale: true, holder: null };
    return ipcRenderer.invoke('sync:lockStatus', handle._path, scriptId);
  },
  onExternalChange(cb) {
    ipcRenderer.on('sync:external', (_e, evt) => cb(evt));
  },
  // ---- auto-update bridge (main process owns electron-updater) ----
  async getVersion() {
    return ipcRenderer.invoke('app:getVersion');
  },
  async getUpdateState() {
    return ipcRenderer.invoke('updates:getState');
  },
  async checkForUpdates() {
    return ipcRenderer.invoke('updates:check');
  },
  async installUpdate() {
    return ipcRenderer.invoke('updates:install');
  },
  async openReleasePage() {
    return ipcRenderer.invoke('shell:openReleasePage');
  },
  onUpdateStatus(cb) {
    ipcRenderer.on('updates:status', (_e, state) => cb(state));
  }
};

// Release the held edit lock the moment the window goes away, using a
// synchronous-style send: async invokes are not guaranteed to complete
// during unload, and a stranded lock would block the other computer
// until it goes stale (45s).
window.addEventListener('beforeunload', () => {
  const held = window.scriptLibraryNative && window.scriptLibraryNative._heldLock;
  if (held) {
    try { ipcRenderer.send('sync:lockReleaseSync', held.root, held.scriptId); } catch { /* stale timeout covers it */ }
  }
});

window.__scriptLibraryStandalone = true;
