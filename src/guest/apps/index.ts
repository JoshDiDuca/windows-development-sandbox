// Installs the apps you chose (apps.install from the catalogue, apps.custom of your own) into C:\AgentData\tools\apps.
// Installers are never run: archives are unpacked, NSIS installers opened with 7-Zip and MSIs extracted (msiexec /a),
// so nothing is registered and nothing is lost when the sandbox closes.
export { appsNeedMesa, appsNeedUv } from '../../shared/apps/index.js';
export { setupApps, type AppsOptions } from './app-installer.js';
export { findExe } from './find-exe.js';
