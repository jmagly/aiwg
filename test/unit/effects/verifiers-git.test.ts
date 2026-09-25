/**
 * Offline `git.commit` and `git.tag` verifier matrix over temporary
 * repositories (#2718). Signatures use a throwaway SSH key; the user's global
 * git configuration is isolated for the whole file.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createBuiltinVerifierRegistry,
  gitCommitVerifier,
  gitTagVerifier,
  runVerifier,
  type EffectVerifier,
  type EffectVerifierExpectation,
  type VerifierRun,
} from '../../../src/effects/index.js';
import { scope } from './helpers.js';

const TIMEOUT_MS = 20_000;
const EFFECT_ID = `eff1_${'a'.repeat(51)}q`;
const ISOLATED = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const saved: Record<string, string | undefined> = {};
let root: string;
let repo: string;
let signedCommit: string;
let unsignedCommit: string;
let otherCommit: string;

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], {
  encoding: 'utf8', timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ...ISOLATED, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' },
}).trim();

function commit(dir: string, message: string, sign = false): string {
  writeFileSync(join(dir, 'file.txt'), `${message}\n`);
  git(dir, 'add', 'file.txt');
  git(dir, '-c', `commit.gpgsign=${sign}`, 'commit', '-q', ...(sign ? ['-S'] : []), '-m', message);
  return git(dir, 'rev-parse', 'HEAD');
}

const request = (target: string, expected: EffectVerifierExpectation = {}, context: Record<string, string | number | boolean> = {}) => ({
  effectId: EFFECT_ID, scope, kind: target.startsWith('git-tag:') ? 'git.tag' : 'git.commit', target, context,
  payloadDigest: `sha256:${'0'.repeat(64)}`, intentRecordedAt: '2026-09-24T10:00:00.000Z', expected,
});

const run = (verifier: EffectVerifier, target: string, expected?: EffectVerifierExpectation, context?: Record<string, string | number | boolean>): Promise<VerifierRun> =>
  runVerifier(verifier, request(target, expected, context), { timeoutMs: TIMEOUT_MS });

beforeAll(() => {
  for (const [key, value] of Object.entries(ISOLATED)) { saved[key] = process.env[key]; process.env[key] = value; }
  root = mkdtempSync(join(tmpdir(), 'aiwg-effect-git-'));
  repo = join(root, 'repo');
  execFileSync('git', ['init', '-q', repo], { timeout: TIMEOUT_MS, env: { ...process.env, ...ISOLATED } });
  const key = join(root, 'signing-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'test', '-f', key], { timeout: TIMEOUT_MS });
  writeFileSync(join(root, 'allowed_signers'), `test@example.com namespaces="git" ${readFileSync(`${key}.pub`, 'utf8').trim()}\n`);
  git(repo, 'config', 'gpg.format', 'ssh');
  git(repo, 'config', 'user.signingkey', `${key}.pub`);
  git(repo, 'config', 'gpg.ssh.allowedSignersFile', join(root, 'allowed_signers'));
  unsignedCommit = commit(repo, `unsigned change\n\nEffect-Id: ${EFFECT_ID}`);
  signedCommit = commit(repo, 'signed change', true);
  otherCommit = commit(repo, 'third change');
  git(repo, 'tag', 'light', unsignedCommit);
  git(repo, '-c', 'tag.gpgsign=false', 'tag', '-a', '-m', 'annotated', 'annotated', unsignedCommit);
  git(repo, 'tag', '-s', '-m', 'signed', 'signed', signedCommit);
}, 60_000);

afterAll(() => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  rmSync(root, { recursive: true, force: true });
});

describe('git.commit', () => {
  it('EFF-VER-GIT-01 an existing commit is present; an Effect-Id trailer is an exact marker match', async () => {
    const verifier = gitCommitVerifier({ repoDir: repo });
    expect((await run(verifier, `git:${signedCommit}`)).observation).toMatchObject({ result: 'present', reason: 'state-match', complete: true });
    const marked = await run(verifier, `git:${unsignedCommit}`);
    expect(marked.observation).toMatchObject({ result: 'present', reason: 'marker-match' });
    expect(marked.evidence).toMatchObject({ object: unsignedCommit, marker: true, signature: 'unchecked' });
    expect(marked.observation.evidenceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('EFF-VER-GIT-02 a commit missing from a complete repository is absent; from a shallow clone it is unknown', async () => {
    const missing = `git:${'d'.repeat(40)}`;
    expect((await run(gitCommitVerifier({ repoDir: repo }), missing)).observation).toMatchObject({ result: 'absent', reason: 'complete-query-no-match', complete: true });
    const shallow = join(root, 'shallow');
    execFileSync('git', ['clone', '-q', '--depth', '1', `file://${repo}`, shallow], { timeout: TIMEOUT_MS, env: { ...process.env, ...ISOLATED } });
    const verifier = gitCommitVerifier({ repoDir: shallow });
    expect((await run(verifier, `git:${otherCommit}`)).observation).toMatchObject({ result: 'present' });
    expect((await run(verifier, `git:${unsignedCommit}`)).observation).toMatchObject({ result: 'unknown', reason: 'paging-incomplete' });
  });

  it('EFF-VER-GIT-03 a missing repository or a failing git binary is unknown, never absent', async () => {
    const target = `git:${'d'.repeat(40)}`;
    expect((await run(gitCommitVerifier({ repoDir: join(root, 'no-such-repo') }), target)).observation).toMatchObject({ result: 'unknown', reason: 'container-unreadable' });
    expect((await run(gitCommitVerifier({ repoDir: repo, gitBinary: join(root, 'no-such-git') }), target)).observation).toMatchObject({ result: 'unknown', reason: 'container-unreadable' });
    const failing = join(root, 'failing-git');
    writeFileSync(failing, '#!/bin/sh\nexit 1\n');
    chmodSync(failing, 0o755);
    expect((await run(gitCommitVerifier({ repoDir: repo, gitBinary: failing }), target)).observation).toMatchObject({ result: 'unknown', reason: 'container-unreadable' });
    expect((await run(gitCommitVerifier({ repoDir: repo }), 'git:HEAD')).observation).toMatchObject({ result: 'unknown', reason: 'malformed-response' });
  });

  it('EFF-VER-GIT-04 a required signature: good is present; unsigned or unverifiable is never present', async () => {
    const verifier = gitCommitVerifier({ repoDir: repo });
    const good = await run(verifier, `git:${signedCommit}`, { signed: true });
    expect(good.observation).toMatchObject({ result: 'present', reason: 'state-match' });
    expect(good.evidence).toMatchObject({ signature: 'good', signatureRequired: true });
    const unsigned = await run(verifier, `git:${unsignedCommit}`, { signed: true });
    expect(unsigned.observation).toMatchObject({ result: 'unknown', reason: 'evidence-conflict' });
    expect(unsigned.evidence).toMatchObject({ signature: 'unsigned' });
    expect((await run(verifier, `git:${unsignedCommit}`, {}, { signed: true })).observation).toMatchObject({ result: 'unknown', reason: 'evidence-conflict' });
    const noTrust = join(root, 'no-trust');
    execFileSync('git', ['clone', '-q', `file://${repo}`, noTrust], { timeout: TIMEOUT_MS, env: { ...process.env, ...ISOLATED } });
    const unverifiable = await run(gitCommitVerifier({ repoDir: noTrust }), `git:${signedCommit}`, { signed: true });
    expect(unverifiable.observation).toMatchObject({ result: 'unknown', reason: 'container-unreadable' });
    expect(unverifiable.evidence).toMatchObject({ signature: 'unverifiable' });
  });
});

describe('git.tag', () => {
  it('EFF-VER-GIT-05 lightweight and annotated tags are present and a missing tag is absent', async () => {
    const verifier = gitTagVerifier({ repoDir: repo });
    expect((await run(verifier, 'git-tag:light', { object: unsignedCommit })).observation).toMatchObject({ result: 'present', reason: 'state-match' });
    const annotated = await run(verifier, 'git-tag:annotated', { object: unsignedCommit });
    expect(annotated.observation).toMatchObject({ result: 'present' });
    expect(annotated.evidence).toMatchObject({ annotated: true, object: unsignedCommit });
    expect((await run(verifier, 'git-tag:v9.9.9')).observation).toMatchObject({ result: 'absent', reason: 'complete-query-no-match', complete: true });
  });

  it('EFF-VER-GIT-06 a tag that points at the wrong object is unknown/evidence-conflict, never absent', async () => {
    const verifier = gitTagVerifier({ repoDir: repo });
    const wrong = await run(verifier, 'git-tag:light', { object: otherCommit });
    expect(wrong.observation).toMatchObject({ result: 'unknown', reason: 'evidence-conflict' });
    expect(wrong.evidence).toMatchObject({ object: unsignedCommit, expectedObject: otherCommit });
    expect((await run(verifier, 'git-tag:light', {}, { object: otherCommit })).observation).toMatchObject({ reason: 'evidence-conflict' });
  });

  it('EFF-VER-GIT-07 tag signature status: signed is present, unsigned and lightweight are never present', async () => {
    const verifier = gitTagVerifier({ repoDir: repo });
    const signed = await run(verifier, 'git-tag:signed', { signed: true, object: signedCommit });
    expect(signed.observation).toMatchObject({ result: 'present' });
    expect(signed.evidence).toMatchObject({ signature: 'good' });
    for (const tag of ['annotated', 'light']) {
      const result = await run(verifier, `git-tag:${tag}`, { signed: true });
      expect(result.observation, tag).toMatchObject({ result: 'unknown', reason: 'evidence-conflict' });
      expect(result.evidence, tag).toMatchObject({ signature: 'unsigned' });
    }
  });

  it('EFF-VER-GIT-08 a missing repository, a failing binary and a malformed tag name are unknown', async () => {
    expect((await run(gitTagVerifier({ repoDir: join(root, 'no-such-repo') }), 'git-tag:light')).observation).toMatchObject({ result: 'unknown', reason: 'container-unreadable' });
    expect((await run(gitTagVerifier({ repoDir: repo, gitBinary: join(root, 'no-such-git') }), 'git-tag:light')).observation).toMatchObject({ result: 'unknown' });
    for (const name of ['-n', '../x', 'a..b', 'x.lock', 'bad name']) {
      expect((await run(gitTagVerifier({ repoDir: repo }), `git-tag:${name}`)).observation, name).toMatchObject({ result: 'unknown', reason: 'malformed-response' });
    }
  });

  it('EFF-VER-GIT-09 the built-in registry wires both git kinds to the configured repository', async () => {
    const registry = createBuiltinVerifierRegistry({ git: { repoDir: repo } });
    expect((await run(registry.get('git.commit')!, `git:${otherCommit}`)).observation.result).toBe('present');
    expect((await run(registry.get('git.tag')!, 'git-tag:signed', { signed: true })).observation.result).toBe('present');
    const unconfigured = createBuiltinVerifierRegistry();
    expect((await run(unconfigured.get('git.commit')!, `git:${otherCommit}`)).observation).toMatchObject({ result: 'unknown', reason: 'container-unreadable' });
  });
});
