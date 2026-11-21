/**
 * SDLC Accelerate Handler
 *
 * Launches the SDLC Accelerate pipeline — taking a project from idea (or existing
 * codebase) to construction-ready by orchestrating intake → inception → elaboration
 * → construction prep via the sdlc-accelerate skill.
 *
 * Supports --provider to target any spawnable agent CLI, --dangerous to pass the
 * provider's unrestricted-mode flag, and --params for arbitrary provider-specific
 * args. IDE-integrated providers (copilot, cursor, etc.) receive guidance instead.
 *
 * @implements @docs/architecture/cli/adr-001-unified-extension-registry.md
 * @issue #485
 */

import { spawn } from 'child_process';
import type { CommandHandler, HandlerContext, HandlerResult } from './types.js';
import {
  parseAgentSpawnFlags,
  buildAgentArgs,
  getProviderConfig,
  isSpawnableProvider,
  dangerousWarning,
  spawnableProviders,
} from '../agent-spawn.js';

export class SdlcAccelerateHandler implements CommandHandler {
  id = 'sdlc-accelerate';
  name = 'SDLC Accelerate';
  description = 'End-to-end SDLC ramp-up from idea to construction-ready';
  category = 'orchestration' as const;
  aliases = ['sdlc-accelerate'];

  async execute(ctx: HandlerContext): Promise<HandlerResult> {
    const { opts, remaining } = parseAgentSpawnFlags(ctx.args);

    if (remaining.includes('--help') || remaining.includes('-h')) {
      return { exitCode: 0, message: this.getHelpText() };
    }

    const provider = opts.provider ?? 'claude';
    const config = getProviderConfig(provider);

    // IDE-integrated providers can't be spawned — print guidance instead
    if (!isSpawnableProvider(provider)) {
      const prompt = this.buildPrompt(remaining);
      return {
        exitCode: 0,
        message: [
          `Provider '${config.name}' is not spawnable from the CLI.`,
          config.guidanceMessage ?? '',
          '',
          `Run this in your IDE or agent panel:`,
          `  ${prompt}`,
        ].join('\n'),
      };
    }

    // Warn if --dangerous was requested but provider doesn't support it
    const warn = dangerousWarning(provider);
    if (opts.dangerous && warn) {
      console.warn(`Warning: ${warn}`);
    }

    const prompt = this.buildPrompt(remaining);
    const agentArgs = buildAgentArgs(prompt, opts);

    return this.spawnAgent(config.binary!, agentArgs, prompt);
  }

  private buildPrompt(remaining: string[]): string {
    const positional = remaining.filter(a => !a.startsWith('-')).join(' ');
    const flags = remaining.filter(a => a.startsWith('-')).join(' ');
    return positional
      ? `/sdlc-accelerate ${positional}${flags ? ' ' + flags : ''}`
      : `/sdlc-accelerate${flags ? ' ' + flags : ''}`;
  }

  private spawnAgent(binary: string, args: string[], prompt: string): Promise<HandlerResult> {
    return new Promise<HandlerResult>((resolve) => {
      try {
        const child = spawn(binary, args, {
          stdio: 'inherit',
          env: process.env,
        });

        child.on('close', (code) => {
          resolve({ exitCode: code ?? 0 });
        });

        child.on('error', (err) => {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            resolve({
              exitCode: 1,
              message: this.getNotFoundMessage(binary, prompt),
            });
          } else {
            resolve({
              exitCode: 1,
              message: `Failed to launch ${binary}: ${err.message}\n\n${this.getNotFoundMessage(binary, prompt)}`,
              error: err,
            });
          }
        });
      } catch (err) {
        resolve({
          exitCode: 1,
          message: `Failed to start SDLC pipeline: ${err instanceof Error ? err.message : String(err)}\n\n${this.getNotFoundMessage(binary, prompt)}`,
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    });
  }

  private getNotFoundMessage(binary: string, prompt: string): string {
    return `'${binary}' not found. Install the provider CLI and try again.\nTo run manually, open the agent and run:\n  ${prompt}`;
  }

  private getHelpText(): string {
    const spawnable = spawnableProviders().join(', ');
    return `
SDLC Accelerate — End-to-end SDLC ramp-up

USAGE:
  aiwg sdlc-accelerate "<description>" [options]
  aiwg sdlc-accelerate --from-codebase <path> [options]
  aiwg sdlc-accelerate --resume

ARGUMENTS:
  <description>           Project description (idea entry)

PIPELINE OPTIONS:
  --from-codebase <path>  Scan existing codebase instead of starting from idea
  --interactive           Full interactive mode at every step
  --guidance "text"       Project-level guidance for all phases
  --auto                  Auto-proceed on CONDITIONAL gates
  --dry-run               Show pipeline plan without executing
  --skip-to <phase>       Jump to phase: inception, elaboration, construction
  --resume                Resume from detected current phase

AGENT OPTIONS:
  --provider <name>       Agent system to use (default: claude)
                          Spawnable: ${spawnable}
                          IDE-integrated (guidance only): copilot, cursor, factory, warp, devin
  --dangerous             Enable unrestricted mode (skips permission prompts).
                          Maps to the provider's native flag — e.g. claude gets
                          --dangerously-skip-permissions, codex gets
                          --dangerously-bypass-approvals-and-sandbox.
                          Has no effect on providers that don't support it.
  --params "<args>"       Pass arbitrary args directly to the agent binary.
                          Appended verbatim after all other flags. You are
                          responsible for correctness. Quoted segments preserved.

EXAMPLES:
  aiwg sdlc-accelerate "Customer portal with real-time chat"
  aiwg sdlc-accelerate --from-codebase ./src "E-commerce platform"
  aiwg sdlc-accelerate --resume
  aiwg sdlc-accelerate --dry-run "Mobile banking app"
  aiwg sdlc-accelerate "My project" --dangerous
  aiwg sdlc-accelerate "My project" --provider opencode
  aiwg sdlc-accelerate "My project" --params "--output-format json"
  aiwg sdlc-accelerate "My project" --dangerous --params "--verbose"

PIPELINE:
  Intake → LOM Gate → Elaboration → ABM Gate → Construction Prep → Brief
`;
  }
}

export const sdlcAccelerateHandler = new SdlcAccelerateHandler();
