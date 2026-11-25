import fs from 'fs/promises';
import path from 'path';
import { projectAiwgPath, projectControlPath } from '../config/project-artifacts.js';

export type WorkspaceBundleType = 'framework' | 'addon' | 'extension';

export interface WorkspaceBundleDecision {
  type: WorkspaceBundleType;
  id: string;
  included: boolean;
  reasons: string[];
}

export interface WorkspaceSignalPlan {
  projectDir: string;
  generatedAt?: string;
  profile: string;
  profileSource: 'auto' | 'flag' | 'config' | 'requested-target';
  requestedTarget?: string;
  signals: string[];
  missedSignals: string[];
  bundles: WorkspaceBundleDecision[];
  notes: string[];
}

const FRAMEWORKS = [
  'sdlc',
  'marketing',
  'media-curator',
  'research',
  'forensics',
  'security-engineering',
  'ops',
  'cicd-complete',
  'knowledge-base',
] as const;

const ADDONS = [
  'aiwg-utils',
] as const;

const EXTENSIONS = [
  'dev',
  'it',
  'net',
  'sec',
  'stream',
  'sys',
] as const;

const PROFILE_FRAMEWORKS: Record<string, string[]> = {
  sdlc: ['sdlc'],
  default: ['sdlc'],
  marketing: ['marketing'],
  'media-marketing': ['marketing'],
  'media-curator': ['media-curator'],
  research: ['research'],
  forensics: ['forensics'],
  'security-engineering': ['security-engineering'],
  security: ['security-engineering'],
  ops: ['ops'],
  'cicd-complete': ['cicd-complete'],
  cicd: ['cicd-complete'],
  'knowledge-base': ['knowledge-base'],
  kb: ['knowledge-base'],
};

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonIfPresent(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function addReason(
  included: Map<string, string[]>,
  id: string,
  reason: string,
): void {
  const reasons = included.get(id) ?? [];
  if (!reasons.includes(reason)) reasons.push(reason);
  included.set(id, reasons);
}

function includeProfile(included: Map<string, string[]>, profile: string, reason: string): void {
  const normalized = profile.toLowerCase();
  if (normalized === 'all') {
    for (const framework of FRAMEWORKS) addReason(included, framework, reason);
    return;
  }

  for (const framework of PROFILE_FRAMEWORKS[normalized] ?? []) {
    addReason(included, framework, reason);
  }
}

function extractConfigHints(config: Record<string, unknown> | null): {
  profile?: string;
  bundles: string[];
} {
  if (!config) return { bundles: [] };

  const skillLoading = typeof config.skillLoading === 'object' && config.skillLoading
    ? config.skillLoading as Record<string, unknown>
    : {};

  const profile =
    typeof config.workspaceProfile === 'string' ? config.workspaceProfile :
    typeof config.profile === 'string' ? config.profile :
    typeof skillLoading.profile === 'string' ? skillLoading.profile :
    undefined;

  const bundles = [
    ...stringArray(config.enabledBundles),
    ...stringArray(config.enabledSkills),
    ...stringArray(skillLoading.include),
    ...stringArray(skillLoading.bundles),
  ];

  return { profile, bundles };
}

async function detectIntakeProfiles(projectDir: string): Promise<string[]> {
  const intakePath = projectAiwgPath(projectDir, 'intake', 'solution-profile.md');
  try {
    const content = (await fs.readFile(intakePath, 'utf-8')).toLowerCase();
    const profiles: string[] = [];
    if (content.includes('forensic') || content.includes('incident response')) profiles.push('forensics');
    if (content.includes('research') || content.includes('citation') || content.includes('literature')) profiles.push('research');
    if (content.includes('marketing') || content.includes('campaign') || content.includes('brand')) profiles.push('marketing');
    if (content.includes('media curator') || content.includes('discography') || content.includes('archive')) profiles.push('media-curator');
    if (content.includes('security') || content.includes('cryptograph') || content.includes('threat model')) profiles.push('security-engineering');
    if (content.includes('ops') || content.includes('runbook') || content.includes('infrastructure')) profiles.push('ops');
    if (content.includes('knowledge base') || content.includes('wiki') || content.includes('semantic memory')) profiles.push('knowledge-base');
    return profiles;
  } catch {
    return [];
  }
}

export async function resolveWorkspaceSignalPlan(
  projectDir: string,
  opts: { profile?: string; requestedTarget?: string } = {},
): Promise<WorkspaceSignalPlan> {
  const included = new Map<string, string[]>();
  const signals: string[] = [];
  const missedSignals: string[] = [];
  const notes: string[] = [];

  addReason(included, 'sdlc', 'always included as core lifecycle support');
  addReason(included, 'aiwg-utils', 'always included as core AIWG utilities');

  let profile = opts.profile;
  let profileSource: WorkspaceSignalPlan['profileSource'] = profile ? 'flag' : 'auto';

  const config = await readJsonIfPresent(projectControlPath(projectDir, 'aiwg.config'));
  const configHints = extractConfigHints(config);
  if (!profile && configHints.profile) {
    profile = configHints.profile;
    profileSource = 'config';
  }

  const requestedTarget = opts.requestedTarget;
  if (!profile && requestedTarget && requestedTarget !== 'all' && !requestedTarget.startsWith('-')) {
    profile = requestedTarget;
    profileSource = 'requested-target';
  }

  if (profile) {
    includeProfile(included, profile, `${profileSource} profile "${profile}"`);
  }

  for (const bundle of configHints.bundles) {
    addReason(included, bundle, 'explicitly enabled in .aiwg/aiwg.config');
  }

  const domainSignals: Array<[string, string, string]> = [
    ['forensics', '.aiwg/forensics/', 'forensics'],
    ['research', '.aiwg/research/', 'research'],
    ['marketing', '.aiwg/marketing/', 'marketing'],
    ['media-curator', '.aiwg/media-curator/', 'media-curator'],
    ['ops', '.aiwg/ops/', 'ops'],
    ['knowledge-base', '.aiwg/knowledge-base/', 'knowledge-base'],
    ['security-engineering', '.aiwg/security-engineering/', 'security-engineering'],
  ];

  for (const [framework, relPath, reasonPath] of domainSignals) {
    const artifactPath = relPath.startsWith('.aiwg/')
      ? projectAiwgPath(projectDir, relPath.slice('.aiwg/'.length))
      : path.join(projectDir, relPath);
    if (await exists(artifactPath)) {
      signals.push(relPath);
      addReason(included, framework, `matched ${reasonPath} workspace signal`);
    } else {
      missedSignals.push(relPath);
    }
  }

  if (await exists(path.join(projectDir, 'package.json')) && await exists(path.join(projectDir, 'src'))) {
    signals.push('package.json + src/');
    addReason(included, 'sdlc', 'matched application source workspace signal');
  } else {
    missedSignals.push('package.json + src/');
  }

  const containerFiles = ['Dockerfile', 'compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];
  const matchedContainer = [];
  for (const file of containerFiles) {
    if (await exists(path.join(projectDir, file))) matchedContainer.push(file);
  }
  if (matchedContainer.length > 0) {
    signals.push(matchedContainer.join(', '));
    addReason(included, 'forensics', 'matched container workspace signal');
    notes.push('Container signals currently map to the forensics framework; a narrower container skill subset can be layered on this plan later.');
  } else {
    missedSignals.push('Dockerfile / compose.yaml');
  }

  const intakeProfiles = await detectIntakeProfiles(projectDir);
  for (const intakeProfile of intakeProfiles) {
    signals.push(`.aiwg/intake/solution-profile.md:${intakeProfile}`);
    includeProfile(included, intakeProfile, `matched intake purpose "${intakeProfile}"`);
  }
  if (intakeProfiles.length === 0) {
    missedSignals.push('.aiwg/intake/solution-profile.md');
  }

  if (included.has('security-engineering')) {
    addReason(included, 'sdlc', 'dependency of security-engineering');
  }

  const bundles: WorkspaceBundleDecision[] = [
    ...FRAMEWORKS.map((id) => ({
      type: 'framework' as const,
      id,
      included: included.has(id),
      reasons: included.get(id) ?? ['no matching workspace signal'],
    })),
    ...ADDONS.map((id) => ({
      type: 'addon' as const,
      id,
      included: included.has(id),
      reasons: included.get(id) ?? ['no matching workspace signal'],
    })),
    ...EXTENSIONS.map((id) => ({
      type: 'extension' as const,
      id,
      included: included.has(id),
      reasons: included.get(id) ?? ['no matching workspace signal'],
    })),
  ];

  return {
    projectDir,
    generatedAt: new Date().toISOString(),
    profile: profile ?? 'auto',
    profileSource,
    requestedTarget,
    signals,
    missedSignals,
    bundles,
    notes,
  };
}

export async function writeWorkspaceSignalPlan(projectDir: string, plan: WorkspaceSignalPlan): Promise<string> {
  const planPath = projectAiwgPath(projectDir, 'workspace-skill-plan.json');
  await fs.mkdir(path.dirname(planPath), { recursive: true });
  await fs.writeFile(planPath, JSON.stringify(plan, null, 2) + '\n', 'utf-8');
  return planPath;
}

export async function readWorkspaceSignalPlan(projectDir: string): Promise<WorkspaceSignalPlan | null> {
  try {
    const content = await fs.readFile(projectAiwgPath(projectDir, 'workspace-skill-plan.json'), 'utf-8');
    return JSON.parse(content) as WorkspaceSignalPlan;
  } catch {
    return null;
  }
}

export function includedBundleIds(plan: WorkspaceSignalPlan, type: WorkspaceBundleType): string[] {
  return plan.bundles
    .filter((bundle) => bundle.type === type && bundle.included)
    .map((bundle) => bundle.id);
}

function formatBundleGroup(plan: WorkspaceSignalPlan, included: boolean, type: WorkspaceBundleType): string[] {
  return plan.bundles
    .filter((bundle) => bundle.type === type && bundle.included === included)
    .map((bundle) => `  - ${bundle.id}: ${bundle.reasons.join('; ')}`);
}

export function formatWorkspaceSignalPlan(plan: WorkspaceSignalPlan): string {
  const lines: string[] = [];
  lines.push('Workspace skill loading plan (dry run)');
  lines.push(`Project: ${plan.projectDir}`);
  lines.push(`Profile: ${plan.profile} (${plan.profileSource})`);
  if (plan.requestedTarget) lines.push(`Requested target: ${plan.requestedTarget}`);
  lines.push('');
  lines.push('Included');
  for (const type of ['framework', 'addon', 'extension'] as const) {
    const rows = formatBundleGroup(plan, true, type);
    if (rows.length > 0) {
      lines.push(`${type}s:`);
      lines.push(...rows);
    }
  }
  lines.push('');
  lines.push('Excluded');
  for (const type of ['framework', 'addon', 'extension'] as const) {
    const rows = formatBundleGroup(plan, false, type);
    if (rows.length > 0) {
      lines.push(`${type}s:`);
      lines.push(...rows);
    }
  }
  lines.push('');
  lines.push('Signals matched:');
  if (plan.signals.length === 0) {
    lines.push('  - none');
  } else {
    for (const signal of plan.signals) lines.push(`  - ${signal}`);
  }
  lines.push('');
  lines.push('Signals not present:');
  for (const signal of plan.missedSignals) lines.push(`  - ${signal}`);
  if (plan.notes.length > 0) {
    lines.push('');
    lines.push('Notes:');
    for (const note of plan.notes) lines.push(`  - ${note}`);
  }
  lines.push('');
  lines.push('No files were changed. Run `aiwg use --profile <name>` to deploy a workspace-aware subset, or `aiwg use all` for the full deployment.');
  return lines.join('\n');
}

export function formatDeployedWorkspaceSignalPlan(plan: WorkspaceSignalPlan): string {
  const lines: string[] = [];
  lines.push(`\nWorkspace skill filter: ${plan.profile} (${plan.profileSource})`);
  if (plan.generatedAt) lines.push(`Resolved: ${plan.generatedAt}`);
  lines.push('Included:');
  const included = plan.bundles.filter((bundle) => bundle.included);
  for (const bundle of included) {
    lines.push(`  ${bundle.type}/${bundle.id}: ${bundle.reasons.join('; ')}`);
  }
  lines.push('Filtered out:');
  const excluded = plan.bundles.filter((bundle) => !bundle.included);
  for (const bundle of excluded) {
    lines.push(`  ${bundle.type}/${bundle.id}: ${bundle.reasons.join('; ')}`);
  }
  return lines.join('\n') + '\n';
}
