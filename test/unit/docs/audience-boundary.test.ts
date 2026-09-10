import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../../..');
const docs = path.join(root, 'docs');
const cliCommandPattern = /\b(?:npx\s+)?aiwg\s+(?:--?)?[a-z][a-z0-9-]*\b/;
const legacyProviderCommandPattern = /(?<![a-z0-9~.])\/aiwg-[a-z][a-z0-9-]*\b|\$aiwg-[a-z][a-z0-9-]*\b|\baiwg-regenerate\b/;
let outputRoot: string;

function assertCompleteAudienceInventory(audit: {
  inventory: { path: string; publicOperatorNoticeRequired: boolean }[];
  totals: { markdownFiles: number; publicOperatorGuidancePages: number };
}) {
  const markdownPaths = (directory: string): string[] =>
    readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) return markdownPaths(absolute);
      return entry.isFile() && entry.name.endsWith('.md')
        ? [path.relative(docs, absolute).split(path.sep).join('/')]
        : [];
    });
  const expectedPaths = markdownPaths(docs).sort();
  expect(expectedPaths.length, 'source Markdown population must be nonempty').toBeGreaterThan(0);
  expect(audit.inventory.map((row) => row.path).sort(), 'inventory must contain every source Markdown path exactly once')
    .toEqual(expectedPaths);
  expect(audit.totals.markdownFiles).toBe(expectedPaths.length);
  const guidanceRows = audit.inventory.filter((row) => row.publicOperatorNoticeRequired);
  expect(guidanceRows.length, 'staged guidance checks must not be vacuous').toBeGreaterThan(0);
  expect(guidanceRows.length, 'guidance selection must match the report total')
    .toBe(audit.totals.publicOperatorGuidancePages);
  return guidanceRows;
}

beforeAll(() => {
  outputRoot = mkdtempSync(path.join(tmpdir(), 'aiwg-audience-boundary-'));
});

afterAll(() => {
  rmSync(outputRoot, { recursive: true, force: true });
  expect(existsSync(outputRoot)).toBe(false);
});

describe('documentation audience boundary', () => {
  it('keeps the actual homepage source on the canonical first-result journey', () => {
    const manifest = JSON.parse(readFileSync(path.join(docs, '_manifest.json'), 'utf8'));
    const home = manifest.sections.find((entry: { id?: string }) => entry.id === manifest.default);
    expect(home?.file).toBeTruthy();
    // Homepage metadata is not necessarily the page body: the manifest can
    // select a separate HTML source that bypasses Markdown command rewriting.
    const content = readFileSync(path.join(docs, home.file), 'utf8');
    expect(content).toMatch(/project context and specialist workflows/i);
    expect(content).toContain('href="#getting-started/install-connect-verify"');
    expect(content).toContain('href="#providers/provider-inventory"');
    expect(content).toContain('.aiwg/marketing/brand/audit/readme-review.md');
    expect(content).not.toMatch(cliCommandPattern);
    expect(content).not.toMatch(legacyProviderCommandPattern);
    expect(content).not.toMatch(/\bnpm\s+(?:install|i)\b[^\n<]*\baiwg\b/i);
  });

  it('keeps agent and CLI references indexed with stable metadata', () => {
    const agentRoot = path.join(docs, 'agents');
    const markdownFiles = (directory: string): string[] =>
      readdirSync(directory).flatMap((entry) => {
        const absolute = path.join(directory, entry);
        if (statSync(absolute).isDirectory()) return markdownFiles(absolute);
        return entry.endsWith('.md') ? [absolute] : [];
      });
    const files = markdownFiles(agentRoot);
    expect(files).toContain(path.join(agentRoot, 'README.md'));
    expect(files).toContain(path.join(agentRoot, 'cli-reference.md'));
    expect(files).toContain(path.join(agentRoot, 'CLI_USAGE.md'));
    expect(files).toContain(path.join(agentRoot, 'providers', 'README.md'));
    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      expect(content).toMatch(/^---\n[\s\S]*audience: agent-operator/m);
      expect(content).toMatch(/^publication: agent-reference(?:-redirect)?$/m);
      expect(content).toMatch(/^stable_id: aiwg\.agent-reference\./m);
    }

    const cliRoot = path.join(docs, 'cli');
    for (const entry of [
      'reference.md',
      'agent-usage.md',
      'discovery-and-retrieval.md',
      'capability-routing.md',
      'web-backed-resources.md',
      'non-interactive.md',
      'regenerate.md',
    ]) {
      const content = readFileSync(path.join(cliRoot, entry), 'utf8');
      expect(content).toMatch(/^---\n[\s\S]*audience: agent-operator/m);
      expect(content).toMatch(/^publication: agent-reference$/m);
      expect(content).toMatch(/^stable_id: aiwg\.agent-reference\./m);
    }
  });

  it('publishes provider quickstarts as prompt-first journeys', () => {
    const output = path.join(outputRoot, 'prompt-first-provider-docs');
    execFileSync(process.execPath, ['tools/docs/build-public-source.mjs', output], {
      cwd: root,
      stdio: 'pipe',
    });
    const quickstarts = readdirSync(path.join(docs, 'integrations'))
      .filter((entry) => entry.endsWith('-quickstart.md'));
    expect(quickstarts.length).toBeGreaterThan(0);
    for (const entry of quickstarts) {
      const content = readFileSync(path.join(output, 'integrations', entry), 'utf8');
      expect(content).toContain('<!-- aiwg-public-operator-guidance -->');
      expect(content).toContain('Describe the outcome you want');
      expect(content).not.toMatch(cliCommandPattern);
      expect(content).not.toMatch(legacyProviderCommandPattern);
      expect(content).not.toMatch(/\bnpm\s+(?:install|i|add)\b[^\n`]*\baiwg\b/i);
    }
  });

  it('publishes user CLI landing pages without exact agent references', () => {
    const output = path.join(outputRoot, 'public-docs-source');
    execFileSync(process.execPath, ['tools/docs/build-public-source.mjs', output], {
      cwd: root,
      stdio: 'pipe',
    });
    expect(existsSync(path.join(output, 'agents'))).toBe(false);
    expect(existsSync(path.join(output, 'cli', 'README.md'))).toBe(true);
    expect(existsSync(path.join(output, 'cli', 'install-and-repair.md'))).toBe(true);
    expect(existsSync(path.join(output, 'cli', 'reference.md'))).toBe(true);
    expect(existsSync(path.join(output, 'cli', 'agent-usage.md'))).toBe(false);
    const manifest = JSON.parse(readFileSync(path.join(output, '_manifest.json'), 'utf8'));
    expect(manifest.order.some((entry: string) => entry === 'agents' || entry.startsWith('agents/'))).toBe(false);
  });

  it('retains the agent corpus in the npm package allowlist', () => {
    const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(packageJson.files).toContain('docs/');
  });

  it('documents the signed immutable release-bundle contract', () => {
    const index = readFileSync(path.join(docs, 'agents', 'README.md'), 'utf8');
    expect(index).toContain('https://releases.aiwg.io/resources/<version>/manifest.json');
    expect(index).toContain('https://releases.aiwg.io/resources/<version>/bundles/reference.tar.zst');
    expect(index).toContain('docs/agents/');
    expect(index).toContain('docs/cli/');
    expect(index).toContain('verify the signed manifest and bundle digest');
    expect(index).not.toContain('/raw/docs/agents/');
  });

  it('keeps all onboarding surfaces classified and removes command-first public entry points', () => {
    const output = path.join(outputRoot, 'docs-audience-audit.json');
    execFileSync(process.execPath, ['tools/docs/audit-audiences.mjs', output], {
      cwd: root,
      stdio: 'pipe',
    });
    const audit = JSON.parse(readFileSync(output, 'utf8'));
    assertCompleteAudienceInventory(audit);
    expect(audit.totals.onboardingNeedsReview).toBe(0);
    expect(audit.totals.publicCommandPages).toBeGreaterThan(0);
    expect(audit.totals.publicOperatorGuidancePages).toBeGreaterThan(0);
    expect(audit.totals.publicPublishedCommandPages).toBe(0);
    expect(audit.totals.publicPublishedCommandMentions).toBe(0);
    expect(audit.totals.publicPublishedAdvancedCommandPages).toBe(0);
    expect(audit.totals.publicPublishedAdvancedCommandMentions).toBe(0);
    expect(audit.totals.publicPublishedCliFlagMentions).toBe(0);
    expect(audit.totals.publicPublishedDiscoveryMentions).toBe(0);
    expect(audit.totals.publicUnclassifiedCommandPages).toBe(0);
    expect(audit.totals.coreJourneyAgentOwnedMentions).toBe(0);
    expect(audit.beforeAfter.current.homepageCommandChecklistItems).toBe(0);
    expect(audit.beforeAfter.current.publicCliNavigationEntries).toBe(0);
    expect(audit.beforeAfter.current.canonicalPublicCliReferenceEntries).toBe(1);
    expect(audit.beforeAfter.current.coreJourneyCommandMentions).toBe(0);
  });

  it('labels every retained public operator-command page in staged output', () => {
    const output = path.join(outputRoot, 'public-command-guidance');
    execFileSync(process.execPath, ['tools/docs/build-public-source.mjs', output], {
      cwd: root,
      stdio: 'pipe',
    });
    const auditOutput = path.join(outputRoot, 'public-command-audit.json');
    execFileSync(process.execPath, ['tools/docs/audit-audiences.mjs', auditOutput], {
      cwd: root,
      stdio: 'pipe',
    });
    const audit = JSON.parse(readFileSync(auditOutput, 'utf8'));
    for (const row of assertCompleteAudienceInventory(audit)) {
      const staged = readFileSync(path.join(output, row.path), 'utf8');
      expect(staged).toContain('<!-- aiwg-public-operator-guidance -->');
      expect(staged).toContain('Describe the outcome you want');
      expect(staged).not.toMatch(cliCommandPattern);
      expect(staged).not.toMatch(legacyProviderCommandPattern);
      expect(staged).not.toMatch(/\bnpm\s+(?:install|i|add)\b[^\n`]*\baiwg\b/i);
      expect(staged).not.toMatch(/(?<![a-z0-9-])--[a-z][a-z0-9-]*\b/);
    }
  });
});
