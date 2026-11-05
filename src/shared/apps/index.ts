export {
  type AddonMcp,
  type AppCategory,
  APP_CATEGORIES,
  type AppSource,
  type AppEntry,
  APPS,
  appById,
  CCUSAGE_VERSION,
  CONTEXT7_MCP_VERSION,
  HEADROOM_VERSION,
  PLAYWRIGHT_MCP_VERSION,
  RTK_VERSION,
} from './catalogue.js';
export { ASSOCIATIONS, associationPlan } from './associations.js';
export { previewGuideLine } from './preview.js';
export { exeMatcher, appsToInstall, appsNeedMesa, appsNeedUv, storeApps } from './selection.js';
export { signerMatches, type AppSigner, type Signature } from '../signer.js';
export {
  AGENTS_WEB_APPS,
  BROWSER_USE_VERSION,
  CHROME_DEVTOOLS_MCP_VERSION,
  COMET_DOWNLOAD_URL,
  PERPLEXITY_DESKTOP_FAMILY,
  PERPLEXITY_DESKTOP_PACKAGE,
  PERPLEXITY_DESKTOP_PRODUCT_ID,
  COMET_MCP_VERSION,
  COMET_SIGNER,
  PERPLEXITY_COMPUTER_MCP_URL,
  PERPLEXITY_MCP_VERSION,
} from './catalogue-agents-web.js';
export {
  ADDON_MCP_PREFIX,
  addonGuideLine,
  addonMcpServer,
  type AddonPlace,
  claudeManagedSettings,
  codexWithAddonMcpServers,
  type CodexMcpServer,
  HEADROOM_ENV,
  HEADROOM_PORT,
  HEADROOM_UPSTREAM,
  headroomArgs,
  headroomEnv,
  headroomGuideLine,
  headroomUrl,
  type ManagedSettings,
  type McpServerConfig,
  rtkHookCommand,
  RTK_GUIDE_LINE,
  withAddonMcpServers,
} from './agent-addons.js';
export {
  isStorePackageFile,
  STORE_PACKAGE_MANIFEST,
  StorePackageFileSchema,
  StorePackageManifestSchema,
  storePackageRole,
  type StorePackageFile,
  type StorePackageManifest,
} from './store-package.js';
