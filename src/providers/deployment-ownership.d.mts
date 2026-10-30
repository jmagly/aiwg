import type { PathLike } from 'node:fs';
export interface DeploymentOwnershipOptions {
  dryRun?: boolean;
  claimUnchangedSettings?: boolean;
  onlyDeclared?: boolean;
  srcRoot?: string;
  target?: string;
  writeReceipt?: (file: string, content: string) => void;
  mode?: string;
  frameworkSlug?: string;
  writtenFiles?: string[];
  logicalInputPath?: (file: string) => string;
}
export function deploymentOutputRoots(provider: { name: string; paths?: Record<string, string>; kernelSkillsPath?: string }, target: string): string[];
export function captureDeploymentOutputs(roots: PathLike[]): Map<string, Buffer>;
export function recordDeploymentOutputs(before: Map<string, Buffer>, roots: PathLike[], opts?: DeploymentOwnershipOptions): void;
export function refreshSettingsDigests(record: { settings?: Record<string, unknown> }): void;

export function deploymentOwner(opts: DeploymentOwnershipOptions): string | undefined;
