import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { fragmentsDir, inspectPackRegistry, loadOrchestrationPackRegistry, mustAllowlistPath, mustCoverageErrors, mustRequirementsPath, qualificationErrors, registryPath, requiredPacks } from '../../../tools/testing/check-orchestration-packs.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const checker = pathToFileURL(path.join(root, 'tools/testing/check-orchestration-packs.mjs')).href;
const registry = () => loadOrchestrationPackRegistry(root);
const roots: string[] = [];
afterEach(() => { for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe('T-OG registry wiring gate (partial coverage is not release acceptance)', () => {
  it('retains every registered file from the base and sorted fragments exactly once per pack', () => {
    const expected = JSON.parse(readFileSync(path.join(root, registryPath), 'utf8')).packs;
    for (const filename of readdirSync(path.join(root, fragmentsDir)).filter(name => name.endsWith('.json')).sort()) {
      const fragment = JSON.parse(readFileSync(path.join(root, fragmentsDir, filename), 'utf8'));
      for (const [id, entry] of Object.entries(fragment) as [string, any][]) {
        expected[id].testFiles.push(...(Array.isArray(entry) ? entry : entry.testFiles));
      }
    }
    const actual = registry().packs;
    expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
    for (const [id, pack] of Object.entries(expected) as [string, any][]) {
      expect(actual[id].testFiles, id).toEqual(pack.testFiles);
      expect(new Set(pack.testFiles).size, id).toBe(pack.testFiles.length);
    }
  });

  it('maps all requested S0/S1 packs to an issue/slice and existing tests', () => {
    const report = inspectPackRegistry(registry(), root);
    expect(Object.keys(report.packs)).toEqual(requiredPacks);
    expect(report.errors).toEqual([]);
    expect(report.result).toBe('wiring-valid');
    expect(report.releaseQualification).toBe('unqualified');
    expect(report.checkpoint).toBe(registry().checkpoint);
    expect(report.scopes.s1.result).toBe('partial');
    expect(report.scopes.managed.result).toBe('partial');
    expect(report.scopes.s1.acceptance).toBe('unverified');
    expect(report.scopes.s5Audit).toEqual({ result: 'unverified', enforcement: 'not-enforced', dependsOn: ['S1', 'S2', 'S3', 'S4'] });
    // T-OG-04/05 carry Tier 0 fixtures (#2954); T-OG-06 now carries
    // S1 Muse quota/partial and managed scheduler diagnostic fixtures. Negative cases explicitly remove files.
    expect(report.packs['T-OG-04'].status).toBe('partial');
    expect(report.packs['T-OG-04'].testFiles.length).toBeGreaterThan(0);
    expect(report.packs['T-OG-05'].status).toBe('partial');
    expect(report.packs['T-OG-05'].testFiles.length).toBeGreaterThan(0);
    expect(report.packs['T-OG-13']).toMatchObject({ name: 'P2/P3 extensions', ownerIssue: 'roctinam/aiwg#2875', status: 'partial' });
    expect(report.packs['T-OG-13'].remaining).toContain('#2925: direct/shared group templates');
    // Shared P2/P3 pack: #2925 templates, #2926 diagnostics, #2927 continuation and #2929 telemetry.
    expect(report.packs['T-OG-13'].mechanismOwners).toEqual(['B-OG-22', 'B-OG-23', 'B-OG-25', 'B-OG-21', 'B-OG-24']);
    expect(report.packs['T-OG-13'].testFiles).toEqual([
      'test/unit/serve/shared-host-scheduler-managed.test.ts',
      'test/unit/serve/shared-host-scheduler-budgets.test.ts',
      'test/unit/serve/shared-host-scheduler-host.test.ts',
      'test/unit/config/worker-templates.test.ts',
      'test/unit/models/worker-rubrics.test.ts',
      'test/unit/smiths/parallelism-templates.test.ts',
      'test/unit/ralph-external/session-attempt.test.ts',
      'test/unit/ralph-external/ralph-group-cycle.test.ts',
      'test/unit/ralph-external/snapshot-resilience.test.mjs',
      'test/unit/ralph-external/orchestrator-resilience.test.mjs',
      'test/unit/config/worker-adoption.test.ts',
      'test/unit/config/worker-adoption-recovery.test.ts',
      'test/unit/config/worker-owner-lock.test.ts',
      'test/unit/decision/worker-telemetry.test.ts',
      'test/unit/decision/worker-otlp.test.ts',
      'test/conformance/orchestration-v1/worker-telemetry.test.ts',
    ]);
    expect(report.packs['T-OG-06'].status).toBe('partial');
    expect(report.packs['T-OG-06'].testFiles).toEqual([
      'test/unit/serve/shared-host-scheduler-managed.test.ts',
      'test/unit/serve/shared-host-scheduler-budgets.test.ts',
      'test/unit/serve/shared-host-scheduler-host.test.ts',
      'test/unit/serve/shared-host-scheduler-fencing.test.ts',
      'test/conformance/orchestration-v1/muse-direct.test.ts',
      'test/unit/ralph/muse-direct.test.mjs',
    ]);
  });

  it.each(['partial', 'implemented'])('rejects %s without test files', status => {
    const value = registry();
    value.packs['T-OG-06'].status = status;
    value.packs['T-OG-06'].testFiles = [];
    expect(inspectPackRegistry(value, root).errors).toContain(`T-OG-06: ${status} without test files`);
  });

  it('rejects a declared file that has not landed rather than treating it as implemented', () => {
    const value = registry();
    value.packs['T-OG-02'].status = 'implemented';
    value.packs['T-OG-02'].testFiles = ['test/conformance/not-landed.test.ts'];
    expect(inspectPackRegistry(value, root).errors).toContain('T-OG-02: missing or invalid test file test/conformance/not-landed.test.ts');
  });

  it('rejects missing pack, owner, and slice metadata', () => {
    const value = registry();
    delete value.packs['T-OG-03'];
    delete value.packs['T-OG-01'].ownerIssue;
    value.packs['T-OG-01'].slice = 'S6';
    expect(inspectPackRegistry(value, root).errors).toEqual(expect.arrayContaining([
      'T-OG-03: missing pack', 'T-OG-01: owning issue is required', 'T-OG-01: owning slice must be S0–S5',
    ]));
  });

  it.each(['missing', 'unqualified'])('rejects %s qualification reported as a pass', qualification => {
    expect(qualificationErrors([{ id: 'synthetic', qualification, result: 'passed' }]))
      .toEqual(['synthetic: missing qualification cannot be reported as a pass']);
  });

  it('accepts an explicit unqualified result and requires scoped live evidence for a pass', () => {
    expect(qualificationErrors([{ id: 'missing-binary', qualification: 'missing', result: 'blocked' }])).toEqual([]);
    const qualified = { id: 'synthetic-report-validation-only', qualification: 'qualified', result: 'passed', evidence: {
      kind: 'live', version: 'fixture-version', account: 'fixture-account', profile: 'fixture-profile', transport: 'shell', reportRef: 'synthetic-reference',
    } };
    expect(qualificationErrors([qualified])).toEqual([]);
    expect(qualificationErrors([{ ...qualified, evidence: { kind: 'synthetic' } }])).toEqual([
      'synthetic-report-validation-only: pass requires version/account/profile/transport scoped live evidence',
    ]);
    expect(qualificationErrors([{ ...qualified, evidence: { ...qualified.evidence, profile: '' } }])).toHaveLength(1);
  });

  it('fails closed on malformed qualification reports', () => {
    expect(qualificationErrors(undefined)).toEqual(['qualificationResults must be an array']);
    expect(qualificationErrors([{ id: 'skipped', qualification: 'missing', result: 'skipped' }])).toHaveLength(1);
  });

  it.each(['valid', 'missing-qualification-pass', 'implemented-without-files'])('CLI exits and reports the intended %s result', scenario => {
    const directory = mkdtempSync(path.join(tmpdir(), 'aiwg-pack-gate-'));
    roots.push(directory);
    const value = registry();
    for (const pack of Object.values(value.packs) as any[]) {
      for (const file of pack.testFiles) {
        const destination = path.join(directory, file);
        mkdirSync(path.dirname(destination), { recursive: true });
        writeFileSync(destination, readFileSync(path.join(root, file), 'utf8'));
      }
    }
    if (scenario === 'missing-qualification-pass') value.qualificationResults = [{ id: 'fake', qualification: 'missing', result: 'passed' }];
    if (scenario === 'implemented-without-files') Object.assign(value.packs['T-OG-06'], { status: 'implemented', testFiles: [] });
    mkdirSync(path.dirname(path.join(directory, registryPath)), { recursive: true });
    writeFileSync(path.join(directory, registryPath), JSON.stringify(value));
    for (const inventory of [mustRequirementsPath, mustAllowlistPath]) {
      const destination = path.join(directory, inventory);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(path.join(root, inventory), 'utf8'));
    }
    const script = `import { runPackGate } from ${JSON.stringify(checker)}; runPackGate({ repositoryRoot: ${JSON.stringify(directory)} });`;
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 10_000 });
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    const report = JSON.parse(readFileSync(path.join(directory, 'test-results/orchestration-pack-registry.json'), 'utf8'));
    expect(child.status).toBe(scenario === 'valid' ? 0 : 1);
    expect(report.result).toBe(scenario === 'valid' ? 'wiring-valid' : 'failed');
    expect(report.releaseQualification).toBe('unqualified');
    if (scenario === 'missing-qualification-pass') expect(report.errors).toContain('fake: missing qualification cannot be reported as a pass');
    if (scenario === 'implemented-without-files') expect(report.errors).toContain('T-OG-06: implemented without test files');
  });

  it('registers provider profile tests only through packs.d fragments, never in packs.json itself', () => {
    // Provider CLI profiles each add packs.d/<provider>.json so concurrent
    // provider changes never edit the same packs.json lines. The one-time
    // migration was verified equivalent (152 pack/file pairs before and after).
    const base = JSON.parse(readFileSync(path.join(root, registryPath), 'utf8'));
    const offenders = Object.entries(base.packs as Record<string, any>)
      .flatMap(([id, pack]) => (pack.testFiles ?? []).filter((file: string) => /-direct\.test\.(ts|mjs)$/.test(file)).map((file: string) => `${id}::${file}`));
    expect(offenders).toEqual([]);
  });
});

describe('owned scenario content for implementation claims', () => {
  const id = 'T-OG-16';
  const file = 'test/conformance/owned.test.ts';
  const title = 'T-OG-16 NFR-OG-001 P01 bounded fixture dispatch';
  const valid = `import { it, expect } from 'vitest'; it('${title}', () => { expect(Math.max(1, 2)).toBe(2); });`;
  const evidence = (source = valid) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'aiwg-owned-pack-'));
    roots.push(directory);
    const value = registry();
    Object.assign(value.packs[id], { status: 'implemented', testFiles: [file], requirements: ['NFR-OG-001'], scenarios: [{
      id: 'P01', requirement: 'NFR-OG-001', mechanismOwner: 'B-OG-34', slice: 'S1', testFile: file, testName: title,
    }] });
    mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    writeFileSync(path.join(directory, file), source);
    return { value, directory };
  };
  const ownErrors = (value: any, directory: string) => inspectPackRegistry(value, directory).errors.filter((error: string) => error.startsWith(`${id}:`));

  it('accepts implemented only with owned requirements and runnable asserted scenarios', () => {
    const { value, directory } = evidence();
    expect(ownErrors(value, directory)).toEqual([]);
    expect(inspectPackRegistry(value, directory).releaseQualification).toBe('unqualified');
  });

  it('requires explicit mappings even when existing asserted test files are present', () => {
    const value = registry();
    value.packs['T-OG-02'].status = 'implemented';
    expect(inspectPackRegistry(value, root).errors).toContain('T-OG-02: implemented requires owned scenario/requirement mappings');
  });

  it.each([
    ['empty', ''],
    ['import only', "import { it, expect } from 'vitest';"],
    ['comment only', `// ${valid}`],
    ['string only', `const documentation = ${JSON.stringify(valid)};`],
    ['no assertion', `import { it } from 'vitest'; it('${title}', () => {});`],
    ['bare expect', `import { it, expect } from 'vitest'; it('${title}', () => { expect(2); });`],
    ['skipped test', valid.replace('it(', 'it.skip(')],
    ['todo test', valid.replace('it(', 'it.todo(')],
    ['skipped suite', `import { describe, it, expect } from 'vitest'; describe.skip('suite', () => { ${valid.split('; ').slice(1).join('; ')} });`],
    ['uncalled helper', `import { it, expect } from 'vitest'; it('${title}', () => { const helper = () => { expect(2).toBe(2); }; });`],
    ['uncalled suite helper', `function unused() { ${valid.split('; ').slice(1).join('; ')} }\nimport { it, expect } from 'vitest';`],
    ['node skip option', `import test from 'node:test'; import assert from 'node:assert/strict'; test('${title}', {skip: true}, () => assert.equal(2, 2));`],
    ['invalid syntax', `${valid} !@invalid syntax`],
  ])('rejects %s content', (_name, source) => {
    const { value, directory } = evidence(source);
    expect(ownErrors(value, directory)).toEqual(expect.arrayContaining([
      `${id}: test file ${file} has no runnable asserted tests`,
      `${id}: scenario P01: no matching runnable asserted test with pack/scenario/requirement title`,
    ]));
  });

  it('rejects an unrelated asserted test even with matching metadata in comments', () => {
    const { value, directory } = evidence(`${valid.replace(title, 'unrelated computation')}\n// ${title}`);
    expect(ownErrors(value, directory)).toEqual([`${id}: scenario P01: no matching runnable asserted test with pack/scenario/requirement title`]);
  });

  it('accepts runnable node:test assertion evidence and imported aliases', () => {
    for (const source of [
      `import test from 'node:test'; import assert from 'node:assert/strict'; test('${title}', () => assert.equal(Math.max(1, 2), 2));`,
      `import { it as scenario, expect as check } from 'vitest'; scenario('${title}', () => { check (Math.max(1, 2)).toBe(2); });`,
    ]) {
      const { value, directory } = evidence(source);
      expect(ownErrors(value, directory)).toEqual([]);
    }
  });

  it.each([
    ['requirement', 'FR-OG-999', 'requirement is not declared by pack'],
    ['mechanismOwner', 'B-OG-99', 'mechanism owner is not owned by pack'],
    ['slice', 'S2', 'slice is not owned by pack'],
    ['testFile', 'test/conformance/unrelated.test.ts', 'test file is not registered to pack'],
  ])('rejects a scenario with an unowned %s', (field, value, message) => {
    const f = evidence();
    f.value.packs[id].scenarios[0][field] = value;
    expect(ownErrors(f.value, f.directory)).toContain(`${id}: scenario P01: ${message}`);
  });

  it('rejects unregistered requirements, duplicate scenarios and unrelated registered files', () => {
    const { value, directory } = evidence();
    value.packs[id].requirements.push('FR-OG-083');
    value.packs[id].scenarios.push({ ...value.packs[id].scenarios[0] });
    const extra = 'test/conformance/unrelated.test.ts';
    value.packs[id].testFiles.push(extra);
    writeFileSync(path.join(directory, extra), valid.replace(title, 'unrelated'));
    expect(ownErrors(value, directory)).toEqual(expect.arrayContaining([
      `${id}: unmapped requirement FR-OG-083`, `${id}: scenario P01: invalid or duplicate ID`,
      `${id}: unrelated test file ${extra} has no owned scenario`,
    ]));
  });

  it('validates partial scenario mappings without promoting partial coverage', () => {
    const value = registry();
    expect(inspectPackRegistry(value, root).errors).toEqual([]);
    expect(value.packs['T-OG-15'].status).toBe('partial');
    expect(value.packs['T-OG-16'].status).toBe('partial');
    value.packs['T-OG-15'].scenarios[0].mechanismOwner = 'B-OG-99';
    expect(inspectPackRegistry(value, root).errors).toContain('T-OG-15: scenario P02: mechanism owner is not owned by pack');
  });

  it('separates S1/shared and managed/later verdicts without upgrading later slices', () => {
    const value = registry();
    for (const pack of Object.values(value.packs) as any[]) {
      pack.testFiles = []; pack.status = 'planned';
      delete pack.requirements; delete pack.scenarios;
    }
    Object.assign(value.packs['T-OG-05'], { status: 'implemented' });
    const report = inspectPackRegistry(value, root);
    expect(report.scopes.s1.errors).toContain('T-OG-05: implemented without test files'); // Shared S1 ownership.
    expect(report.scopes.managed.errors).toContain('T-OG-05: implemented without test files');
    expect(report.scopes.laterSlices.S4.packs).toContainEqual({ id: 'T-OG-05', slice: 'S4', relationship: 'later', status: 'unverified' });
    expect(report.scopes.laterSlices.S5.result).toBe('unverified');
    value.packs['T-OG-05'].status = 'planned';
    Object.assign(value.packs['T-OG-08'], { status: 'implemented' }); // Managed-only pack.
    const managedFailure = inspectPackRegistry(value, root);
    expect(managedFailure.scopes.s1.result).toBe('unverified');
    expect(managedFailure.scopes.s1.errors).toEqual([]);
    expect(managedFailure.scopes.managed.result).toBe('failed');
    value.packs['T-OG-08'].laterSlices = ['S6'];
    expect(inspectPackRegistry(value, root).errors).toContain('T-OG-08: invalid laterSlices');
  });
});

describe('T-OG Must requirement inventory against pack mappings', () => {
  const mustRoot = (allowlist: unknown) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'aiwg-must-inventory-'));
    roots.push(directory);
    for (const inventory of [mustRequirementsPath, mustAllowlistPath]) {
      const destination = path.join(directory, inventory);
      mkdirSync(path.dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(path.join(root, inventory), 'utf8'));
    }
    if (allowlist !== undefined) {
      writeFileSync(path.join(directory, mustAllowlistPath),
        JSON.stringify({ note: 'synthetic', allowlist }, null, 2));
    }
    return directory;
  };

  it('maps every Must requirement or names a reviewed allowlist reason', () => {
    const value = registry();
    expect(mustCoverageErrors(value, root)).toEqual([]);
    expect(inspectPackRegistry(value, root).errors.filter(error => /^(N?FR)-OG-\d{3}:/.test(error))).toEqual([]);
  });

  it('inventories 106 FR and 22 NFR Musts with only the two new mappings unallowlisted', () => {
    const must = JSON.parse(readFileSync(path.join(root, mustRequirementsPath), 'utf8'));
    expect(must.requirements).toHaveLength(128);
    expect(new Set(must.requirements.map((entry: any) => entry.id)).size).toBe(128);
    const allowlist = JSON.parse(readFileSync(path.join(root, mustAllowlistPath), 'utf8')).allowlist;
    expect(Object.keys(allowlist).sort()).toEqual(
      must.requirements.map((entry: any) => entry.id).filter((id: string) => !['NFR-OG-001', 'NFR-OG-003'].includes(id)).sort());
  });

  it('fails on a new unmapped Must without an allowlist entry', () => {
    const allowlist = JSON.parse(readFileSync(path.join(root, mustAllowlistPath), 'utf8')).allowlist;
    delete allowlist['FR-OG-001'];
    expect(mustCoverageErrors(registry(), mustRoot(allowlist))).toEqual(
      ['FR-OG-001: Must requirement has no pack requirements/scenarios mapping']);
  });

  it('fails on a stale entry whose Must became mapped', () => {
    const allowlist = JSON.parse(readFileSync(path.join(root, mustAllowlistPath), 'utf8')).allowlist;
    allowlist['NFR-OG-001'] = 'synthetic stale entry';
    expect(mustCoverageErrors(registry(), mustRoot(allowlist))).toEqual(
      [`${mustAllowlistPath}: NFR-OG-001 is now mapped; remove the allowlist entry`]);
  });

  it('fails on allowlist entries outside the inventory or without a reason', () => {
    const allowlist = JSON.parse(readFileSync(path.join(root, mustAllowlistPath), 'utf8')).allowlist;
    allowlist['FR-OG-999'] = 'synthetic unknown';
    allowlist['FR-OG-002'] = '  ';
    expect(mustCoverageErrors(registry(), mustRoot(allowlist))).toEqual(expect.arrayContaining([
      `${mustAllowlistPath}: FR-OG-999 is not a Must requirement`,
      `${mustAllowlistPath}: FR-OG-002 needs a reviewed reason`,
    ]));
  });

  it('fails closed when the inventory files are absent', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'aiwg-must-missing-'));
    roots.push(directory);
    expect(mustCoverageErrors(registry(), directory)).toEqual([`${mustRequirementsPath} is missing or invalid`]);
  });
});

describe('loadOrchestrationPackRegistry fragment merge', () => {
  const makeRoot = () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'aiwg-pack-fragments-'));
    roots.push(directory);
    const base = {
      revision: 1,
      packs: {
        'T-OG-01': { testFiles: ['test/conformance/orchestration-v1/pack-registry.test.ts'] },
        'T-OG-02': { testFiles: [] },
      },
    };
    mkdirSync(path.dirname(path.join(directory, registryPath)), { recursive: true });
    writeFileSync(path.join(directory, registryPath), JSON.stringify(base));
    mkdirSync(path.join(directory, fragmentsDir), { recursive: true });
    return directory;
  };
  const writeFragment = (directory: string, name: string, contents: unknown) =>
    writeFileSync(path.join(directory, fragmentsDir, name), typeof contents === 'string' ? contents : JSON.stringify(contents));

  it('merges fragments after the base registry in sorted fragment-filename order', () => {
    const directory = makeRoot();
    writeFragment(directory, 'zeta.json', { 'T-OG-02': ['test/conformance/orchestration-v1/zeta-direct.test.ts'] });
    writeFragment(directory, 'alpha.json', { 'T-OG-01': ['test/conformance/orchestration-v1/alpha-direct.test.ts'], 'T-OG-02': ['test/conformance/orchestration-v1/alpha-direct.test.ts'] });
    const merged = loadOrchestrationPackRegistry(directory);
    expect(merged.packs['T-OG-01'].testFiles).toEqual([
      'test/conformance/orchestration-v1/pack-registry.test.ts',
      'test/conformance/orchestration-v1/alpha-direct.test.ts',
    ]);
    // alpha.json sorts before zeta.json, so alpha's T-OG-02 entry is appended first.
    expect(merged.packs['T-OG-02'].testFiles).toEqual([
      'test/conformance/orchestration-v1/alpha-direct.test.ts',
      'test/conformance/orchestration-v1/zeta-direct.test.ts',
    ]);
  });

  it('merges owned scenario metadata without allowing fragments to upgrade status', () => {
    const directory = makeRoot();
    const scenario = { id: 'P01', requirement: 'NFR-OG-001', mechanismOwner: 'B-OG-34' };
    const mechanismOwners = ['B-OG-34'];
    writeFragment(directory, 'mapping.json', { 'T-OG-01': { testFiles: [], requirements: ['NFR-OG-001'], scenarios: [scenario], mechanismOwners } });
    writeFragment(directory, 'shared-requirement.json', { 'T-OG-01': { testFiles: [], requirements: ['NFR-OG-001'], scenarios: [{ ...scenario, id: 'P02' }], mechanismOwners: ['B-OG-34', 'B-OG-21'] } });
    const pack = loadOrchestrationPackRegistry(directory).packs['T-OG-01'];
    expect(pack.requirements).toEqual(['NFR-OG-001']);
    expect(pack.mechanismOwners).toEqual(['B-OG-34', 'B-OG-21']);
    expect(pack.scenarios).toEqual([scenario, { ...scenario, id: 'P02' }]);
    writeFragment(directory, 'mapping.json', { 'T-OG-01': { testFiles: [], status: 'implemented' } });
    expect(() => loadOrchestrationPackRegistry(directory)).toThrow(/unsupported fragment fields/);
    writeFragment(directory, 'mapping.json', { 'T-OG-01': { testFiles: [], scenarios: 'invalid' } });
    expect(() => loadOrchestrationPackRegistry(directory)).toThrow(/scenarios must be an array/);
    writeFragment(directory, 'mapping.json', { 'T-OG-01': { testFiles: [], mechanismOwners: 'invalid' } });
    expect(() => loadOrchestrationPackRegistry(directory)).toThrow(/mechanismOwners must be an array/);
  });

  it('throws on a fragment referencing an unknown pack ID', () => {
    const directory = makeRoot();
    writeFragment(directory, 'bogus.json', { 'T-OG-99': ['test/conformance/orchestration-v1/bogus-direct.test.ts'] });
    expect(() => loadOrchestrationPackRegistry(directory)).toThrow(/unknown pack T-OG-99/);
  });

  it('throws on a non-array pack value in a fragment', () => {
    const directory = makeRoot();
    writeFragment(directory, 'bogus.json', { 'T-OG-01': 'not-an-array' });
    expect(() => loadOrchestrationPackRegistry(directory)).toThrow(/must map to an array of test files/);
  });

  it('throws on a duplicate test file already registered in the base registry', () => {
    const directory = makeRoot();
    writeFragment(directory, 'dup.json', { 'T-OG-01': ['test/conformance/orchestration-v1/pack-registry.test.ts'] });
    expect(() => loadOrchestrationPackRegistry(directory)).toThrow(/duplicate test file/);
  });

  it('throws on a duplicate test file registered by two fragments', () => {
    const directory = makeRoot();
    writeFragment(directory, 'alpha.json', { 'T-OG-02': ['test/conformance/orchestration-v1/shared-direct.test.ts'] });
    writeFragment(directory, 'beta.json', { 'T-OG-02': ['test/conformance/orchestration-v1/shared-direct.test.ts'] });
    expect(() => loadOrchestrationPackRegistry(directory)).toThrow(/duplicate test file/);
  });

  it('throws on malformed fragment JSON', () => {
    const directory = makeRoot();
    writeFragment(directory, 'broken.json', '{ not valid json');
    expect(() => loadOrchestrationPackRegistry(directory)).toThrow(/invalid JSON/);
  });

  it('throws on a fragment that is not a JSON object', () => {
    const directory = makeRoot();
    writeFragment(directory, 'array.json', ['not', 'an', 'object']);
    expect(() => loadOrchestrationPackRegistry(directory)).toThrow(/fragment must be a JSON object/);
  });

  it('tolerates a missing packs.d directory', () => {
    const directory = makeRoot();
    rmSync(path.join(directory, fragmentsDir), { recursive: true, force: true });
    const merged = loadOrchestrationPackRegistry(directory);
    expect(merged.packs['T-OG-01'].testFiles).toEqual(['test/conformance/orchestration-v1/pack-registry.test.ts']);
  });
});
