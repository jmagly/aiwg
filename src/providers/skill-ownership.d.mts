export interface ArtifactOwnershipRecord {
  hash: string;
  owners?: string[];
  frameworkSlug?: string;
  source?: string;
  sourcePath?: string;
  version?: string;
  kind?: string;
  settings?: Record<string, SettingsOwnershipRecord>;
  settingsPreimage?: { present: boolean; bytes?: string; hash?: string };
}
export interface SettingsContribution { hash: string; value: unknown; owners: string[] }
export interface SettingsOwnershipRecord extends SettingsContribution {
  previous: { present?: boolean; value?: unknown; unverifiable?: boolean };
  contributions?: SettingsContribution[];
}
export interface SkillReceipt {
  skillSource?: string;
  managed?: Record<string, ArtifactOwnershipRecord>;
}
export interface SkillRemovalPlanEntry {
  path: string;
  action: 'remove' | 'preserve';
  reason: string;
}
export interface SkillRemovalOptions {
  dryRun?: boolean;
  plan?: SkillRemovalPlanEntry[];
}
export function extractFrameworkSlug(source: string): string | null;
export function sameSkillOwner(receipt: SkillReceipt | null, skillSource: string, frameworkSlug?: string | null): boolean;
export function canDeploySkill(receipt: SkillReceipt | null, skillSource: string, opts?: { force?: boolean; logicalInputPath?: (file: string) => string }): boolean;
export function pruneRecordedSkillFiles(skillDir: string, managed: SkillReceipt['managed'], desired: Set<string>, opts?: SkillRemovalOptions): void;
export function releaseSkillOwnership(skillDir: string, owner: { frameworkSlug?: string; skillSource?: string; sourceRoot?: string }, opts?: SkillRemovalOptions): boolean | null;
export function mergeArtifactOwnership<T extends ArtifactOwnershipRecord>(previous: ArtifactOwnershipRecord | undefined, current: T, owner: string): T & { owners: string[] };
