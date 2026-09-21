export interface GrokBuildUninstallReport {
  planned: string[];
  removed: string[];
  skipped: string[];
}

export function uninstall(target: string, opts: { dryRun?: boolean; srcRoot: string }): GrokBuildUninstallReport;
