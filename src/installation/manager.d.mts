export type InstallationMethod = 'npm' | 'web' | 'source';
export type InstallationRunMode = 'normal' | 'development';
export type InstallationChannel = 'stable' | 'next' | 'nightly' | 'edge';
export interface InstallationIdentity {
  schemaVersion: 1;
  runMode: InstallationRunMode;
  method: InstallationMethod;
  root: string;
  updateStrategy: 'npm-global' | 'signed-web' | 'source-git';
  managerExecutable: string | null;
  channel: InstallationChannel;
  edgePath: string | null;
  checkOnStartup: boolean;
  lastUpdateCheck: number | string | null;
  updateCheckInterval: number;
  recordedAt: string;
}
export interface InstallationStatus {
  state: 'aligned' | 'mismatch' | 'stale' | 'unrecorded';
  identity: InstallationIdentity | null;
  canonicalRoot?: string;
  actualRoot: string;
  actualMethod: InstallationMethod;
  /** Root AIWG reads its corpus from. Equals actualRoot unless an edge launcher redirect applies. */
  frameworkRoot: string;
  /** Edge/customize mode only: the running executable's own package root (#2505). */
  launcher: { root: string; method: InstallationMethod } | null;
  drift: string[];
  managerProbe: { state: 'usable' | 'failed'; error?: string } | null;
}
export const INSTALLATION_IDENTITY_VERSION: 1;
export const INSTALLATION_FILE: string;
export function installationFile(options?: Record<string, unknown>): string;
export function inferInstallationMethod(root: string): InstallationMethod;
export function createInstallationIdentity(options: Record<string, any>): InstallationIdentity;
export function saveInstallationIdentity(identity: InstallationIdentity, options?: Record<string, any>): InstallationIdentity;
export function loadInstallationIdentity(options?: Record<string, any>): InstallationIdentity | null;
export function inspectInstallation(options: Record<string, any>): InstallationStatus;
export function formatInstallationDiagnostic(status: InstallationStatus): string;
export function assertCanonicalInstallation(options: Record<string, any>): InstallationStatus;
export function adoptInstallation(options: Record<string, any>): InstallationStatus;
export function switchInstallation(options: Record<string, any>): InstallationStatus;
