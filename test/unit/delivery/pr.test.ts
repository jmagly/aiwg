import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LiveIssueClient } from '../../../src/issues/live.js';
import { main as issues } from '../../../src/issues/cli.js';
import { runSkill } from '../../../src/skills/run.js';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { main as delivery, mergePr, openPr } from '../../../src/delivery/pr.js';
import { trackerToken } from '../../../src/issues/tracker-policy.js';
import { stewardSignedMerges } from '../../../src/cli/handlers/steward-signing.js';
import { readAiwgConfig, resolveDelivery } from '../../../src/config/aiwg-config.js';
import { fakeTracker } from '../../fixtures/delivery/tracker.js';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const token = 'synthetic-tracker-token-3862';
const identity = { name: 'Fixture Operator', email: 'fixture@example.invalid' };
let root: string;
let cwd: string;
let tracker: Awaited<ReturnType<typeof fakeTracker>>;
let config: any;
let client: LiveIssueClient;
let env: NodeJS.ProcessEnv;
const git = (...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10_000 }).trim();
const save = () => writeFileSync(path.join(cwd, '.aiwg/aiwg.config'), JSON.stringify(config));
function commit(name = 'change') { writeFileSync(path.join(cwd, name), name); git('add', name); git('commit', '-m', name); return git('rev-parse', 'HEAD'); }
function signed() {
  const keyFile = path.join(root, 'fixture-signing-key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyFile], { env, stdio: 'pipe', timeout: 10_000 });
  const publicKey = readFileSync(`${keyFile}.pub`, 'utf8').trim();
  const fingerprint = execFileSync('ssh-keygen', ['-lf', `${keyFile}.pub`], { env, encoding: 'utf8', timeout: 10_000 }).split(' ')[1];
  const allowed = path.join(root, 'allowed-signers'); writeFileSync(allowed, `${identity.email} ${publicKey}\n`);
  git('config', 'gpg.format', 'ssh'); git('config', 'gpg.ssh.allowedSignersFile', allowed);
  git('config', 'user.signingkey', keyFile); git('config', 'commit.gpgsign', 'true');
  config.delivery = { ...config.delivery, merge: 'local-signed', require_signed_commits: true, signing: { format: 'ssh', key: fingerprint, key_file: keyFile } };
}

beforeEach(async () => {
  root = mkdtempSync(path.join(os.tmpdir(), 'aiwg-delivery-'));
  cwd = path.join(root, 'project'); mkdirSync(cwd); mkdirSync(path.join(cwd, '.aiwg'));
  env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'empty-gitconfig') };
  writeFileSync(env.GIT_CONFIG_GLOBAL!, '');
  vi.stubEnv('HOME', root); vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1'); vi.stubEnv('GIT_CONFIG_GLOBAL', env.GIT_CONFIG_GLOBAL!);
  vi.stubEnv('PROJECT_TRACKER_TOKEN', token);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  git('init', '--initial-branch=main'); git('config', 'user.name', identity.name); git('config', 'user.email', identity.email);
  git('init', '--bare', '--initial-branch=main', path.join(root, 'origin.git'));
  git('remote', 'add', 'origin', path.join(root, 'origin.git'));
  commit('baseline'); git('push', '-u', 'origin', 'main');
  git('switch', '-c', 'feature');
  const helper = path.join(cwd, 'push-helper');
  writeFileSync(helper, `#!${process.execPath}\n${readFileSync(path.join(repoRoot, 'test/fixtures/delivery/push.cjs'), 'utf8')}`, { mode: 0o755 });
  tracker = await fakeTracker();
  config = { version: '1.0', remotes: { primary: 'origin', issue_tracker: 'origin', issue_provider: 'gitea', transport: { helper: 'push-helper' },
    tracker_actor: { login: 'operator', forbid_actors: ['forbidden'], credential: { env: 'PROJECT_TRACKER_TOKEN' } } }, delivery: { mode: 'pr-required', merge: 'local', committer: identity } };
  save();
  client = new LiveIssueClient({ provider: 'gitea', repo: 'acme/project', apiUrl: tracker.url, token, actor: config.remotes.tracker_actor });
});
afterEach(async () => { await tracker?.close(); rmSync(root, { recursive: true, force: true }); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function assertLocalMerge(result: any, signedExpected: boolean) {
  expect(result).toMatchObject({ signed: signedExpected });
  expect(git('rev-parse', 'origin/main')).toBe(result.merged);
  expect(git('rev-parse', `${result.merged}^{tree}`)).toBe(git('rev-parse', `${tracker.state.head}^{tree}`));
  expect(git('show', '-s', '--format=%P', result.merged).split(' ')).toHaveLength(2);
  expect(tracker.state.prState).toBe('closed');
  expect(git('worktree', 'list', '--porcelain')).not.toContain('aiwg-merge-');
  expect(tracker.calls.some(call => call.path.endsWith('/merge'))).toBe(false);
  expect(readFileSync(path.join(cwd, 'push-log'), 'utf8')).not.toContain(token);
}

it('opens and locally merges unsigned projects through the helper without signature requirements', async () => {
  tracker.state.head = commit();
  await openPr(cwd, config, client, { title: 'Change', body: 'Verified' });
  const result = await mergePr(cwd, config, client, '1');
  assertLocalMerge(result, false);
  expect(git('show', '-s', '--format=%G?', (result as any).merged)).toBe('N');
  expect(tracker.calls.find(call => call.path.endsWith('/pulls') && call.method === 'POST')?.body).toEqual({ title: 'Change', body: 'Verified', head: 'feature', base: 'main' });
});

it('creates a signed staged commit and signed no-ff merge, verifying configured key and both identities', async () => {
  signed();
  writeFileSync(path.join(cwd, 'feature-file'), 'feature'); git('add', 'feature-file');
  const message = path.join(root, 'message'); writeFileSync(message, 'feat: fixture');
  await openPr(cwd, config, client, { title: 'Signed', commitMessageFile: message });
  tracker.state.head = git('rev-parse', 'HEAD');
  const result = await mergePr(cwd, config, client, '1');
  assertLocalMerge(result, true);
  expect(git('show', '-s', '--format=%GF', (result as any).merged)).toBe(config.delivery.signing.key);
  expect(git('show', '-s', '--format=%an <%ae> %cn <%ce>', (result as any).merged)).toBe(`${identity.name} <${identity.email}> ${identity.name} <${identity.email}>`);
});

it.each(['unsigned', 'wrong-key', 'wrong-author', 'wrong-committer'])('rejects %s branch commits before push or close', async mode => {
  signed();
  if (mode === 'unsigned') git('config', 'commit.gpgsign', 'false');
  if (mode === 'wrong-author') { env.GIT_AUTHOR_NAME = 'Other'; env.GIT_AUTHOR_EMAIL = 'other@example.invalid'; }
  if (mode === 'wrong-committer') { env.GIT_COMMITTER_NAME = 'Other'; env.GIT_COMMITTER_EMAIL = 'other@example.invalid'; }
  tracker.state.head = commit(); git('push', 'origin', 'feature');
  if (mode === 'wrong-key') config.delivery.signing.key = 'SHA256:wrong';
  await expect(mergePr(cwd, config, client, '1')).rejects.toThrow(/signature and author\/committer/);
  expect(tracker.state.prState).toBe('open');
  expect(tracker.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});

it.each(['closed', 'stale', 'wrong-base'])('rejects a %s PR without closing it', async mode => {
  tracker.state.head = commit(); git('push', 'origin', 'feature');
  if (mode === 'closed') tracker.state.prState = 'closed';
  if (mode === 'wrong-base') tracker.state.base = 'other';
  if (mode === 'stale') { git('switch', 'main'); commit('new-main'); git('push', 'origin', 'main'); }
  await expect(mergePr(cwd, config, client, '1')).rejects.toThrow(/not open|branch base|default branch/);
  expect(tracker.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
});

it('keeps tracker merge as the config-off default and supports GitHub and Gitea request shapes', async () => {
  expect(resolveDelivery(undefined).merge).toBe('tracker');
  delete config.delivery.merge; tracker.state.head = commit();
  await mergePr(cwd, config, client, '1');
  expect(tracker.calls.at(-1)).toMatchObject({ method: 'POST', body: { Do: 'rebase-merge', head_commit_id: tracker.state.head } });
  const github = new LiveIssueClient({ provider: 'github', repo: 'acme/project', apiUrl: tracker.url, token, actor: config.remotes.tracker_actor });
  await mergePr(cwd, config, github, '1');
  expect(tracker.calls.at(-1)).toMatchObject({ method: 'PUT', body: { merge_method: 'rebase', sha: tracker.state.head } });
});

it('refuses tracker merges when commit signing is configured', async () => {
  signed(); config.delivery.merge = 'tracker';
  await expect(mergePr(cwd, config, client, '1')).rejects.toThrow(/local merge route/);
  expect(tracker.calls).toHaveLength(0);
});

it('pushes an explicitly requested configured mirror after verifying origin', async () => {
  tracker.state.head = commit(); git('push', 'origin', 'feature');
  git('init', '--bare', path.join(root, 'mirror.git')); git('remote', 'add', 'mirror', path.join(root, 'mirror.git'));
  config.remotes.secondary = [{ name: 'mirror', purpose: 'mirror' }];
  const result: any = await mergePr(cwd, config, client, '1', { mirror: 'mirror' });
  expect(git('ls-remote', 'mirror', 'refs/heads/main').split(/\s/)[0]).toBe(result.merged);
});

it.each(['mismatch', 'forbidden'])('refuses %s tracker actors before PR and issue writes', async mode => {
  tracker.state.login = mode === 'mismatch' ? 'someone' : 'forbidden';
  tracker.state.head = commit();
  await expect(openPr(cwd, config, client, { title: 'Change' })).rejects.toThrow(/match|forbidden/);
  await expect(issues(['comment', '1', '--body', 'x', '--repo', 'acme/project', '--api-url', tracker.url], cwd)).rejects.toThrow(/match|forbidden/);
  expect(tracker.calls.every(call => call.method === 'GET')).toBe(true);
});

it('uses the configured actor credential for issues create/comment/close and PR CLI, redacting reflected errors and results', async () => {
  await issues(['create', '--title', 'Fixture issue', '--body', 'ordinary fixture', '--label', 'bug', '--repo', 'acme/project', '--api-url', tracker.url], cwd);
  await issues(['comment', '1', '--body', 'comment', '--repo', 'acme/project', '--api-url', tracker.url], cwd);
  await issues(['close', '1', '--repo', 'acme/project', '--api-url', tracker.url], cwd);
  tracker.state.head = commit(); delete config.delivery.merge; save();
  await delivery(['merge', '1', '--repo', 'acme/project', '--api-url', tracker.url], cwd);
  expect(tracker.calls.every(call => call.authorization === `Bearer ${token}`)).toBe(true);
  expect(tracker.calls.find(call => call.path.endsWith('/issues') && call.method === 'POST')?.body.labels).toEqual([2]);
  for (let i = 0; i < tracker.calls.length; i++) if (tracker.calls[i].method !== 'GET') expect(tracker.calls[i - 1].path).toBe('/user');
  tracker.state.reflect = true;
  expect(JSON.stringify(await client.repositoryRequest('POST', '/issues', { title: 'x' }))).not.toContain(token);
  tracker.state.reject = true;
  await expect(client.repositoryRequest('GET', '/issues')).rejects.toThrow('[REDACTED]');
  expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(token);
});

it('reuses sensitive-input store/env references and refuses token overrides', async () => {
  const readStore = vi.fn(async () => token);
  expect(await trackerToken('gitea', { credential: { store: 'fixture' } }, {}, { readStore })).toBe(token);
  expect(readStore).toHaveBeenCalledWith('fixture');
  expect(await trackerToken('gitea', config.remotes.tracker_actor)).toBe(token);
  await expect(trackerToken('gitea', config.remotes.tracker_actor, { env: 'OTHER' })).rejects.toThrow('cannot be overridden');
});

it('offers a preview, skips without writing, then applies optional signed merge configuration through Steward', async () => {
  const before = readFileSync(path.join(cwd, '.aiwg/aiwg.config'), 'utf8');
  await stewardSignedMerges([], cwd);
  await stewardSignedMerges(['--skip'], cwd);
  const args = ['--key', 'fixture-fingerprint', '--name', identity.name, '--email', identity.email];
  await stewardSignedMerges(args, cwd);
  expect(readFileSync(path.join(cwd, '.aiwg/aiwg.config'), 'utf8')).toBe(before);
  await stewardSignedMerges([...args, '--apply'], cwd);
  expect((await readAiwgConfig(cwd))?.delivery).toMatchObject({ merge: 'local-signed', require_signed_commits: true, signing: { key: 'fixture-fingerprint' }, committer: identity });
});

it.each([{ credential: { env: 'BAD-NAME' } }, { credential: { store: 'a', env: 'B' } }, { credential: { token: 'literal' } }])('rejects invalid actor references when loading config: %j', async actor => {
  config.remotes.tracker_actor = actor; save();
  await expect(readAiwgConfig(cwd)).rejects.toThrow('exactly one store or env reference');
});

it.each(['env', 'store'])('keeps synthetic tokens out of child argv/env and NODE_DEBUG logs during a complete CLI open using %s', async source => {
  tracker.state.head = commit();
  if (source === 'store') {
    const bin = path.join(root, 'bin'); mkdirSync(bin);
    writeFileSync(path.join(bin, 'secret-tool'), `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(token)});`, { mode: 0o755 });
    env.PATH = `${bin}${path.delimiter}${env.PATH}`;
    config.remotes.tracker_actor.credential = { store: 'synthetic-tracker' };
  }
  save();
  const runner = path.join(root, 'run.mjs');
  const moduleUrl = pathToFileURL(path.join(repoRoot, 'dist/src/delivery/pr.js')).href;
  writeFileSync(runner, `import {main} from ${JSON.stringify(moduleUrl)}; await main(['open','--title','Fixture','--repo','acme/project','--api-url',${JSON.stringify(tracker.url)}]);`);
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [runner], { cwd, env: { ...env, PROJECT_TRACKER_TOKEN: token, DUPLICATE_VALUE: token, NODE_DEBUG: 'child_process' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk);
    child.on('error', reject); child.on('close', code => resolve({ code, output }));
  });
  expect(result.code, result.output).toBe(0);
  expect(result.output).not.toContain(token);
  const log = readFileSync(path.join(cwd, 'push-log'), 'utf8'); expect(log).not.toContain(token);
  expect(tracker.calls.at(-1)?.authorization).toBe(`Bearer ${token}`);
});


it('runs the indexed aiwg-pr entrypoint through the native delivery owner', async () => {
  const skillPath = 'agentic/code/addons/aiwg-utils/skills/aiwg-pr/SKILL.md';
  const entry = { path: skillPath, name: 'aiwg-pr', type: 'skill', phase: 'meta', title: 'AIWG PR', tags: [],
    created: '', updated: '', checksum: 'a', summary: '', dependencies: [], dependents: [],
    script: { entrypoint: 'scripts/deliver.mjs', runtime: 'node', cwd: 'project-root' } };
  const index = path.join(cwd, '.aiwg/.index/project'); mkdirSync(index, { recursive: true });
  writeFileSync(path.join(index, 'metadata.json'), JSON.stringify({ version: '1.0', builtAt: '', buildTimeMs: 1, entries: { [skillPath]: entry } }));
  vi.stubEnv('AIWG_ROOT', repoRoot);
  delete config.delivery.merge; save(); tracker.state.head = commit();
  expect(await runSkill({ cwd, name: 'aiwg-pr', args: ['merge', '1', '--repo', 'acme/project', '--api-url', tracker.url] })).toBe(0);
  expect(tracker.calls.at(-1)?.path).toBe('/repos/acme/project/pulls/1/merge');
});

it.each(['head', 'main'])('refuses a concurrently changed %s and removes its temporary worktree', async changed => {
  tracker.state.head = commit(); git('push', 'origin', 'feature');
  let reads = 0;
  tracker.state.onRead = async () => {
    if (++reads !== 2) return;
    if (changed === 'head') tracker.state.head = 'a'.repeat(40);
    else { git('switch', 'main'); commit('concurrent'); git('push', 'origin', 'main'); }
  };
  await expect(mergePr(cwd, config, client, '1')).rejects.toThrow(/changed during merge/);
  expect(tracker.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  expect(git('worktree', 'list', '--porcelain')).not.toContain('aiwg-merge-');
});

it('rejects a merge whose tree a local hook changes', async () => {
  tracker.state.head = commit(); git('push', 'origin', 'feature');
  const hook = path.join(cwd, '.git/hooks/post-merge');
  const marker = path.join(cwd, '.git/hooks/hook-ran');
  writeFileSync(hook, `#!${process.execPath}\n${readFileSync(path.join(repoRoot, 'test/fixtures/delivery/change-merge-tree.cjs'), 'utf8')}`, { mode: 0o755 });
  git('config', 'core.hooksPath', path.dirname(hook));
  const result = await mergePr(cwd, config, client, '1').catch(error => error);
  expect(readFileSync(marker, 'utf8')).toBe('changed');
  expect(result).toBeInstanceOf(Error);
  expect(result.message).toContain('Merge tree differs');
  expect(tracker.calls.filter(call => call.method !== 'GET')).toHaveLength(0);
  expect(git('worktree', 'list', '--porcelain')).not.toContain('aiwg-merge-');
});

it('loads unsigned config and rejects incomplete signed merge config and unknown merge routes', async () => {
  delete config.delivery.merge; delete config.delivery.committer; save();
  expect((await readAiwgConfig(cwd))?.delivery?.require_signed_commits).toBeUndefined();
  config.delivery.merge = 'local-signed'; save();
  await expect(readAiwgConfig(cwd)).rejects.toThrow('requires signing.key');
  config.delivery.merge = 'unknown'; save();
  await expect(readAiwgConfig(cwd)).rejects.toThrow('must be local-signed, local, or tracker');
});

it('compiles delivery and tracker config schemas strictly and accepts only store/env credential references and known merge modes', () => {
  const schema = JSON.parse(readFileSync(path.join(repoRoot, 'vscode-extension/schemas/aiwg.config.v1.json'), 'utf8'));
  const validate = addFormats(new Ajv({ strict: true, allErrors: true })).compile({
    type: 'object', properties: { delivery: schema.properties.delivery, remotes: schema.properties.remotes },
    definitions: Object.fromEntries(['TrackerActor', 'RemoteTransport', 'SecondaryRemote', 'CommitterIdentity', 'SigningConfig'].map(key => [key, schema.definitions[key]])),
  });
  for (const merge of ['local', 'local-signed', 'tracker']) {
    expect(validate({ delivery: { merge }, remotes: { tracker_actor: { credential: { store: 'fixture' } } } }), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ delivery: { merge }, remotes: { tracker_actor: { credential: { env: 'PROJECT_TOKEN' } } } })).toBe(true);
  }
  expect(validate({ delivery: { merge: 'other' } })).toBe(false);
  for (const credential of [{}, { token: 'literal' }, { env: 'BAD-NAME' }, { store: 'fixture', env: 'PROJECT_TOKEN' }]) {
    expect(validate({ remotes: { tracker_actor: { credential } } })).toBe(false);
  }
});


it('accepts empty successful tracker merge responses and refuses an explicit merged=false', async () => {
  delete config.delivery.merge; tracker.state.head = commit();
  const fetchFn = vi.fn(async (url: string) => {
    if (url.endsWith('/merge')) return new Response(null, { status: 204 });
    return fetch(url);
  });
  const empty = new LiveIssueClient({ provider: 'gitea', repo: 'acme/project', apiUrl: tracker.url, token, actor: config.remotes.tracker_actor, fetchFn: fetchFn as typeof fetch });
  expect(await mergePr(cwd, config, empty, '1')).toEqual({});
  fetchFn.mockImplementation(async (url: string) => url.endsWith('/merge') ? new Response(JSON.stringify({ merged: false })) : fetch(url));
  await expect(mergePr(cwd, config, empty, '1')).rejects.toThrow('Tracker refused');
});
