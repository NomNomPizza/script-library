// electron-builder afterPack hook: ad-hoc sign the macOS app.
// Runs after packing and before the zip is created, so the shipped .app is
// signed the same way in every build environment:
// - On a Mac (e.g. GitHub Actions macos runners): native codesign, ad-hoc.
// - On Linux (local builds): rcodesign from the untracked tools/ folder.
// (Ad-hoc signing lets the app run; full Squirrel auto-update validation on
// macOS still ultimately wants a paid Apple Developer ID signature.)
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const projectDir = context.packager.projectDir;
  // Find the bundle by extension: the app was renamed to Scripture in
  // v1.6.0 and a hardcoded bundle name broke the build once already.
  const bundleName = fs.readdirSync(context.appOutDir).find((n) => n.endsWith('.app'));
  if (!bundleName) throw new Error('afterPack: no .app bundle found in ' + context.appOutDir);
  const appPath = path.join(context.appOutDir, bundleName);
  const entitlements = path.join(projectDir, 'entitlements.plist');

  if (process.platform === 'darwin') {
    execFileSync(
      'codesign',
      ['--force', '--deep', '--sign', '-', '--entitlements', entitlements, appPath],
      { stdio: 'inherit' }
    );
    return;
  }

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
    ['sign', '--entitlements-xml-file', entitlements, appPath],
    { stdio: 'inherit' }
  );
};
