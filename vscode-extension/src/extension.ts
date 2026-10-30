/**
 * AIWG VS Code Extension
 *
 * Entry point: activate() / deactivate() lifecycle.
 * Registers commands, status bar, sidebar tree providers,
 * MCP auto-configuration, and the @aiwg chat participant.
 */

import * as vscode from 'vscode';
import { AiwgStatusBar } from './providers/status-bar';
import { AiwgSidebarProvider } from './providers/sidebar-tree';
import { AiwgCliRunner } from './cli/runner';
import { configureMcp } from './mcp/auto-config';
import { registerChatParticipant } from './participant/handler';
import { watchProjectConfig } from './config-watcher';

let statusBar: AiwgStatusBar | undefined;
let sidebarProvider: AiwgSidebarProvider | undefined;
let subscriptions: vscode.Disposable[] | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  subscriptions = context.subscriptions;
  const workspaceRoot = getWorkspaceRoot();

  // Detect CLI path
  const cliPath = await AiwgCliRunner.detect(context);
  const runner = new AiwgCliRunner(cliPath, workspaceRoot);

  // Status bar
  statusBar = new AiwgStatusBar(context, runner);
  await statusBar.refresh();

  // Sidebar tree views
  sidebarProvider = new AiwgSidebarProvider(context, runner, workspaceRoot);
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('aiwg.status', sidebarProvider.statusProvider),
    vscode.window.registerTreeDataProvider('aiwg.frameworks', sidebarProvider.frameworksProvider),
    vscode.window.registerTreeDataProvider('aiwg.scripts', sidebarProvider.scriptsProvider)
  );

  // MCP auto-configuration
  const config = vscode.workspace.getConfiguration('aiwg');
  if (config.get<boolean>('mcp.autoStart') && workspaceRoot && cliPath) {
    await configureMcp(workspaceRoot, cliPath).catch(() => {
      // Non-fatal: MCP config is best-effort on activation
    });
  }

  // Chat participant (@aiwg)
  registerChatParticipant(context, runner);

  // Register commands
  registerCommands(context, runner, workspaceRoot);

  // Workspace detection: prompt to init if no config found
  if (workspaceRoot) {
    await maybePromptInit(workspaceRoot);
  }

  if (workspaceRoot) {
    watchProjectConfig(context, workspaceRoot, () => sidebarProvider?.refresh());
  }
}

export function deactivate(): void {
  const disposables = subscriptions?.splice(0) ?? [];
  subscriptions = undefined;
  sidebarProvider = undefined;
  statusBar = undefined;
  for (const disposable of disposables) disposable.dispose();
}

function getWorkspaceRoot(): string {
  const folders = vscode.workspace.workspaceFolders;
  return folders && folders.length > 0 ? folders[0].uri.fsPath : '';
}

function registerCommands(
  context: vscode.ExtensionContext,
  runner: AiwgCliRunner,
  workspaceRoot: string
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('aiwg.init', async () => {
      if (!runner.cliPath) {
        await promptInstallCli();
        return;
      }
      await runner.runAsTask(['init'], 'AIWG: Initialize Project');
      sidebarProvider?.refresh();
      statusBar?.refresh();
    }),

    vscode.commands.registerCommand('aiwg.status', () => {
      vscode.commands.executeCommand('aiwg.status.focus');
    }),

    vscode.commands.registerCommand('aiwg.deploy', async () => {
      if (!runner.cliPath) {
        await promptInstallCli();
        return;
      }
      const framework = await vscode.window.showQuickPick(
        ['sdlc', 'marketing', 'forensics', 'research', 'all'],
        { placeHolder: 'Select framework to deploy' }
      );
      if (!framework) return;
      await runner.runAsTask(['use', framework], `AIWG: Deploy ${framework}`);
      sidebarProvider?.refresh();
      statusBar?.refresh();
    }),

    vscode.commands.registerCommand('aiwg.sync', async () => {
      if (!runner.cliPath) {
        await promptInstallCli();
        return;
      }
      await runner.runAsTask(['sync'], 'AIWG: Sync');
      sidebarProvider?.refresh();
      statusBar?.refresh();
    }),

    vscode.commands.registerCommand('aiwg.runScript', async (scriptName?: string) => {
      if (!runner.cliPath) {
        await promptInstallCli();
        return;
      }
      // If called from sidebar tree item, scriptName is provided directly
      const script = scriptName ?? await (async () => {
        const scripts = await sidebarProvider?.getScriptNames() ?? [];
        if (!scripts.length) {
          vscode.window.showInformationMessage('No scripts found in aiwg.config.json');
          return undefined;
        }
        return vscode.window.showQuickPick(scripts, { placeHolder: 'Select script to run' });
      })();
      if (!script) return;
      await runner.runAsTask(['run', script], `AIWG: Run ${script}`);
    }),

    vscode.commands.registerCommand('aiwg.configureMcp', async () => {
      if (!workspaceRoot) {
        vscode.window.showWarningMessage('No workspace folder open');
        return;
      }
      if (!runner.cliPath) {
        await promptInstallCli();
        return;
      }
      await configureMcp(workspaceRoot, runner.cliPath);
      vscode.window.showInformationMessage('AIWG MCP server configured in .vscode/mcp.json');
    }),

    vscode.commands.registerCommand('aiwg.installCli', async () => {
      await promptInstallCli();
    }),

    vscode.commands.registerCommand('aiwg.refreshSidebar', () => {
      sidebarProvider?.refresh();
      statusBar?.refresh();
    })
  );
}

async function maybePromptInit(workspaceRoot: string): Promise<void> {
  const config = vscode.workspace.getConfiguration('aiwg');
  if (!config.get<boolean>('init.autoPrompt')) return;

  const configUri = vscode.Uri.file(`${workspaceRoot}/.aiwg/aiwg.config.json`);
  const exists = await vscode.workspace.fs.stat(configUri).then(() => true, () => false);
  if (exists) return;

  const action = await vscode.window.showInformationMessage(
    'No AIWG config found in this project. Initialize AIWG?',
    'Initialize',
    'Not now',
    "Don't ask again"
  );

  if (action === 'Initialize') {
    vscode.commands.executeCommand('aiwg.init');
  } else if (action === "Don't ask again") {
    await config.update('init.autoPrompt', false, vscode.ConfigurationTarget.Workspace);
  }
}

async function promptInstallCli(): Promise<void> {
  const action = await vscode.window.showInformationMessage(
    'AIWG CLI not found. Install it to use deploy, sync, and init commands.',
    'Install (npm)',
    'Learn more'
  );
  if (action === 'Install (npm)') {
    const terminal = vscode.window.createTerminal('AIWG Install');
    terminal.show();
    terminal.sendText('npm install -g aiwg');
  } else if (action === 'Learn more') {
    vscode.env.openExternal(vscode.Uri.parse('https://aiwg.io'));
  }
}
