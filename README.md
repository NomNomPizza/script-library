# Script Library

A script writing app for Primink and Globby videos: an Eagle-style library
folder (point it at a Google Drive folder and every machine stays in sync),
a rich-text editor, read-time estimates, and a fullscreen teleprompter.

## Running it

Install the latest build from the Releases page:

- **Windows:** download the `Script-Library-Setup-<version>.exe` installer.
- **Mac (Apple Silicon):** download the `Script-Library-<version>-arm64-mac.zip`,
  unzip, and move "Script Library" to Applications. The Mac build is ad-hoc
  signed, so on first launch you may need to right-click the app and choose
  Open.

## Updates

The app checks GitHub Releases for updates on launch and every 6 hours.
Updates download in the background; when one is ready, a banner offers
"Restart & install" (installing also happens automatically on quit).
You can also check manually in Settings -> App updates.

Windows updates install fully automatically. On macOS, Apple's updater
validates the app signature, and ad-hoc signing may make it decline the
in-place install; if that happens, just download the newest zip from the
Releases page. (A paid Apple Developer ID removes this limitation.)

## Cutting a new release

1. Bump `version` in `package.json`.
2. `npm run release` (builds Windows NSIS + Mac zip and publishes them to a
   GitHub release draft via electron-builder), or build locally with
   `npm run dist` and upload the files from `dist/` to a release tagged
   `v<version>` by hand. The `latest.yml` / `latest-mac.yml` files in `dist/`
   must be uploaded too; they are what the updater reads.
3. Publish the release. Installed apps pick it up on their next check.

## Development

```
npm install
npm start
```

Packaging uses electron-builder (config in `package.json`). The macOS build
is ad-hoc signed during packaging by `build/afterPack.js` using the bundled
rcodesign tool in `tools/` (not tracked in git; fetch Apple Code Signing
tools 0.29.0 to restore it).
