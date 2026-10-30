// Observe real host registrations without replacing their disposal or event delivery.
import * as vscode from 'vscode';

export class SubscriptionLog extends Array<vscode.Disposable> {
  readonly records: { disposable: vscode.Disposable; disposed: boolean }[] = [];

  override push(...items: vscode.Disposable[]): number {
    return super.push(...items.map(disposable => {
      const record = { disposable, disposed: false };
      this.records.push(record);
      return { dispose: () => { record.disposed = true; disposable.dispose(); } };
    }));
  }

  cleanup(): void {
    for (const record of this.records) record.disposable.dispose();
  }
}

export function observeLifecycle(): {
  watchers: { disposed: boolean; listeners: { kind: string; disposed: boolean }[] }[];
  trees: { id: string; refreshes: number }[];
  restore(): void;
} {
  const watchers: { disposed: boolean; listeners: { kind: string; disposed: boolean }[] }[] = [];
  const trees: { id: string; refreshes: number }[] = [];
  const observations: vscode.Disposable[] = [];
  const createWatcher = vscode.workspace.createFileSystemWatcher;
  const registerTree = vscode.window.registerTreeDataProvider;

  vscode.workspace.createFileSystemWatcher = (...args) => {
    const watcher = createWatcher(...args);
    const record = { disposed: false, listeners: [] as { kind: string; disposed: boolean }[] };
    watchers.push(record);
    observations.push(watcher);
    function observe(kind: string, event: vscode.Event<vscode.Uri>): vscode.Event<vscode.Uri> {
      return (listener, thisArgs, disposables) => {
        const state = { kind, disposed: false };
        record.listeners.push(state);
        const actual = event(listener, thisArgs);
        observations.push(actual);
        const tracked = { dispose: () => { state.disposed = true; actual.dispose(); } };
        disposables?.push(tracked);
        return tracked;
      };
    }
    return {
      ignoreCreateEvents: watcher.ignoreCreateEvents,
      ignoreChangeEvents: watcher.ignoreChangeEvents,
      ignoreDeleteEvents: watcher.ignoreDeleteEvents,
      onDidChange: observe('change', watcher.onDidChange),
      onDidCreate: observe('create', watcher.onDidCreate),
      onDidDelete: observe('delete', watcher.onDidDelete),
      dispose: () => { record.disposed = true; watcher.dispose(); },
    };
  };
  vscode.window.registerTreeDataProvider = (id, provider) => {
    const record = { id, refreshes: 0 };
    trees.push(record);
    if (provider.onDidChangeTreeData) {
      observations.push(provider.onDidChangeTreeData(() => { record.refreshes++; }));
    }
    return registerTree(id, provider);
  };

  return {
    watchers, trees,
    restore: () => {
      vscode.workspace.createFileSystemWatcher = createWatcher;
      vscode.window.registerTreeDataProvider = registerTree;
      observations.forEach(disposable => disposable.dispose());
    },
  };
}
