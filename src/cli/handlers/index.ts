/**
 * CLI Handler Index
 *
 * Aggregates all extracted command handlers for registry-based routing.
 *
 * @implements @.aiwg/architecture/decisions/ADR-001-unified-extension-system.md
 * @tests @test/unit/cli/handlers/index.test.ts
 * @issue #42
 */

// Re-export types
export * from './types.js';
export { createScriptRunner, DefaultScriptRunner } from './script-runner.js';

// Import all handlers
import { helpHandler } from './help.js';
import { versionHandler } from './version.js';
import { authHandler } from './auth.js';
import { useHandler } from './use.js';
import {
  statusHandler,
  wizardHandler,
  migrateWorkspaceHandler,
  rollbackWorkspaceHandler,
  workspaceHandlers,
} from './workspace.js';
import {
  prefillCardsHandler,
  contributeStartHandler,
  validateMetadataHandler,
  doctorHandler,
  contextFirewallHandler,
  updateHandler,
  utilityHandlers,
} from './utilities.js';
import { skillLintHandler } from './skill-lint.js';
import {
  addAgentHandler,
  addCommandHandler,
  addSkillHandler,
  addBehaviorHandler,
  addTemplateHandler,
  scaffoldAddonHandler,
  scaffoldExtensionHandler,
  scaffoldFrameworkHandler,
  scaffoldingHandlers,
} from './scaffolding.js';
import {
  behaviorHandler,
  daemonInitHandler,
  daemonHandlers,
} from './daemon.js';
import {
  ralphHandler,
  ralphStatusHandler,
  ralphAbortHandler,
  ralphResumeHandler,
  ralphAttachHandler,
  ralphExternalHandler,
  ralphMemoryHandler,
  ralphConfigHandler,
  ralphHandlers,
} from './ralph.js';
import {
  mcpHandler,
  catalogHandler,
  listHandler,
  removeHandler,
  promoteHandler,
  newBundleHandler,
  quickrefHandler,
  newProjectHandler,
  installPluginHandler,
  uninstallPluginHandler,
  pluginStatusHandler,
  packagePluginHandler,
  packageAllPluginsHandler,
  indexHandler,
  corpusHandler,
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
  subcommandHandlers,
} from './subcommands.js';
import { runtimeInfoHandler } from './runtime-info.js';
import { agentcardHandler } from './agentcard.js';
import { bestPracticesAuditHandler } from './best-practices-audit.js';
// sync was renamed to refresh (#694). refreshHandler exposes both 'refresh'
// (primary) and 'sync' (deprecated alias) to preserve backward compatibility.
import { refreshHandler } from './refresh.js';
import { regenerateHandler, regenerateHandlers } from './regenerate.js';
import { workspaceContextHandler, workspaceContextHandlers } from './workspace-context.js';
import { artifactsHandler, artifactsHandlers } from './artifacts.js';
import { effectHandler, effectHandlers } from './effect.js';
import { mcHandler, mcHandlers } from './mc.js';
import { missionHandlers } from './mission.js';
import { sdlcAccelerateHandler } from './sdlc-accelerate.js';
import { teamHandler, teamHandlers } from './team.js';
import { installHandler } from './install.js';
import { packagesHandler } from './packages.js';
import { marketplaceHandler } from './marketplace.js';
import { initHandler } from './init.js';
import { setupHandler } from './setup.js';
import { setupGenerateHandler, setupRunHandler, setupValidateHandler } from './setup-manifest.js';
import { runHandler } from './run.js';
import { stewardHandler, stewardHandlers } from './steward.js';
import { serveHandler } from './serve.js';
import { lintHandler } from './lint.js';
import { feedbackHandler } from './feedback.js';
import { sessionHandler } from './session.js';
import { sessionsHandler } from './sessions.js';
import { sandboxHandler, sandboxHandlers } from './sandbox.js';
import { diagnoseHandler } from './diagnose.js';
import { localExecutorHandler, localExecutorServeHandler } from './local-executor.js';
import { executionModeHandler } from './execution-mode.js';
import { repoAccessHandler, repoAccessHandlers } from './repo-access.js';
import { issueHandler, issueAuditHandler } from './issues.js';
import { cockpitHandler } from './cockpit.js';
import { commandLogHandler } from './command-log.js';
import { skillUsageHandler } from './skill-usage.js';
import { modelsHandler } from './models.js';
import { versionsHandler } from './resource-versions.js';
import { jobHandler } from './job.js';
import { costReportHandler } from './cost-report.js';
import { evidenceHandler } from './evidence.js';
import { artifactVerifyHandler } from './artifact-verify.js';
import { writingHandler } from './writing.js';
import { writerProfileHandler } from './writer-profile.js';
import { botHandoffHandler } from './bot-handoff.js';
import { buildVerifyHandler } from './build-verify.js';
import { outputModeHandler } from './output-mode.js';
import { installationHandler } from './installation.js';
import { uhpHandler } from './uhp.js';
import { schemaHandler } from './schema.js';
import { datasetHandler } from './dataset.js';

import type { CommandHandler } from './types.js';

// Re-export individual handlers
export {
  // Maintenance
  helpHandler,
  versionHandler,
  authHandler,
  doctorHandler,
  contextFirewallHandler,
  updateHandler,
  refreshHandler,
  regenerateHandler,
  workspaceContextHandler,

  // Framework management
  useHandler,
  listHandler,
  removeHandler,
  promoteHandler,
  installHandler,
  packagesHandler,
  marketplaceHandler,
  initHandler,
  setupHandler,
  setupGenerateHandler,
  setupRunHandler,
  setupValidateHandler,
  issueHandler,
  issueAuditHandler,
  runHandler,
  jobHandler,
  costReportHandler,
  evidenceHandler,
  artifactVerifyHandler,
  outputModeHandler,
  writerProfileHandler,
  botHandoffHandler,
  buildVerifyHandler,
  writingHandler,
  schemaHandler,
  datasetHandler,
  installationHandler,

  // Project
  newBundleHandler,
  quickrefHandler,
  newProjectHandler,
  sessionHandler,
  sessionsHandler,

  // Workspace
  statusHandler,
  wizardHandler,
  migrateWorkspaceHandler,
  rollbackWorkspaceHandler,

  // Subcommands
  mcpHandler,
  catalogHandler,
  modelsHandler,
  versionsHandler,
  indexHandler,
  artifactsHandler,
  effectHandler,
  corpusHandler,
  discoverHandler,
  showHandler,
  featuresHandler,
  skillsHandler,
  configHandler,
  opsHandler,
  storageHandler,
  activityLogHandler,
  commandLogHandler,
  skillUsageHandler,
  kbHandler,
  memoryHandler,
  reflectionsHandler,
  provenanceHandler,
  researchStoreHandler,
  researchQueryHandler,
  runtimeInfoHandler,
  agentcardHandler,
  uhpHandler,

  // Agentic Tools (RLM)
  chunkHandler,
  fanoutHandler,
  rlmPrepHandler,
  rlmSearchHandler,
  rlmStatusCliHandler,
  rlmCacheHandler,

  // Utilities
  prefillCardsHandler,
  contributeStartHandler,
  validateMetadataHandler,
  skillLintHandler,
  cockpitHandler,

  // Plugin
  installPluginHandler,
  uninstallPluginHandler,
  pluginStatusHandler,
  packagePluginHandler,
  packageAllPluginsHandler,

  // Scaffolding
  addAgentHandler,
  addCommandHandler,
  addSkillHandler,
  addBehaviorHandler,
  addTemplateHandler,
  scaffoldAddonHandler,
  scaffoldExtensionHandler,
  scaffoldFrameworkHandler,

  // Daemon
  behaviorHandler,
  daemonInitHandler,

  // Ralph
  ralphHandler,
  ralphStatusHandler,
  ralphAbortHandler,
  ralphResumeHandler,
  ralphAttachHandler,
  ralphExternalHandler,
  ralphMemoryHandler,
  ralphConfigHandler,

  // Mission Control
  mcHandler,

  // SDLC Orchestration
  sdlcAccelerateHandler,

  // Research / Validation
  bestPracticesAuditHandler,

  // Agent Teams
  teamHandler,

  // Steward
  stewardHandler,

  // Serve
  serveHandler,

  // Local Executor (#1181)
  localExecutorHandler,
  localExecutorServeHandler,

  // Sandbox management
  sandboxHandler,

  // Diagnose
  diagnoseHandler,
  executionModeHandler,

  // Repo Access
  repoAccessHandler,

  // Lint
  lintHandler,
};

// Re-export handler arrays
export {
  workspaceHandlers,
  utilityHandlers,
  scaffoldingHandlers,
  ralphHandlers,
  subcommandHandlers,
  mcHandlers,
  missionHandlers,
  teamHandlers,
  stewardHandlers,
  regenerateHandlers,
  workspaceContextHandlers,
  artifactsHandlers,
  effectHandlers,
  daemonHandlers,
  sandboxHandlers,
  repoAccessHandlers,
};

/**
 * All registered command handlers
 *
 * Used by the registry to build the command routing table.
 */
export const allHandlers: CommandHandler[] = [
  // Maintenance (shown first in help)
  helpHandler,
  versionHandler,
  authHandler,
  doctorHandler,
  contextFirewallHandler,
  updateHandler,
  refreshHandler,
  installationHandler,
  regenerateHandler,
  workspaceContextHandler,

  // Framework management
  useHandler,
  listHandler,
  removeHandler,
  promoteHandler,
  installHandler,
  packagesHandler,
  marketplaceHandler,

  // Project setup
  newBundleHandler,
  quickrefHandler,
  newProjectHandler,
  initHandler,
  setupHandler,
  setupGenerateHandler,
  setupRunHandler,
  setupValidateHandler,
  issueHandler,
  issueAuditHandler,
  runHandler,
  jobHandler,
  costReportHandler,
  evidenceHandler,
  artifactVerifyHandler,
  outputModeHandler,
  writerProfileHandler,
  botHandoffHandler,
  buildVerifyHandler,
  writingHandler,
  schemaHandler,
  datasetHandler,

  // Workspace management
  ...workspaceHandlers,

  // Subcommand handlers (MCP, catalog, index, skills)
  mcpHandler,
  catalogHandler,
  modelsHandler,
  versionsHandler,
  indexHandler,
  artifactsHandler,
  effectHandler,
  corpusHandler,
  discoverHandler,
  showHandler,
  featuresHandler,
  skillsHandler,
  runtimeInfoHandler,
  agentcardHandler,
  uhpHandler,

  // Utilities
  prefillCardsHandler,
  contributeStartHandler,
  validateMetadataHandler,
  skillLintHandler,
  cockpitHandler,

  // Plugin packaging
  installPluginHandler,
  uninstallPluginHandler,
  pluginStatusHandler,
  packagePluginHandler,
  packageAllPluginsHandler,

  // Scaffolding
  ...scaffoldingHandlers,

  // Agent loop
  ...ralphHandlers,

  // Mission Control
  ...mcHandlers,
  ...missionHandlers,

  // Agent Teams
  ...teamHandlers,

  // Steward (capability awareness)
  ...stewardHandlers,

  // SDLC Orchestration
  sdlcAccelerateHandler,

  // Research / Validation
  bestPracticesAuditHandler,

  // Daemon
  ...daemonHandlers,

  // Config
  configHandler,
  executionModeHandler,

  // Ops
  opsHandler,

  // Storage (#934)
  storageHandler,

  // Activity Log (#934, #964)
  activityLogHandler,

  // Command invocation log (#1614)
  commandLogHandler,

  // Skill usage telemetry (#1649)
  skillUsageHandler,

  // Knowledge Base (#934, #965)
  kbHandler,

  // Memory subsystem (#934, #966)
  memoryHandler,

  // Reflections subsystem (#934, #967)
  reflectionsHandler,

  // Provenance subsystem (#934, #968)
  provenanceHandler,

  // Research subsystem (#934, #968)
  researchStoreHandler,
  researchQueryHandler,

  // Agentic Tools (RLM support tools)
  chunkHandler,
  fanoutHandler,
  rlmPrepHandler,
  rlmSearchHandler,
  rlmStatusCliHandler,
  rlmCacheHandler,

  // Web dashboard
  serveHandler,

  // Local Executor (#1181)
  localExecutorHandler,
  localExecutorServeHandler,

  // Sandbox management (#917)
  ...sandboxHandlers,

  // Diagnose bundle (#925)
  diagnoseHandler,

  // Lint
  lintHandler,

  // Feedback (#885)
  feedbackHandler,

  // Session (#884)
  sessionHandler,
  sessionsHandler,

  // Repo access policy (#1376)
  ...repoAccessHandlers,
];

/**
 * Build alias map from all handlers
 *
 * Maps command aliases to canonical handler IDs.
 *
 * @returns Map of alias -> handler ID
 */
export function buildAliasMap(): Map<string, string> {
  const aliasMap = new Map<string, string>();

  for (const handler of allHandlers) {
    // Add canonical ID
    aliasMap.set(handler.id, handler.id);

    // Add all aliases
    for (const alias of handler.aliases) {
      aliasMap.set(alias, handler.id);
    }
  }

  return aliasMap;
}

/**
 * Build handler map for O(1) lookup
 *
 * @returns Map of handler ID -> handler
 */
export function buildHandlerMap(): Map<string, CommandHandler> {
  const handlerMap = new Map<string, CommandHandler>();

  for (const handler of allHandlers) {
    handlerMap.set(handler.id, handler);
  }

  return handlerMap;
}

/**
 * Resolve a command to its handler
 *
 * @param command - Raw command from CLI (may be alias)
 * @param aliasMap - Alias map from buildAliasMap()
 * @param handlerMap - Handler map from buildHandlerMap()
 * @returns Handler or undefined if not found
 */
export function resolveHandler(
  command: string,
  aliasMap: Map<string, string>,
  handlerMap: Map<string, CommandHandler>
): CommandHandler | undefined {
  const canonicalId = aliasMap.get(command);
  if (!canonicalId) return undefined;

  return handlerMap.get(canonicalId);
}

/**
 * Get handlers grouped by category
 *
 * Used for generating organized help text.
 *
 * @returns Map of category -> handlers
 */
export function getHandlersByCategory(): Map<string, CommandHandler[]> {
  const categoryMap = new Map<string, CommandHandler[]>();

  for (const handler of allHandlers) {
    const category = handler.category;
    const handlers = categoryMap.get(category) || [];
    handlers.push(handler);
    categoryMap.set(category, handlers);
  }

  return categoryMap;
}

/**
 * Get total handler count
 */
export function getHandlerCount(): number {
  return allHandlers.length;
}

/**
 * Get total alias count (including canonical IDs)
 */
export function getAliasCount(): number {
  return buildAliasMap().size;
}
