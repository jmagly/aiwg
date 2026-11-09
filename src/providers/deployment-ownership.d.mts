import type { PathLike } from 'node:fs';
export interface DeploymentOwnershipOptions {
  provider?: string;
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
export function deploymentOutputRoots(provider: { name: string; paths?: Record<string, string>; kernelSkillsPath?: string; deploymentFiles?: (target: string) => string[] }, target: string): string[];
/** A file recorded without its bytes: stat signature, plus a digest when it was read. */
export class DeploymentOutputState {
  constructor(signature: string, digest?: string);
  readonly signature: string;
  readonly hash: string | undefined;
}
/** Receipts, settings and receipt-claimed files are Buffers; other files are states. */
export type DeploymentOutputSnapshot = Map<string, Buffer | DeploymentOutputState>;
export function outputDigest(entry: Buffer | DeploymentOutputState | undefined): string | undefined;
export function sameOutput(a: Buffer | DeploymentOutputState | undefined, b: Buffer | DeploymentOutputState | undefined): boolean;
export function legacyCodexPromptOwner(file: string, entry: Buffer | DeploymentOutputState | undefined): string | undefined;
export function captureDeploymentOutputs(roots: PathLike[], options?: { previous?: DeploymentOutputSnapshot }): DeploymentOutputSnapshot;
export function recordDeploymentOutputs(before: DeploymentOutputSnapshot, roots: PathLike[], opts?: DeploymentOwnershipOptions): void;
export function refreshSettingsDigests(record: { settings?: Record<string, unknown> }): void;

export function deploymentOwner(opts: DeploymentOwnershipOptions): string | undefined;
