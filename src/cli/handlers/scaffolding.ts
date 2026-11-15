/**
 * Scaffolding Command Handlers
 *
 * Handlers for code generation and project scaffolding commands.
 * Each handler delegates to existing scripts in tools/scaffolding/.
 *
 * @implements @docs/architecture/cli/adr-001-unified-extension-registry.md
 * @tests @test/unit/cli/handlers/scaffolding.test.ts
 * @issue #33
 */

import { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import { createScriptRunner } from './script-runner.js';
import { getFrameworkRoot } from '../../channel/manager.mjs';

/**
 * Base class for scaffolding handlers that delegate to scripts
 */
abstract class ScaffoldingHandler implements CommandHandler {
  abstract id: string;
  abstract name: string;
  abstract description: string;
  abstract scriptPath: string;

  category = 'scaffolding' as const;

  get aliases(): string[] {
    return [this.id];
  }

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const frameworkRoot = await getFrameworkRoot();
    const runner = createScriptRunner(frameworkRoot);

    return runner.run(this.scriptPath, ctx.args);
  }
}

/**
 * Add Agent Handler
 *
 * Scaffolds a new agent definition (specialist AI persona).
 */
class AddAgentHandler extends ScaffoldingHandler {
  id = 'add-agent';
  name = 'Add Agent';
  description = 'Create a new agent definition';
  scriptPath = 'tools/scaffolding/add-agent.mjs';
}

/**
 * Add Command Handler
 *
 * Scaffolds a new slash command for Claude Code/Cursor.
 *
 * @deprecated Use `aiwg add-skill` instead. Commands are now generated from
 * skills at deploy time. See ADR: Skills as Canonical Extension Type.
 */
class AddCommandHandler extends ScaffoldingHandler {
  id = 'add-command';
  name = 'Add Command';
  description = 'Create a new slash command (deprecated — use add-skill)';
  scriptPath = 'tools/scaffolding/add-command.mjs';

  override async execute(ctx: HandlerContext): Promise<HandlerResult> {
    console.warn(
      '\x1b[33m⚠ DEPRECATED:\x1b[0m `aiwg add-command` is deprecated. ' +
      'Use `aiwg add-skill` instead.\n' +
      '  Commands are now generated from skills at deploy time.\n' +
      '  See: docs/extensions/extension-types.md\n'
    );
    return super.execute(ctx);
  }
}

/**
 * Add Skill Handler
 *
 * Scaffolds a new skill (SKILL.md format) — the canonical extension type for workflows.
 */
class AddSkillHandler extends ScaffoldingHandler {
  id = 'add-skill';
  name = 'Add Skill';
  description = 'Create a new skill (canonical workflow format)';
  scriptPath = 'tools/scaffolding/add-skill.mjs';
}

/**
 * Add Template Handler
 *
 * Scaffolds a new document template.
 */
class AddTemplateHandler extends ScaffoldingHandler {
  id = 'add-template';
  name = 'Add Template';
  description = 'Create a new document template';
  scriptPath = 'tools/scaffolding/add-template.mjs';
}

/**
 * Scaffold Addon Handler
 *
 * Scaffolds a complete AIWG addon with structure and manifest.
 */
class ScaffoldAddonHandler extends ScaffoldingHandler {
  id = 'scaffold-addon';
  name = 'Scaffold Addon';
  description = 'Create a new AIWG addon';
  scriptPath = 'tools/scaffolding/scaffold-addon.mjs';
}

/**
 * Scaffold Extension Handler
 *
 * Scaffolds a platform-specific extension (plugin, integration).
 */
class ScaffoldExtensionHandler extends ScaffoldingHandler {
  id = 'scaffold-extension';
  name = 'Scaffold Extension';
  description = 'Create a new platform extension';
  scriptPath = 'tools/scaffolding/scaffold-extension.mjs';
}

/**
 * Add Behavior Handler
 *
 * Scaffolds a new behavior with BEHAVIOR.md and scripts/.
 */
class AddBehaviorHandler extends ScaffoldingHandler {
  id = 'add-behavior';
  name = 'Add Behavior';
  description = 'Create a new behavior with hooks and scripts';
  scriptPath = 'tools/scaffolding/add-behavior.mjs';
}

/**
 * Scaffold Framework Handler
 *
 * Scaffolds a complete AIWG framework with agents, commands, and docs.
 */
class ScaffoldFrameworkHandler extends ScaffoldingHandler {
  id = 'scaffold-framework';
  name = 'Scaffold Framework';
  description = 'Create a new AIWG framework';
  scriptPath = 'tools/scaffolding/scaffold-framework.mjs';
}

/**
 * Exported handler instances
 */
export const addAgentHandler: CommandHandler = new AddAgentHandler();
export const addCommandHandler: CommandHandler = new AddCommandHandler();
export const addSkillHandler: CommandHandler = new AddSkillHandler();
export const addBehaviorHandler: CommandHandler = new AddBehaviorHandler();
export const addTemplateHandler: CommandHandler = new AddTemplateHandler();
export const scaffoldAddonHandler: CommandHandler = new ScaffoldAddonHandler();
export const scaffoldExtensionHandler: CommandHandler = new ScaffoldExtensionHandler();
export const scaffoldFrameworkHandler: CommandHandler = new ScaffoldFrameworkHandler();

/**
 * All scaffolding handlers for registration
 */
export const scaffoldingHandlers: CommandHandler[] = [
  addAgentHandler,
  addCommandHandler,
  addSkillHandler,
  addBehaviorHandler,
  addTemplateHandler,
  scaffoldAddonHandler,
  scaffoldExtensionHandler,
  scaffoldFrameworkHandler,
];
