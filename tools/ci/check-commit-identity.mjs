#!/usr/bin/env node
// Enforce WORKSPACE.md commit identity policy on only the commits added by a push.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'Joseph Magly';
const EMAIL = '1159087+jmagly@users.noreply.github.com';
const KEY = '25BEE160811F66FD6F7B1BF0454C68C4A2174CE9';
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const ZERO = /^0+$/;
const POLICY = 'See WORKSPACE.md "Commit identity and attribution". Use a signed local --no-ff merge via the configured local merge helper (aiwg run skill aiwg-pr -- merge <number>), then push through tools/git/push-origin-as-roctinam.sh.';

/** git is injectable so policy and graph handling can be tested without signing keys. */
export function checkPush({ before, after }, git) {
  if (!SHA.test(after ?? '') || (before && !SHA.test(before))) {
    throw new Error('Push before/after must be full push commit SHAs.');
  }
  if (ZERO.test(after)) return { commits: [], violations: [] };

  let base = before;
  if (!base || ZERO.test(base)) {
    // A new branch must not recheck pre-policy history. Keep side-branch
    // commits in the range when the pushed head is itself a merge.
    const parents = git(['rev-list', '--parents', '-n', '1', after, '--']).trim().split(/\s+/);
    if (parents[0] !== after || parents.slice(1).some(parent => !SHA.test(parent))) {
      throw new Error('Cannot resolve the pushed head and its first parent.');
    }
    base = parents[1];
  }
  // A nonzero but missing before is an error, never an excuse to narrow the range.
  const range = base ? `${base}..${after}` : after;
  const shas = git(['rev-list', '--reverse', range, '--']).trim().split(/\s+/).filter(Boolean);
  const commits = shas.map(sha => {
    if (!SHA.test(sha)) throw new Error('Invalid commit SHA returned by git rev-list.');
    const fields = git(['show', '-s', '--no-show-signature',
      '--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%G?%x00%GF%x00%GP%x00%B', sha, '--']).split('\0');
    if (fields.length !== 9 || fields[0] !== sha) throw new Error(`Cannot read commit metadata for ${sha}.`);
    const [, authorName, authorEmail, committerName, committerEmail, signature, fingerprint, primary, body] = fields;
    const problems = [];
    if (authorName !== NAME || authorEmail !== EMAIL || committerName !== NAME || committerEmail !== EMAIL) {
      problems.push('incorrect author or committer identity');
    }
    // Match the push helper: U is cryptographically valid without ownertrust;
    // an approved primary key may sign through one of its signing subkeys.
    if (!['G', 'U'].includes(signature) || (fingerprint !== KEY && primary !== KEY)) {
      problems.push('signature must be valid and from the approved key');
    }
    if (/^co-authored-by:|^generated with \[?(?:claude|codex)/im.test(body)) problems.push('attribution line');
    return { sha, authorName, authorEmail, committerName, committerEmail, signature, fingerprint, primary, problems };
  });
  return { commits, violations: commits.filter(commit => commit.problems.length > 0) };
}

export function formatReport({ commits, violations }) {
  if (!violations.length) return `Commit identity check passed: ${commits.length} commit(s) checked.`;
  return [
    `FAIL: ${violations.length} of ${commits.length} pushed commit(s) break the commit policy.`,
    ...violations.map(commit => [
      `  ${commit.sha}: ${commit.problems.join('; ')}`,
      `    author: ${commit.authorName} <${commit.authorEmail}>`,
      `    committer: ${commit.committerName} <${commit.committerEmail}>`,
      `    signature: ${commit.signature || 'unavailable'}; fingerprint: ${commit.fingerprint || 'none'}; primary: ${commit.primary || 'none'}`,
    ].join('\n')),
    POLICY,
  ].join('\n');
}

/** Import only the shipped public keyring; never use a runner's personal GPG home. */
export function runCheck({ before, after, cwd = process.cwd() }) {
  const home = mkdtempSync(join(tmpdir(), 'aiwg-commit-identity-'));
  const env = { ...process.env, GNUPGHOME: home, GIT_NO_REPLACE_OBJECTS: '1' };
  try {
    writeFileSync(join(home, 'gpg.conf'), 'no-auto-key-retrieve\nno-auto-key-import\n');
    execFileSync('gpg', ['--no-options', '--batch', '--no-tty', '--no-autostart', '--import', resolve(cwd, '.gitea/keys/maintainers.asc')], {
      cwd, env, encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'],
    });
    const git = args => execFileSync('git', [
      '-c', 'gpg.format=openpgp', '-c', 'gpg.program=gpg', '-c', 'gpg.openpgp.program=gpg', ...args,
    ], { cwd, env, encoding: 'utf8', timeout: 15_000, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
    return checkPush({ before, after }, git);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const result = runCheck({ before: process.env.AIWG_PUSH_BEFORE, after: process.env.AIWG_PUSH_AFTER });
    const report = formatReport(result);
    if (result.violations.length) { console.error(report); process.exitCode = 1; }
    else console.log(report);
  } catch (error) {
    console.error(`FAIL: Commit identity check could not complete: ${error.message}\n${POLICY}`);
    process.exitCode = 1;
  }
}
