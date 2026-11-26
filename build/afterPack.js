// electron-builder afterPack hook: ad-hoc sign the macOS app with rcodesign.
// Builds run on Linux, where electron-builder cannot sign; the app is signed
// here, after packing and before the zip is created, so the shipped .app is
// identical in spirit to the previous electron-packager + rcodesign flow.
// (Ad-hoc signing lets the app run; full Squirrel auto-update validation on
// macOS still ultimately wants a paid Apple Developer ID signature.)
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const projectDir = context.packager.projectDir;
  const appPath = path.join(context.appOutDir, 'Script Library.app');
  const rcodesign = path.join(
    projectDir,
    'tools',
    'apple-codesign-0.29.0-x86_64-unknown-linux-musl',
    'rcodesign'
  );
  if (!fs.existsSync(rcodesign)) {
    throw new Error(`rcodesign not found at ${rcodesign}; cannot sign the macOS app.`);
  }
  execFileSync(
    rcodesign,
    ['sign', '--entitlements-xml-file', path.join(projectDir, 'entitlements.plist'), appPath],
    { stdio: 'inherit' }
  );
};
