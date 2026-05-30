const path = require('path');
const { notarize } = require('@electron/notarize');

exports.default = async function notarizeMac(context) {
  if (process.platform !== 'darwin') {
    console.log('[notarize] skipped: not running on macOS');
    return;
  }
  if (context.electronPlatformName !== 'darwin') {
    console.log(`[notarize] skipped: target is ${context.electronPlatformName}`);
    return;
  }
  if (process.env.SIGN_AVAILABLE !== 'true' || process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'true') {
    console.log('[notarize] skipped: macOS code signing is not available');
    return;
  }
  if (process.env.NOTARIZE_AFTER_DMG === 'true') {
    console.log('[notarize] skipped: workflow will notarize and staple the DMG after packaging');
    return;
  }

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD || process.env.APPLE_ID_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !appleIdPassword || !teamId) {
    console.log('[notarize] skipped: APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, or APPLE_TEAM_ID is missing');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`[notarize] submitting ${appPath}`);

  await notarize({
    tool: 'notarytool',
    appBundleId: context.packager.appInfo.appId,
    appPath,
    appleId,
    appleIdPassword,
    teamId,
  });

  console.log('[notarize] complete');
};
