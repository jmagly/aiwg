// Exercise config notifications with the extension host's real filesystem watcher.
import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { watchProjectConfig } from '../../src/config-watcher';
import { AiwgSidebarProvider } from '../../src/providers/sidebar-tree';
import { AiwgCliRunner } from '../../src/cli/runner';

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

suite('Project config watcher', () => {
  for (const filename of ['aiwg.config', 'aiwg.config.json']) {
    test(`${filename}: create, change and delete each refresh the sidebar once`, async function () {
      this.timeout(20000);
      // runTests creates this workspace with mkdtemp(os.tmpdir()).
      const workspace = vscode.workspace.workspaceFolders?.[0];
      assert.ok(workspace, 'Expected the temporary extension-host workspace');
      const configDir = path.join(workspace.uri.fsPath, '.aiwg');
      await fs.mkdir(configDir, { recursive: true });
      const configFile = path.join(configDir, filename);
      const subscriptions: vscode.Disposable[] = [];
      const context = { subscriptions };
      const sidebar = new AiwgSidebarProvider(
        context as vscode.ExtensionContext, new AiwgCliRunner('', workspace.uri.fsPath), workspace.uri.fsPath
      );
      const counts = [0, 0, 0];
      const providers = [sidebar.statusProvider, sidebar.frameworksProvider, sidebar.scriptsProvider];
      providers.forEach((provider, index) => {
        subscriptions.push(provider.onDidChangeTreeData(() => { counts[index]++; }));
      });
      watchProjectConfig(context, workspace.uri.fsPath, () => sidebar.refresh());

      async function expectRefresh(action: () => Promise<unknown>, expected: number, label: string): Promise<void> {
        await action();
        const deadline = Date.now() + 5000;
        while (counts.some(count => count < expected) && Date.now() < deadline) await delay(25);
        // Observe a quiet window as well, so duplicate notifications fail the assertion.
        await delay(500);
        assert.deepStrictEqual(counts, [expected, expected, expected], `${filename} ${label}`);
      }

      try {
        // Allow the extension host to install its asynchronous watch request.
        await delay(500);
        await expectRefresh(() => fs.writeFile(configFile, '{}\n'), 1, 'creation');
        await expectRefresh(() => fs.writeFile(configFile, '{"scripts":{"test":"echo test"}}\n'), 2, 'change');
        await expectRefresh(() => fs.unlink(configFile), 3, 'deletion');
      } finally {
        subscriptions.forEach(subscription => subscription.dispose());
        await fs.rm(configFile, { force: true });
      }
    });
  }
});
