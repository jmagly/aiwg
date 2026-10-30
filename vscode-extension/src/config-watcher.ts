// Refresh the sidebar for canonical and legacy project configuration events.
import * as vscode from 'vscode';

export function watchProjectConfig(
  context: Pick<vscode.ExtensionContext, 'subscriptions'>,
  workspaceRoot: string,
  refresh: () => void
): void {
  const watcher = vscode.workspace.createFileSystemWatcher(
    // The sidebar still supports the legacy JSON config.
    new vscode.RelativePattern(workspaceRoot, '.aiwg/aiwg.config{,.json}')
  );
  context.subscriptions.push(
    watcher,
    watcher.onDidChange(refresh),
    watcher.onDidCreate(refresh),
    watcher.onDidDelete(refresh)
  );
}
