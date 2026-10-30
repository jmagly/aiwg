// Exercise init prompting through the shipped entry point with real workspace files.
import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';

suite('Init prompt', () => {
  let entry: typeof import('../../src/extension');
  let extensionUri: vscode.Uri;
  let configDir: string;
  let previousAutoPrompt: boolean | undefined;
  let showInformationMessage: typeof vscode.window.showInformationMessage;
  let messages: string[];
  let subscriptions: vscode.Disposable[];
  const context = (): vscode.ExtensionContext => ({ subscriptions, extensionUri } as vscode.ExtensionContext);

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension('jmagly.aiwg');
    assert.ok(extension, 'Expected the extension under test');
    await extension.activate();
    extensionUri = extension.extensionUri;
    entry = require(path.join(extension.extensionPath, 'dist/extension.js'));
    entry.deactivate();
    const workspace = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspace, 'Expected the mkdtemp workspace supplied by runTests');
    configDir = path.join(workspace.uri.fsPath, '.aiwg');
    await fs.mkdir(configDir, { recursive: true });
    previousAutoPrompt = vscode.workspace.getConfiguration('aiwg')
      .inspect<boolean>('init.autoPrompt')?.workspaceValue;
  });

  setup(async () => {
    subscriptions = [];
    messages = [];
    showInformationMessage = vscode.window.showInformationMessage;
    vscode.window.showInformationMessage = (async (message: string) => {
      messages.push(message);
      return undefined;
    }) as typeof vscode.window.showInformationMessage;
    await vscode.workspace.getConfiguration('aiwg')
      .update('init.autoPrompt', true, vscode.ConfigurationTarget.Workspace);
  });

  teardown(async () => {
    entry.deactivate();
    vscode.window.showInformationMessage = showInformationMessage;
    await vscode.workspace.getConfiguration('aiwg')
      .update('init.autoPrompt', previousAutoPrompt, vscode.ConfigurationTarget.Workspace);
    for (const filename of ['aiwg.config', 'aiwg.config.json']) {
      await fs.rm(path.join(configDir, filename), { force: true });
    }
    // Drain host filesystem notifications before another activation installs a watcher.
    await new Promise(resolve => setTimeout(resolve, 500));
  });

  suiteTeardown(async () => {
    subscriptions = [];
    await entry.activate(context());
  });

  for (const filename of ['aiwg.config', 'aiwg.config.json']) {
    test(`${filename} suppresses the init prompt`, async () => {
      await fs.writeFile(path.join(configDir, filename), '{}\n');

      await entry.activate(context());

      assert.deepStrictEqual(messages, [], `${filename} must suppress the init prompt`);
    });
  }

  test('neither config file offers initialization once', async () => {
    await entry.activate(context());

    assert.deepStrictEqual(messages, ['No AIWG config found in this project. Initialize AIWG?']);
  });
});
