/**
 * `aiwg effect` CLI integration tests (#2720). Every case runs the real
 * handler against a temporary project whose artifact root is a separate
 * temporary directory, with an in-memory key store and checkpoint sink.
 * Offline only.
 */
import { createPrivateKey } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemorySecretStore, type SecretStore } from '../../../../src/auth/credential-store.js';
import { createEffectHandler, effectUsage, EFFECT_SUBCOMMANDS, type EffectCliDeps } from '../../../../src/cli/handlers/effect.js';
import { reviewDigest } from '../../../../src/decision/review/validate.js';
import {
  containsRestrictedMaterial,
  memoryCheckpointSink,
  payloadDigest,
  type EffectVerifier,
} from '../../../../src/effects/index.js';

const vectors = JSON.parse(readFileSync(join(process.cwd(), 'test/fixtures/effects/vectors/identity.v1.json'), 'utf8'));

interface Env {
  root: string;
  project: string;
  artifacts: string;
  stores: Map<string, SecretStore>;
  deps: EffectCliDeps;
  clock: { now: number };
  outputs: string[];
  run(args: string[], extra?: Partial<EffectCliDeps>): Promise<{ exitCode: number; json: any; raw: string }>;
  ledgerDir(subsystem?: string): string;
}

function makeEnv(options: { tenant?: string; project?: string; detached?: boolean } = {}): Env {
  const root = mkdtempSync(join(tmpdir(), 'aiwg-effect-cli-'));
  const project = join(root, 'project');
  const artifacts = join(root, 'artifact-root');
  mkdirSync(join(project, '.aiwg'), { recursive: true });
  if (!options.detached) mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(project, '.aiwg-location'), `${artifacts}\n`);
  writeFileSync(join(project, '.aiwg', 'aiwg.config'), JSON.stringify({
    version: '1', providers: ['claude'], installed: {}, scripts: {},
    effects: { tenant: options.tenant ?? 'local', project: options.project ?? 'example/repo' },
  }, null, 2));
  execFileSync('git', ['init', '-q', project], { timeout: 20_000, stdio: 'ignore' });
  const stores = new Map<string, SecretStore>();
  const clock = { now: Date.parse('2026-09-25T10:00:00.000Z') };
  const deps: EffectCliDeps = {
    keyStore: (role, account) => {
      const key = `${role}:${account}`;
      if (!stores.has(key)) stores.set(key, new MemorySecretStore());
      return stores.get(key)!;
    },
    sink: memoryCheckpointSink(),
    clock: () => { clock.now += 1000; return clock.now; },
    lockTimeoutMs: 20_000,
  };
  const outputs: string[] = [];
  return {
    root, project, artifacts, stores, deps, clock, outputs,
    async run(args, extra = {}) {
      const handler = createEffectHandler({ ...deps, ...extra });
      const result = await handler.execute({ args, rawArgs: ['effect', ...args], cwd: project, frameworkRoot: process.cwd() });
      const raw = result.message ?? '';
      outputs.push(raw);
      let json: any = null;
      try { json = JSON.parse(raw); } catch { /* text format */ }
      return { exitCode: result.exitCode, json, raw };
    },
    ledgerDir: (subsystem = 'delivery') => join(artifacts, 'effects', subsystem),
  };
}

const files = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).flatMap(name => {
  const file = join(dir, name);
  return statSync(file).isDirectory() ? files(file) : [file];
}) : []);

let env: Env;
beforeEach(async () => {
  env = makeEnv();
  expect((await env.run(['keys', 'init'])).exitCode).toBe(0);
});
afterEach(() => rmSync(env.root, { recursive: true, force: true }));

function fileTarget(relative: string, contents: string): { target: string; digest: string } {
  const path = join(env.project, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
  const digest = payloadDigest(contents);
  return { target: `file:${relative}@${digest}`, digest };
}

const fileIdentity = (target: string) => ['--kind', 'file.digest', '--target', target, '--ctx', 'purpose=release-notes'];

describe('aiwg effect id', () => {
  it('EFF-CLI-01 prints exactly reviewDigest for a D13 review identity', async () => {
    const expected = reviewDigest({ reviewId: 'rev-42', continuationId: 'cont-7', proposalVersion: 3 });
    const json = await env.run(['id', '--review', 'rev-42', '--continuation', 'cont-7', '--proposal-version', '3']);
    expect(json.exitCode).toBe(0);
    expect(json.json).toMatchObject({ schema: 'aiwg.effect.id.v1', effectId: expected, idDerivation: 'd13.review/v1' });
    const text = await env.run(['id', '--review', 'rev-42', '--continuation', 'cont-7', '--proposal-version', '3', '--format', 'text']);
    expect(text.raw).toBe(expected);
  });

  it('EFF-CLI-02 matches every aiwg.effect/v1 identity vector', async () => {
    for (const vector of vectors.effectIds) {
      const scoped = makeEnv({ tenant: vector.input.scope.tenant, project: vector.input.scope.project });
      try {
        const result = await scoped.run(['id', '--subsystem', vector.input.scope.subsystem, '--kind', vector.input.kind,
          '--target', vector.input.target, '--context', JSON.stringify(vector.input.context), '--format', 'text']);
        expect(result.exitCode, vector.name).toBe(0);
        expect(result.raw, vector.name).toBe(vector.expected);
      } finally { rmSync(scoped.root, { recursive: true, force: true }); }
    }
  });

  it('EFF-CLI-03 builds tracker context from --issue --action --cycle', async () => {
    const vector = vectors.effectIds.find((entry: any) => entry.name === 'tracker-comment-cycle');
    const result = await env.run(['id', '--kind', 'tracker.comment', '--target', vector.input.target, '--issue', '12', '--action', 'cycle-comment', '--cycle', '1']);
    expect(result.json.effectId).toBe(vector.expected);
  });

  it('EFF-CLI-04 rejects usage errors with exit 2', async () => {
    for (const args of [
      ['id', '--kind', 'tracker.comment'],
      ['id', '--kind', 'not-a-kind', '--target', 'gitea:a/b#1'],
      ['id', '--kind', 'tracker.comment', '--target', 'gitea:a/b#1', '--bogus', 'x'],
      ['frobnicate'],
      ['lookup', 'eff1_NOT-VALID'],
      ['intent', '--kind', 'tracker.comment', '--target', 'gitea:a/b#1'],
    ]) {
      const result = await env.run(args);
      expect(result.exitCode, args.join(' ')).toBe(2);
      expect(result.json.schema).toBe('aiwg.effect.error.v1');
    }
  });
});

describe('aiwg effect record and lookup', () => {
  it('EFF-CLI-05 record is idempotent for the same digest and a conflict for another', async () => {
    const { target } = fileTarget('out/notes.md', 'release notes v1\n');
    const payload = ['--payload-digest', payloadDigest('the request that wrote the notes')];
    const first = await env.run(['record', ...fileIdentity(target), ...payload]);
    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({ schema: 'aiwg.effect.record.v1', status: 'completed', verified: true, idempotent: false });
    expect(first.json.verification).toMatchObject({ result: 'present', reason: 'digest-match' });
    const again = await env.run(['record', ...fileIdentity(target), ...payload]);
    expect(again.exitCode).toBe(0);
    expect(again.json).toMatchObject({ status: 'completed', idempotent: true, effectId: first.json.effectId });
    const conflict = await env.run(['record', ...fileIdentity(target), '--payload-digest', payloadDigest('another request')]);
    expect(conflict.exitCode).toBe(5);
    expect(conflict.json.error).toMatchObject({ code: 'conflict' });
  });

  it('EFF-CLI-06 lookup exits 3 for a missing ID, 4 for an intent only and 0 for a completed effect', async () => {
    const missing = await env.run(['lookup', ...fileIdentity('file:out/none.md@' + payloadDigest('x'))]);
    expect(missing.exitCode).toBe(3);
    expect(missing.json).toMatchObject({ schema: 'aiwg.effect.lookup.v1', found: false, status: 'none' });

    const intentOnly = ['--kind', 'tracker.comment', '--target', 'gitea:example/repo#9', '--issue', '9', '--action', 'cycle-comment', '--cycle', '1'];
    const intent = await env.run(['intent', ...intentOnly, '--payload-digest', payloadDigest('body')]);
    expect(intent.exitCode).toBe(0);
    const pending = await env.run(['lookup', ...intentOnly]);
    expect(pending.exitCode).toBe(4);
    expect(pending.json.status).toBe('intent');
    expect((await env.run(['lookup', intent.json.effectId])).exitCode).toBe(4);

    const { target } = fileTarget('out/done.md', 'done\n');
    const recorded = await env.run(['record', ...fileIdentity(target), '--payload-digest', payloadDigest('done')]);
    const done = await env.run(['lookup', recorded.json.effectId]);
    expect(done.exitCode).toBe(0);
    expect(done.json).toMatchObject({ status: 'completed', result: 'present' });
  });

  it('EFF-CLI-07 record --unverified writes the intent only, and a payload file is digested, never echoed', async () => {
    const body = join(env.root, 'comment.md');
    writeFileSync(body, 'CANARY comment body ghp_abcdefghijklmnop1234\n');
    const identity = ['--kind', 'tracker.comment', '--target', 'gitea:example/repo#3', '--issue', '3', '--action', 'close'];
    const result = await env.run(['record', ...identity, '--payload-file', body, '--unverified']);
    expect(result.exitCode).toBe(0);
    expect(result.json).toMatchObject({ status: 'intent', verified: false });
    expect(result.json.intent.payloadDigest).toBe(payloadDigest(readFileSync(body)));
    expect(result.raw).not.toContain('CANARY');
    expect((await env.run(['lookup', ...identity])).exitCode).toBe(4);
  });

  it('EFF-CLI-08 record without a verifier outcome exits 4 and keeps the reconcile history', async () => {
    const identity = ['--kind', 'tracker.pr.merged', '--target', 'gitea:example/repo#34'];
    const result = await env.run(['record', ...identity, '--payload-digest', payloadDigest('merge')]);
    expect(result.exitCode).toBe(4);
    expect(result.json).toMatchObject({ status: 'reconciled', verification: { result: 'unknown' } });
    const lookup = await env.run(['lookup', ...identity]);
    expect(lookup.json.records.map((record: any) => record.phase)).toEqual(['intent', 'reconciled']);
  });
});

describe('aiwg effect reconcile', () => {
  it('EFF-CLI-09 file.digest reconcile exits 0, 3 and 4 and appends a reconciled record each time', async () => {
    const present = fileTarget('out/present.md', 'present\n');
    const absentDigest = payloadDigest('never written');
    const cases: Array<{ target: string; exit: number; result: string }> = [
      { target: present.target, exit: 0, result: 'present' },
      { target: `file:out/absent.md@${absentDigest}`, exit: 3, result: 'absent' },
      { target: `file:../outside.md@${absentDigest}`, exit: 4, result: 'unknown' },
    ];
    for (const entry of cases) {
      const identity = fileIdentity(entry.target);
      const intent = await env.run(['intent', ...identity, '--payload-digest', payloadDigest(entry.target)]);
      expect(intent.exitCode).toBe(0);
      for (let attempt = 1; attempt <= 2; attempt++) {
        const reconciled = await env.run(['reconcile', intent.json.effectId]);
        expect(reconciled.exitCode, entry.target).toBe(entry.exit);
        expect(reconciled.json).toMatchObject({ schema: 'aiwg.effect.reconcile.v1', result: { verification: { result: entry.result } } });
        const lookup = await env.run(['lookup', ...identity]);
        expect(lookup.json.records.filter((record: any) => record.phase === 'reconciled')).toHaveLength(attempt);
      }
    }
  });

  it('EFF-CLI-10 reconcile of an unrecorded effect is a usage error', async () => {
    const result = await env.run(['reconcile', '--kind', 'tracker.pr.merged', '--target', 'gitea:example/repo#99']);
    expect(result.exitCode).toBe(2);
    expect(result.json.error.reason).toBe('intent-missing');
  });
});

describe('aiwg effect verify and checkpoint', () => {
  async function seed(): Promise<void> {
    for (const name of ['a', 'b', 'c']) {
      const { target } = fileTarget(`out/${name}.md`, `${name}\n`);
      expect((await env.run(['record', ...fileIdentity(target), '--payload-digest', payloadDigest(name)])).exitCode).toBe(0);
    }
  }
  const segment = () => join(env.ledgerDir(), 'segments', 'cli.jsonl');

  it('EFF-CLI-11 verify exits 0 on a clean ledger and after a checkpoint', async () => {
    await seed();
    const clean = await env.run(['verify']);
    expect(clean.exitCode).toBe(0);
    expect(clean.json).toMatchObject({ schema: 'aiwg.effect.verify.v1', ok: true });
    const checkpoint = await env.run(['checkpoint']);
    expect(checkpoint.exitCode).toBe(0);
    expect(checkpoint.json).toMatchObject({ schema: 'aiwg.effect.checkpoint.v1', sequence: 0, sink: { sink: 'memory' } });
    expect((await env.run(['verify'])).exitCode).toBe(0);
  });

  it('EFF-CLI-12 verify exits 6 after an edited byte', async () => {
    await seed();
    const lines = readFileSync(segment(), 'utf8').split('\n');
    const line = JSON.parse(lines[1]);
    const payload = Buffer.from(line.envelope.payload, 'base64').toString('utf8').replace('"completed"', '"reconciled"');
    line.envelope.payload = Buffer.from(payload, 'utf8').toString('base64');
    lines[1] = JSON.stringify(line);
    writeFileSync(segment(), lines.join('\n'));
    const result = await env.run(['verify']);
    expect(result.exitCode).toBe(6);
    expect(result.json.ok).toBe(false);
  });

  it('EFF-CLI-13 verify exits 6 after a truncation behind a checkpoint', async () => {
    await seed();
    expect((await env.run(['checkpoint'])).exitCode).toBe(0);
    const lines = readFileSync(segment(), 'utf8').trim().split('\n');
    writeFileSync(segment(), `${lines.slice(0, -2).join('\n')}\n`);
    const result = await env.run(['verify']);
    expect(result.exitCode).toBe(6);
  });

  it('EFF-CLI-14 verify exits 6 after a forged signature', async () => {
    await seed();
    const lines = readFileSync(segment(), 'utf8').split('\n');
    const line = JSON.parse(lines[0]);
    const sig = Buffer.from(line.envelope.signatures[0].sig, 'base64');
    sig[0] ^= 0xff;
    line.envelope.signatures[0].sig = sig.toString('base64');
    lines[0] = JSON.stringify(line);
    writeFileSync(segment(), lines.join('\n'));
    expect((await env.run(['verify'])).exitCode).toBe(6);
  });
});

describe('aiwg effect keys and kinds', () => {
  it('EFF-CLI-15 keys init provisions through the key store; list shows key IDs and public keys only', async () => {
    rmSync(env.root, { recursive: true, force: true });
    env = makeEnv();
    const empty = await env.run(['keys', 'list']);
    expect(empty.json).toMatchObject({ schema: 'aiwg.effect.keys.v1', initialized: false, keys: [] });
    const init = await env.run(['keys', 'init']);
    expect(init.exitCode).toBe(0);
    expect(init.json).toMatchObject({ provisioned: true, initialized: true });
    const again = await env.run(['keys', 'init']);
    expect(again.json).toMatchObject({ provisioned: false, keyid: init.json.keyid });
    const list = await env.run(['keys', 'list']);
    expect(list.exitCode).toBe(0);
    expect(list.json.keys).toHaveLength(1);
    expect(Object.keys(list.json.keys[0]).sort()).toEqual(['algorithm', 'keyid', 'publicKey', 'status', 'validFrom']);
    expect(list.json.keys[0].keyid).toBe(init.json.keyid);
    expect(list.json.keyProvider).toEqual({ type: 'injected', account: 'ledger/local/example/repo/delivery' });
  });

  it('EFF-CLI-16 keys rotate stages, rotates and promotes the successor; history still verifies', async () => {
    const { target } = fileTarget('out/r.md', 'r\n');
    const before = await env.run(['record', ...fileIdentity(target), '--payload-digest', payloadDigest('r')]);
    expect(before.exitCode).toBe(0);
    const rotated = await env.run(['keys', 'rotate', '--reason', 'custody-change']);
    expect(rotated.exitCode).toBe(0);
    expect(rotated.json.keys).toHaveLength(2);
    expect(rotated.json.activeKeyid).toBe(rotated.json.to);
    expect(rotated.json.rotations[0]).toMatchObject({ from: rotated.json.from, to: rotated.json.to, reason: 'custody-change' });
    expect(await env.stores.get('next:ledger/local/example/repo/delivery')!.loadSecret()).toBeNull();
    const after = fileTarget('out/s.md', 's\n');
    expect((await env.run(['record', ...fileIdentity(after.target), '--payload-digest', payloadDigest('s')])).exitCode).toBe(0);
    expect((await env.run(['verify'])).exitCode).toBe(0);
  });

  it('EFF-CLI-17 kinds lists whatever the verifier registry contains', async () => {
    const extension: EffectVerifier = {
      kind: 'x.example.notify', version: '2.1.0', canReportAbsent: false,
      async verify() { return { result: 'unknown', reason: 'network-error', complete: false }; },
    };
    const result = await env.run(['kinds'], { verifiers: [extension] });
    expect(result.exitCode).toBe(0);
    const kinds = result.json.kinds.map((entry: any) => entry.kind);
    expect(kinds).toEqual(expect.arrayContaining(['git.commit', 'git.tag', 'file.digest', 'decision.receipt', 'decision.review.continuation', 'x.aiwg.ledger-lock-recovery', 'x.example.notify']));
    expect(result.json.kinds.find((entry: any) => entry.kind === 'x.example.notify')).toEqual({ kind: 'x.example.notify', version: '2.1.0', canReportAbsent: false });
    expect(result.json.coreKinds).toContain('tracker.pr.merged');
  });
});

describe('aiwg effect artifact root', () => {
  it('EFF-CLI-18 every writing subcommand fails with exit 7 and writes nothing when the artifact root is unavailable', async () => {
    const detached = makeEnv({ detached: true });
    try {
      const identity = ['--kind', 'tracker.comment', '--target', 'gitea:example/repo#1', '--issue', '1'];
      const digest = ['--payload-digest', payloadDigest('x')];
      const id = (await detached.run(['id', ...identity])).json.effectId;
      for (const args of [
        ['intent', ...identity, ...digest],
        ['record', ...identity, ...digest],
        ['reconcile', id],
        ['checkpoint'],
        ['keys', 'init'],
        ['keys', 'rotate'],
        ['recover-lock', '--lock', 'writer-cli', '--authorize'],
        ['lookup', id],
        ['verify'],
      ]) {
        const result = await detached.run(args);
        expect(result.exitCode, args.join(' ')).toBe(7);
        expect(result.json.error).toMatchObject({ code: 'artifact-root-unavailable' });
      }
      expect(existsSync(detached.artifacts)).toBe(false);
      expect(readdirSync(join(detached.project, '.aiwg'))).toEqual(['aiwg.config']);
      for (const store of detached.stores.values()) expect(await store.loadSecret()).toBeNull();
    } finally { rmSync(detached.root, { recursive: true, force: true }); }
  });
});

describe('aiwg effect recover-lock', () => {
  const lockDir = (name: string) => join(env.ledgerDir(), 'locks', `${name}.lock`);
  function plantLock(name: string, owner: string, mtime?: Date): void {
    mkdirSync(lockDir(name), { recursive: true });
    writeFileSync(join(lockDir(name), 'owner'), `${owner}\n`, { mode: 0o600 });
    if (mtime) utimesSync(join(lockDir(name), 'owner'), mtime, mtime);
  }
  function deadPid(): number {
    const child = spawnSync(process.execPath, ['-e', ''], { timeout: 20_000 });
    return child.pid!;
  }
  const seed = async () => {
    const { target } = fileTarget('out/seed.md', 'seed\n');
    expect((await env.run(['record', ...fileIdentity(target), '--payload-digest', payloadDigest('seed')])).exitCode).toBe(0);
  };

  it('EFF-CLI-19 a stale writer lock blocks writes until an authorized recovery removes it and records it', async () => {
    await seed();
    plantLock('writer-cli', `${deadPid()}:${randomUUID()}`);
    const { target } = fileTarget('out/next.md', 'next\n');
    const blocked = await env.run(['record', ...fileIdentity(target), '--payload-digest', payloadDigest('next')], { lockTimeoutMs: 200 });
    expect(blocked.exitCode).toBe(1);
    expect(blocked.json.error.reason).toBe('lock-timeout');

    const inspect = await env.run(['recover-lock']);
    expect(inspect.json).toMatchObject({ schema: 'aiwg.effect.locks.v1', locks: [{ lock: 'writer-cli', state: 'dead', reason: 'owner-dead' }] });

    const unauthorized = await env.run(['recover-lock', '--lock', 'writer-cli']);
    expect(unauthorized.exitCode).toBe(2);
    expect(unauthorized.json.error.reason).toBe('authorization-required');
    expect(existsSync(lockDir('writer-cli'))).toBe(true);

    const recovered = await env.run(['recover-lock', '--lock', 'writer-cli', '--authorize']);
    expect(recovered.exitCode).toBe(0);
    expect(recovered.json).toMatchObject({ schema: 'aiwg.effect.lock-recovery.v1', outcome: 'recovered', verification: { result: 'present' } });
    expect(existsSync(lockDir('writer-cli'))).toBe(false);
    const lookup = await env.run(['lookup', recovered.json.effectId]);
    expect(lookup.exitCode).toBe(0);
    expect(lookup.json.kind).toBe('x.aiwg.ledger-lock-recovery');
    expect(recovered.raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);

    expect((await env.run(['record', ...fileIdentity(target), '--payload-digest', payloadDigest('next')])).exitCode).toBe(0);
    expect((await env.run(['verify'])).exitCode).toBe(0);
    expect((await env.run(['recover-lock', '--lock', 'writer-cli', '--authorize'])).exitCode).toBe(3);
  });

  it('EFF-CLI-20 refuses a live owner (5) and an unverifiable owner (4) and removes nothing', async () => {
    await seed();
    plantLock('checkpoint', `${process.pid}:${randomUUID()}`);
    const live = await env.run(['recover-lock', '--lock', 'checkpoint', '--authorize']);
    expect(live.exitCode).toBe(5);
    expect(live.json).toMatchObject({ outcome: 'refused', inspection: { state: 'live', reason: 'owner-live' } });
    expect(existsSync(lockDir('checkpoint'))).toBe(true);

    plantLock('keyring', 'not-a-lock-owner');
    const malformed = await env.run(['recover-lock', '--lock', 'keyring', '--authorize']);
    expect(malformed.exitCode).toBe(4);
    expect(malformed.json.inspection).toMatchObject({ state: 'unverifiable', reason: 'owner-malformed' });
    expect(existsSync(lockDir('keyring'))).toBe(true);

    expect((await env.run(['recover-lock', '--lock', '../escape', '--authorize'])).exitCode).toBe(2);
  });

  it.skipIf(process.platform !== 'linux')('EFF-CLI-21 refuses a PID reused by a process that started after the lock', async () => {
    await seed();
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      plantLock('writer-other', `${child.pid}:${randomUUID()}`, new Date(Date.now() - 3_600_000));
      const result = await env.run(['recover-lock', '--lock', 'writer-other', '--authorize']);
      expect(result.exitCode).toBe(5);
      expect(result.json.inspection).toMatchObject({ state: 'reused', reason: 'owner-pid-reused' });
      expect(existsSync(lockDir('writer-other'))).toBe(true);
    } finally { child.kill('SIGKILL'); }
  });
});

describe('aiwg effect output', () => {
  it('EFF-CLI-22 every JSON output parses, carries a schema, and contains no key material, tokens or vault locators', async () => {
    const { target } = fileTarget('out/canary.md', 'canary\n');
    const body = join(env.root, 'body.md');
    writeFileSync(body, 'CANARY token ghp_abcdefghijklmnop1234 vault://kv/ledger\n');
    await env.run(['keys', 'init']);
    await env.run(['id', ...fileIdentity(target)]);
    await env.run(['intent', '--kind', 'tracker.comment', '--target', 'gitea:example/repo#5', '--issue', '5', '--payload-file', body]);
    const recorded = await env.run(['record', ...fileIdentity(target), '--payload-file', body]);
    await env.run(['lookup', recorded.json.effectId]);
    await env.run(['reconcile', recorded.json.effectId]);
    await env.run(['checkpoint']);
    await env.run(['verify']);
    await env.run(['kinds']);
    await env.run(['keys', 'list']);
    await env.run(['keys', 'rotate']);
    await env.run(['recover-lock']);
    await env.run(['record', '--kind', 'tracker.comment', '--target', 'gitea:example/repo#5', '--issue', '5', '--context', '{"note":"ghp_abcdefghijklmnop1234"}', '--payload-file', body]);
    await env.run(['frobnicate']);

    const secrets: string[] = [];
    for (const store of env.stores.values()) {
      const secret = await store.loadSecret();
      if (!secret) continue;
      const key = createPrivateKey({ key: Buffer.from(secret, 'base64'), format: 'der', type: 'pkcs8' });
      const der = key.export({ format: 'der', type: 'pkcs8' }) as Buffer;
      secrets.push(secret, der.toString('hex'), der.subarray(-32).toString('hex'), key.export({ format: 'pem', type: 'pkcs8' }).toString());
    }
    expect(secrets.length).toBeGreaterThan(0);
    expect(env.outputs.length).toBeGreaterThan(10);
    for (const raw of env.outputs) {
      const json = JSON.parse(raw);
      expect(typeof json.schema, raw.slice(0, 80)).toBe('string');
      expect(typeof json.exitCode).toBe('number');
      for (const secret of secrets) expect(raw).not.toContain(secret);
      expect(raw).not.toMatch(/PRIVATE KEY|MC4CAQAwBQYDK2Vw|vault:\/\/|CANARY/);
      expect(containsRestrictedMaterial(raw)).toBe(false);
    }
    for (const file of files(env.artifacts)) expect(readFileSync(file, 'utf8')).not.toMatch(/CANARY|ghp_|PRIVATE KEY/);
  });

  it('EFF-CLI-23 help lists every subcommand and exit code', async () => {
    const help = await createEffectHandler().help!({ args: [], rawArgs: ['effect'], cwd: env.project, frameworkRoot: process.cwd() });
    for (const sub of EFFECT_SUBCOMMANDS) expect(help.message).toContain(`aiwg effect ${sub}`);
    expect(help.message).toBe(effectUsage());
  });
});
