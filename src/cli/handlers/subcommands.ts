// Public subcommand facade; implementations live in focused handler modules.
import type { CommandHandler } from "./types.js";
import { sessionHandler } from "./session.js";
import { feedbackHandler } from "./feedback.js";
import { quickrefHandler } from "./subcommands-quickref.js";
export { quickrefHandler };
import { listHandler } from "./subcommands-list.js";
export { listHandler };
import { removeHandler } from "./remove.js";
export { removeHandler };
import { promoteHandler, newBundleHandler } from "./subcommands-bundles.js";
export { promoteHandler, newBundleHandler };
import { newProjectHandler, installPluginHandler, uninstallPluginHandler, pluginStatusHandler, packagePluginHandler, packageAllPluginsHandler } from "./subcommands-plugins.js";
export { newProjectHandler, installPluginHandler, uninstallPluginHandler, pluginStatusHandler, packagePluginHandler, packageAllPluginsHandler };
import { indexHandler, corpusHandler, discoverHandler, featuresHandler, showHandler, skillsHandler } from "./subcommands-discovery.js";
export { indexHandler, corpusHandler, discoverHandler, featuresHandler, showHandler, skillsHandler };
import { configHandler, opsHandler, activityLogHandler, provenanceHandler, researchStoreHandler, researchQueryHandler, reflectionsHandler, memoryHandler, kbHandler } from "./subcommands-storage.js";
export { configHandler, opsHandler, activityLogHandler, provenanceHandler, researchStoreHandler, researchQueryHandler, reflectionsHandler, memoryHandler, kbHandler };
import { storageHandler, rlmToolsHandler, chunkHandler, fanoutHandler, rlmPrepHandler, rlmSearchHandler, rlmStatusCliHandler, rlmCacheHandler } from "./subcommands-rlm.js";
export { storageHandler, rlmToolsHandler, chunkHandler, fanoutHandler, rlmPrepHandler, rlmSearchHandler, rlmStatusCliHandler, rlmCacheHandler };
import { mcpHandler, catalogHandler } from "./subcommands-services.js";
export { mcpHandler, catalogHandler };
export const subcommandHandlers: CommandHandler[] = [
  mcpHandler,
  catalogHandler,
  listHandler,
  removeHandler,
  newProjectHandler,
  installPluginHandler,
  uninstallPluginHandler,
  pluginStatusHandler,
  packagePluginHandler,
  packageAllPluginsHandler,
  indexHandler,
  discoverHandler,
  showHandler,
  featuresHandler,
  skillsHandler,
  configHandler,
  opsHandler,
  storageHandler,
  activityLogHandler,
  kbHandler,
  memoryHandler,
  reflectionsHandler,
  provenanceHandler,
  researchStoreHandler,
  researchQueryHandler,
  chunkHandler,
  fanoutHandler,
  rlmPrepHandler,
  rlmSearchHandler,
  rlmStatusCliHandler,
  rlmCacheHandler,
  sessionHandler,
  feedbackHandler,
];
