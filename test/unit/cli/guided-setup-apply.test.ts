import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { guidedInventory } from '../../helpers/guided-setup-fixture.js';
import { guidedHarness } from '../../helpers/guided-setup-harness.js';
import { writeSetupPlan } from '../../../src/discovery/plan-store.js';
import { buildInterviewPlan, questionId } from '../../../src/discovery/interview.js';
import { INTERVIEW_TIME } from '../../helpers/guided-setup-fixture.js';
import type { SetupPlan, PlanValue } from '../../../src/discovery/plan-types.js';
import { workspaceSlug } from '../../../src/discovery/interview.js';

vi.mock('../../../src/cli/env.js', () => ({ isInteractive: vi.fn() }));
vi.mock('../../../src/cli/prompt-utils.js', async importOriginal => ({ ...await importOriginal<object>(), askString: vi.fn(), createPromptInterface: vi.fn() }));
vi.mock('../../../src/discovery/index.js', async importOriginal => ({ ...await importOriginal<object>(), discoverInventory: vi.fn() }));
vi.mock('../../../src/config/aiwg-config.js', async importOriginal => ({ ...await importOriginal<object>(), readAiwgConfig: vi.fn(), writeAiwgConfig: vi.fn() }));
vi.mock('../../../src/process/bounded-child-process.mjs', () => ({ boundedSpawnSync: vi.fn() }));
vi.mock('../../../src/decision/driver.js', async importOriginal => ({ ...await importOriginal<object>(), setupJev: vi.fn() }));
import { setupJev } from '../../../src/decision/driver.js';
import { isInteractive } from '../../../src/cli/env.js';
import { discoverInventory } from '../../../src/discovery/index.js';
import { readAiwgConfig, writeAiwgConfig } from '../../../src/config/aiwg-config.js';
import { boundedSpawnSync } from '../../../src/process/bounded-child-process.mjs';
import { initHandler } from '../../../src/cli/handlers/init.js';
import { setupHandler } from '../../../src/cli/handlers/setup.js';

const SENTINEL_ENV = 'AIWG_TEST_REVIEW_SENTINEL';
const SENTINEL_VALUE = 'canary-apply-probe-value';

let harness: ReturnType<typeof guidedHarness>;
let inventory: ReturnType<typeof guidedInventory>;

function planPath(): string {
  return join(harness.artifacts, 'setup', 'plans', `setup-${workspaceSlug(harness.project)}.json`);
}

function snapshotTree(root: string): Map<string, string> {
  const entries = new Map<string, string>();
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const absolute = join(dir, name);
      if (statSync(absolute).isDirectory()) walk(absolute);
      else entries.set(absolute.slice(root.length), readFileSync(absolute, 'utf8'));
    }
  };
  walk(root);
  return entries;
}

async function recordPlan(): Promise<void> {
  await initHandler.execute(harness.ctx(['--scope', 'project', '--providers', 'codex',
    '--credential', `codex=env:${SENTINEL_ENV}`, '--yes']));
  expect(existsSync(planPath())).toBe(true);
}

beforeEach(() => {
  harness = guidedHarness('aiwg-guided-apply-');
  inventory = guidedInventory(harness.project);
  vi.mocked(isInteractive).mockReturnValue(false);
  vi.mocked(discoverInventory).mockImplementation(async () => structuredClone(inventory));
  vi.mocked(readAiwgConfig).mockResolvedValue(null);
  vi.mocked(boundedSpawnSync).mockReturnValue({ status: 0, stdout: '', stderr: '' } as never);
  vi.mocked(writeAiwgConfig).mockResolvedValue(undefined);
  vi.mocked(setupJev).mockResolvedValue({ configured: true } as never);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubEnv(SENTINEL_ENV, SENTINEL_VALUE);
});

afterEach(() => {
  harness.cleanup();
  vi.unstubAllEnvs();
});

describe('guided setup review and apply', () => {
  async function integrationPlan(kind: 'jev' | 'workers', reference?: PlanValue, options?: PlanValue): Promise<void> {
    const answers: SetupPlan['answers'] = {};
    const put = (id: string, value: PlanValue) => { answers[id] = { value, source: 'interview', answeredAt: INTERVIEW_TIME }; };
    put(questionId('targets', 'workspaces', harness.project), [harness.project]);
    if (kind === 'jev') {
      put(questionId('capabilities', 'jev', harness.project), 'enable');
      if (reference) put(questionId('locations', 'credential-source', harness.project, 'jev'), reference);
      if (options) put(questionId('capabilities', 'jev-options', harness.project, 'jev'), options);
    } else {
      put(questionId('tools', 'worker-dispatch', harness.project), 'enable');
      if (options) put(questionId('capabilities', 'worker-config', harness.project), options);
    }
    await writeSetupPlan(harness.project, buildInterviewPlan({ inventory, workspaceRoot: harness.project }, answers, INTERVIEW_TIME));
  }

  it('passes Jev bytes directly to the existing owner; child variables, argv, output and receipts stay canary-free', async () => {
    await integrationPlan('jev', { kind: 'credential-ref', source: 'env', name: SENTINEL_ENV }, { region: 'eu', verify: true });
    vi.mocked(setupJev).mockResolvedValue({ verified: true } as never);
    expect(readFileSync(planPath(), 'utf8')).not.toContain(SENTINEL_VALUE);
    const review = await setupHandler.execute(harness.ctx(['--review', '--json']));
    expect(review.message).not.toContain(SENTINEL_VALUE);
    const result = await setupHandler.execute(harness.ctx(['--apply', '--yes']));
    expect(result.exitCode).toBe(0);
    expect(setupJev).toHaveBeenCalledWith({ token: SENTINEL_VALUE, region: 'eu', verify: true, remove: false },
      { env: process.env, cwd: harness.project });
    for (const [, args, , options] of vi.mocked(boundedSpawnSync).mock.calls) {
      expect(args.join(' ')).not.toContain(SENTINEL_VALUE);
      expect(Object.values(options?.env ?? {})).not.toContain(SENTINEL_VALUE);
    }
    expect(`${result.message}${readFileSync(planPath(), 'utf8')}${JSON.stringify(vi.mocked(console.log).mock.calls)}`).not.toContain(SENTINEL_VALUE);
  });

  it.each([{ verified: false }, {}])(
    'keeps Jev retryable when requested verification is incomplete (%s)', async response => {
      await integrationPlan('jev', { kind: 'credential-ref', source: 'env', name: SENTINEL_ENV }, { verify: true });
      vi.mocked(setupJev).mockResolvedValue(response as never);
      const result = await setupHandler.execute(harness.ctx(['--apply', '--yes', '--json']));
      expect(JSON.parse(result.message!)).toMatchObject({ classification: 'partial', results: [{ status: 'failed', optional: true }] });
      const saved: SetupPlan = JSON.parse(readFileSync(planPath(), 'utf8'));
      expect(saved.receipts.flatMap(receipt => Object.values(receipt.actions))).toEqual([expect.objectContaining({ status: 'failed' })]);
      expect(readFileSync(planPath(), 'utf8')).not.toContain(SENTINEL_VALUE);
    });

  it('removes Jev through the existing owner without resolving any API input', async () => {
    await initHandler.execute(harness.ctx(['--scope', 'project', '--remove', '--yes']));
    const plan: SetupPlan = JSON.parse(readFileSync(planPath(), 'utf8'));
    // Focus this saved-plan apply on the explicitly requested integration.
    plan.actions = plan.actions.filter(action => action.kind === 'configure-jev');
    await writeSetupPlan(harness.project, plan);
    const input = vi.spyOn(process.stdin, Symbol.asyncIterator);
    const result = await setupHandler.execute(harness.ctx(['--apply', '--yes']));
    expect(result.exitCode).toBe(0);
    expect(setupJev).toHaveBeenCalledWith({ token: undefined, verify: false, remove: true }, expect.any(Object));
    expect(input).not.toHaveBeenCalled();
    // A later decline must not resurrect the previous removal action.
    await initHandler.execute(harness.ctx(['--scope', 'project', '--jev', 'decline', '--yes']));
    const declined: SetupPlan = JSON.parse(readFileSync(planPath(), 'utf8'));
    expect(declined.actions.some(action => action.kind === 'configure-jev')).toBe(false);
  });

  it.skipIf(process.platform === 'win32').each(['codex', 'jev'])('refuses %s files with group or other access before invoking owners', async provider => {
    const input = join(harness.scratch, 'public-input');
    writeFileSync(input, SENTINEL_VALUE, { mode: 0o644 });
    if (provider === 'jev') await integrationPlan('jev', { kind: 'credential-ref', source: 'file', name: input });
    else {
      await recordPlan();
      const plan: SetupPlan = JSON.parse(readFileSync(planPath(), 'utf8'));
      plan.actions = plan.actions.filter(action => action.kind === 'configure-provider');
      plan.answers[questionId('locations', 'credential-source', harness.project, 'codex')].value = { kind: 'credential-ref', source: 'file', name: input };
      await writeSetupPlan(harness.project, plan);
    }
    const result = await setupHandler.execute(harness.ctx(['--apply', '--yes', '--json']));
    expect(JSON.parse(result.message!)).toMatchObject({ classification: provider === 'jev' ? 'partial' : 'failure', results: [{ status: 'skipped' }] });
    expect(setupJev).not.toHaveBeenCalled();
    expect(`${result.message}${readFileSync(planPath(), 'utf8')}`).not.toContain(SENTINEL_VALUE);
  });

  it('consumes a stdin reference only at apply and keeps it out of output', async () => {
    const input = vi.spyOn(process.stdin, Symbol.asyncIterator).mockImplementation(async function* () { yield Buffer.from(SENTINEL_VALUE); });
    await integrationPlan('jev', { kind: 'credential-ref', source: 'stdin-at-apply', name: 'stdin' });
    expect(input).not.toHaveBeenCalled();
    const result = await setupHandler.execute(harness.ctx(['--apply', '--yes']));
    expect(result.exitCode).toBe(0);
    expect(input).toHaveBeenCalledOnce();
    expect(setupJev).toHaveBeenCalledWith(expect.objectContaining({ token: SENTINEL_VALUE }), expect.any(Object));
    expect(`${result.message}${readFileSync(planPath(), 'utf8')}`).not.toContain(SENTINEL_VALUE);
  });

  it.each([undefined, { kind: 'credential-ref', source: 'env', name: 'AIWG_TEST_MISSING_JEV' }])('keeps missing Jev input optional and retryable (%j)', async reference => {
    vi.stubEnv('AIWG_TEST_MISSING_JEV', '');
    await integrationPlan('jev', reference as PlanValue | undefined);
    const result = await setupHandler.execute(harness.ctx(['--apply', '--yes', '--json']));
    expect(JSON.parse(result.message!)).toMatchObject({ classification: 'partial', results: [{ optional: true, status: 'skipped' }] });
    expect(setupJev).not.toHaveBeenCalled();
  });

  it('does not persist a Jev owner error containing the API input', async () => {
    await integrationPlan('jev', { kind: 'credential-ref', source: 'env', name: SENTINEL_ENV });
    vi.mocked(setupJev).mockRejectedValue(new Error(SENTINEL_VALUE));
    const result = await setupHandler.execute(harness.ctx(['--apply', '--yes', '--json']));
    expect(JSON.parse(result.message!)).toMatchObject({ classification: 'partial', results: [{ status: 'failed' }] });
    expect(`${result.message}${readFileSync(planPath(), 'utf8')}`).not.toContain(SENTINEL_VALUE);
  });

  it.each(['recorded', 'partial', 'failed'])('enables direct dispatch and reports doctor qualification %s accurately', async status => {
    const settings = { clis: { codex: { adapter: 'providers:codex', executable: '/synthetic/codex', accountScope: 'test-account', quotaScope: 'test-quota' } },
      groups: { coding: { members: [{ id: 'coder', cli: 'codex', model: 'gpt-5.4', roles: ['coding'] }], maxParallel: 1 } },
      admission: { cliCaps: { codex: 1 } } };
    await integrationPlan('workers', undefined, settings);
    const review = JSON.parse((await setupHandler.execute(harness.ctx(['--review', '--json']))).message!);
    expect(review.readiness.find((entry: { area: string }) => entry.area === 'integration').ready).toBe(false);
    vi.mocked(boundedSpawnSync).mockReturnValue({ status: status === 'recorded' ? 0 : 1,
      stdout: JSON.stringify({ qualification: { status, results: [{ cli: 'codex', status: 'qualified' }] } }), stderr: '' } as never);
    const result = await setupHandler.execute(harness.ctx(['--apply', '--yes', '--json']));
    expect(JSON.parse(result.message!).classification).toBe(status === 'recorded' ? 'success' : 'partial');
    expect(writeAiwgConfig).toHaveBeenCalledWith(harness.project, expect.objectContaining({ parallelism: expect.objectContaining({ worker_dispatch: true, ...settings }) }));
    expect(vi.mocked(boundedSpawnSync).mock.calls.some(([, args]) => args.includes('doctor') && args.includes('--probe-workers') && args.includes('--qualify'))).toBe(true);
    expect(vi.mocked(boundedSpawnSync).mock.calls.flatMap(([, args]) => args)).not.toContain('--daemon');
  });

  it('--review renders per workspace and provider and writes nothing', async () => {
    await recordPlan();
    const before = snapshotTree(harness.scratch);
    const planBytes = readFileSync(planPath(), 'utf8');
    const result = await setupHandler.execute(harness.ctx(['--review']));
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain(`workspace ${harness.project}`);
    expect(result.message).toContain('provider codex');
    expect(result.message).toContain('destination:');
    expect(result.message).toContain('diff:');
    expect(result.message).toContain('readiness');
    expect(result.message).not.toContain(SENTINEL_VALUE);
    expect(snapshotTree(harness.scratch)).toEqual(before);
    expect(readFileSync(planPath(), 'utf8')).toBe(planBytes);
  });

  it('--review --json emits the review schema without the credential value', async () => {
    await recordPlan();
    const before = snapshotTree(harness.scratch);
    const result = await setupHandler.execute(harness.ctx(['--review', '--json']));
    expect(result.exitCode).toBe(0);
    const review = JSON.parse(result.message!);
    expect(review.schema).toBe('aiwg.setup.review.v1');
    expect(review.planId).toBe(`setup-${workspaceSlug(harness.project)}`);
    expect(review.actions.length).toBeGreaterThan(0);
    expect(review.readiness.length).toBeGreaterThan(0);
    expect(result.message).toContain(SENTINEL_ENV);
    expect(result.message).not.toContain(SENTINEL_VALUE);
    expect(snapshotTree(harness.scratch)).toEqual(before);
  });

  it('--dry-run on a saved guided plan previews the review and writes nothing', async () => {
    await recordPlan();
    const before = snapshotTree(harness.scratch);
    const result = await setupHandler.execute(harness.ctx(['--dry-run']));
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain(`workspace ${harness.project}`);
    expect(snapshotTree(harness.scratch)).toEqual(before);
  });

  it('--apply --yes applies core actions through the existing owners', async () => {
    await recordPlan();
    const result = await setupHandler.execute(harness.ctx(['--apply', '--yes']));
    expect(result.exitCode).toBe(0);
    expect(result.message).toContain('Applied');
    // Project policy goes through the setup config owner (merged, not invented here).
    expect(writeAiwgConfig).toHaveBeenCalled();
    // configure-provider writes no provider files: a missing provider file is
    // owned by deploy-framework, and the action still applies.
    const providerFile = join(harness.project, 'AGENTS.md');
    expect(existsSync(providerFile)).toBe(false);
    const plan = JSON.parse(readFileSync(planPath(), 'utf8'));
    const receipts = plan.receipts.flatMap((receipt: { actions: Record<string, { status: string; message?: string }> }) =>
      Object.entries(receipt.actions));
    const configured = receipts.find(([id]: [string]) =>
      plan.actions.find((action: { id: string; kind: string }) => action.id === id && action.kind === 'configure-provider'));
    expect(configured[1].status).toBe('applied');
    expect(configured[1].message).toContain('deploy-framework');
    expect(configured[1].message).toContain('nothing written');
    // Receipts persist through the plan store; nothing applied stays eligible.
    const { remainingPlanActions } = await import('../../../src/discovery/plan-store.js');
    expect(remainingPlanActions(plan)).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain(SENTINEL_VALUE);
  });

  it('configure-provider preserves an existing provider file without modifying it', async () => {
    await recordPlan();
    const providerFile = join(harness.project, 'AGENTS.md');
    writeFileSync(providerFile, '# my own config\n');
    const result = await setupHandler.execute(harness.ctx(['--apply', '--yes']));
    expect(result.exitCode).toBe(0);
    expect(readFileSync(providerFile, 'utf8')).toBe('# my own config\n');
    const plan = JSON.parse(readFileSync(planPath(), 'utf8'));
    const messages = plan.receipts.flatMap((receipt: { actions: Record<string, { message?: string }> }) =>
      Object.values(receipt.actions).map(entry => entry.message ?? '')).join('\n');
    expect(messages).toContain('preserved');
  });

  it('configure-provider never creates or modifies a JSON provider config', async () => {
    await recordPlan();
    // Point the recorded provider path at a JSON config (comment lines would corrupt it).
    const settingsPath = join(harness.project, 'settings.json');
    const saved = JSON.parse(readFileSync(planPath(), 'utf8'));
    for (const action of saved.actions) {
      if (action.kind === 'configure-provider') {
        for (const fact of action.dependsOn) if (fact.kind === 'path') fact.path = settingsPath;
      }
    }
    for (const answer of Object.values(saved.answers) as Array<{ value: unknown }>) {
      if (typeof answer.value === 'string' && answer.value.endsWith('AGENTS.md')) answer.value = settingsPath;
    }
    writeFileSync(planPath(), JSON.stringify(saved, null, 2));
    const original = JSON.stringify({ key: 'value' });
    writeFileSync(settingsPath, original);
    const result = await setupHandler.execute(harness.ctx(['--apply', '--yes']));
    expect(result.exitCode).toBe(0);
    // Byte-identical: no comment lines written, still parses as JSON.
    expect(readFileSync(settingsPath, 'utf8')).toBe(original);
    expect(() => JSON.parse(readFileSync(settingsPath, 'utf8'))).not.toThrow();
  });

  it('configure-provider writes nothing when the JSON provider config is missing', async () => {
    await recordPlan();
    const settingsPath = join(harness.project, 'settings.json');
    const saved = JSON.parse(readFileSync(planPath(), 'utf8'));
    for (const action of saved.actions) {
      if (action.kind === 'configure-provider') {
        for (const fact of action.dependsOn) if (fact.kind === 'path') fact.path = settingsPath;
      }
    }
    for (const answer of Object.values(saved.answers) as Array<{ value: unknown }>) {
      if (typeof answer.value === 'string' && answer.value.endsWith('AGENTS.md')) answer.value = settingsPath;
    }
    writeFileSync(planPath(), JSON.stringify(saved, null, 2));
    const result = await setupHandler.execute(harness.ctx(['--apply', '--yes']));
    expect(result.exitCode).toBe(0);
    expect(existsSync(settingsPath)).toBe(false);
  });

  it('--apply without --yes refuses in a non-interactive context before writing', async () => {
    await recordPlan();
    const planBytes = readFileSync(planPath(), 'utf8');
    await expect(setupHandler.execute(harness.ctx(['--apply']))).rejects.toMatchObject({ code: 'ERR_NON_INTERACTIVE_CONFIRMATION_REQUIRED' });
    expect(writeAiwgConfig).not.toHaveBeenCalled();
    expect(existsSync(join(harness.project, 'AGENTS.md'))).toBe(false);
    expect(readFileSync(planPath(), 'utf8')).toBe(planBytes);
  });

  it('--review without a saved plan names the planning flags', async () => {
    await expect(setupHandler.execute(harness.ctx(['--review']))).rejects.toMatchObject({ code: 'ERR_SETUP_PLAN_NOT_FOUND' });
  });

  it('advertises --review and --apply in setup help and command metadata', async () => {
    const help = (await setupHandler.help!(harness.ctx([]))).message!;
    expect(help).toContain('--review');
    expect(help).toContain('--apply');
    const { setupCommand } = await import('../../../src/extensions/commands/definitions.js');
    expect(JSON.stringify(setupCommand.metadata)).toContain('--review');
    expect(JSON.stringify(setupCommand.metadata)).toContain('--apply');
  });

  it('keeps every apply write inside the scratch roots', async () => {
    await recordPlan();
    await setupHandler.execute(harness.ctx(['--apply', '--yes']));
    const allowed = [harness.project, harness.artifacts, join(harness.scratch, 'memory')].map(root => resolve(root));
    const files: string[] = [];
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return;
      for (const name of readdirSync(dir)) {
        const absolute = resolve(dir, name);
        if (statSync(absolute).isDirectory()) walk(absolute);
        else files.push(absolute);
      }
    };
    walk(harness.scratch);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(allowed.some(root => file === root || file.startsWith(`${root}/`))).toBe(true);
    }
  });
});
