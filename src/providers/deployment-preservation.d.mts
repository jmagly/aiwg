import type { AiwgConfig } from '../config/aiwg-config.js';
import type { DeploymentOutputSnapshot } from './deployment-ownership.mjs';
export function providerCopyMode(project: string, provider: string, owner?: string, config?: AiwgConfig, indexOwner?: string): boolean;
export function automaticRemovalAllowed(project: string, provider: string, file: string, config?: AiwgConfig): boolean;
export function preserveDeploymentOutputs(before: DeploymentOutputSnapshot, roots: string[], opts?: Record<string, unknown>): void;
export function deploymentEditWarnings(project: string, provider: string): string[];
