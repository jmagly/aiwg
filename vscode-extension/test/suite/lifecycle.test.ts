// Drive the shipped extension entry point inside Electron and observe its real resources.
import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { observeLifecycle, SubscriptionLog } from './lifecycle-observer';

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

suite('Extension lifecycle', () => {
  let entry: typeof import('../../src/extension');
  let extensionUri: vscode.Uri;
  let subscriptions: SubscriptionLog;
  let observer: ReturnType<typeof observeLifecycle>;
  let configFile: string;
  const context = (): vscode.ExtensionContext => ({ subscriptions, extensionUri } as unknown as vscode.ExtensionContext);

  suiteSetup(async () => {
    const extension = vscode.extensions.getExtension('jmagly.aiwg');
    assert.ok(extension, 'Expected the extension under test');
    await extension.activate();
    extensionUri = extension.extensionUri;
    // Use the very same bundled entry point loaded by VS Code, including its module state.
    entry = require(path.join(extension.extensionPath, 'dist/extension.js'));
    entry.deactivate();
    const workspace = vscode.workspace.workspaceFolders?.[0];
    assert.ok(workspace, 'Expected the mkdtemp workspace supplied by runTests');
    configFile = path.join(workspace.uri.fsPath, '.aiwg', 'aiwg.config');
    await fs.mkdir(path.dirname(configFile), { recursive: true });
  });

  setup(() => {
    subscriptions = new SubscriptionLog();
    observer = observeLifecycle();
  });

  teardown(async () => {
    entry.deactivate();
    subscriptions.cleanup();
    observer.restore();
    await fs.rm(configFile, { force: true });
  });

  suiteTeardown(async () => {
    // Restore the active extension for other suites and VS Code's shutdown hook.
    subscriptions = new SubscriptionLog();
    await entry.activate(context());
  });

  test('deactivate disposes every context subscription and every watcher listener', async () => {
    await entry.activate(context());
    const registered = [...subscriptions.records];
    assert.ok(registered.length >= 17, 'Expected status, trees, commands, chat, watcher and listeners');
    assert.strictEqual(observer.watchers.length, 1);
    assert.deepStrictEqual(observer.watchers[0].listeners.map(listener => listener.kind).sort(),
      ['change', 'create', 'delete']);
    assert.ok(registered.every(record => !record.disposed), 'Subscriptions must start live');

    entry.deactivate();

    assert.strictEqual(registered.filter(record => !record.disposed).length, 0,
      'deactivate leaked a context subscription');
    assert.ok(observer.watchers.every(watcher => watcher.disposed), 'deactivate leaked a watcher');
    assert.ok(observer.watchers.every(watcher => watcher.listeners.every(listener => listener.disposed)),
      'deactivate leaked an onDidChange/onDidCreate/onDidDelete listener');
  });

  test('reactivation has one listener set and exactly one sidebar refresh per config event', async function () {
    this.timeout(20000);
    await entry.activate(context());
    entry.deactivate();
    await entry.activate(context());

    assert.strictEqual(observer.watchers.length, 2, 'Expected a new watcher for each activation');
    const active = observer.watchers.filter(watcher => !watcher.disposed);
    assert.strictEqual(active.length, 1, 'Reactivation leaked the previous watcher');
    assert.deepStrictEqual(observer.watchers.flatMap(watcher => watcher.listeners)
      .filter(listener => !listener.disposed).map(listener => listener.kind).sort(),
    ['change', 'create', 'delete'], 'Reactivation doubled the watcher listeners');
    assert.strictEqual(observer.trees.length, 6, 'Expected three tree providers per activation');

    async function expectRefresh(action: () => Promise<unknown>, expected: number): Promise<void> {
      await action();
      const deadline = Date.now() + 5000;
      while (observer.trees.slice(3).some(tree => tree.refreshes < expected) && Date.now() < deadline) {
        await delay(25);
      }
      await delay(500);
      assert.deepStrictEqual(observer.trees.map(tree => tree.refreshes), [0, 0, 0, expected, expected, expected],
        'Each config event must refresh only the current sidebar once');
    }

    await delay(500); // Allow the host to install its asynchronous watch request.
    await expectRefresh(() => fs.writeFile(configFile, '{}\n'), 1);
    await expectRefresh(() => fs.writeFile(configFile, '{"scripts":{}}\n'), 2);
    await expectRefresh(() => fs.unlink(configFile), 3);
    entry.deactivate();
    const counts = observer.trees.map(tree => tree.refreshes);
    await fs.writeFile(configFile, '{}\n');
    await delay(500);
    assert.deepStrictEqual(observer.trees.map(tree => tree.refreshes), counts,
      'A config notification after shutdown refreshed a sidebar');
    assert.ok(subscriptions.records.every(record => record.disposed), 'Second activation leaked subscriptions');
  });
});
