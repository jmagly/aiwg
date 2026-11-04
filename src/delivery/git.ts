// Run delivery git operations with explicit identity, signing, transport and a bounded child environment.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import type { AiwgConfig, DeliveryConfig } from '../config/aiwg-config.js';
import { helperEnvironment, HELPER_ENV_ALLOWLIST } from '../process/cli-command.mjs';

const execute = promisify(execFile);
export async function command(cwd: string, executable: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execute(executable, args, { cwd, encoding: 'utf8', timeout: 120_000, maxBuffer: 8 * 1024 * 1024,
      env: helperEnvironment(process.env, [...HELPER_ENV_ALLOWLIST, 'SSH_AUTH_SOCK', 'GNUPGHOME', 'GPG_TTY']) });
    return stdout.trim();
  } catch { throw new Error(`Delivery ${path.basename(executable)} operation failed; inspect repository state before retrying`); }
}
export const git = (cwd: string, ...args: string[]) => command(cwd, 'git', args);

export function signingEnabled(delivery?: DeliveryConfig): boolean {
  const required = delivery?.require_signed_commits || delivery?.merge === 'local-signed';
  const signing = delivery?.signing;
  if (required && !signing?.key) throw new Error('Signed delivery requires delivery.signing.key');
  return Boolean(required || (signing?.enforce !== 'tags' && (signing?.key || signing?.key_file)));
}

export function commitOptions(delivery?: DeliveryConfig, project = process.cwd()): string[] {
  const options: string[] = [];
  for (const [key, value] of [['user.name', delivery?.committer?.name], ['user.email', delivery?.committer?.email]]) {
    if (value) options.push('-c', `${key}=${value}`);
  }
  if (signingEnabled(delivery)) {
    const signing = delivery!.signing!;
    if (!signing.key || !delivery?.committer?.name || !delivery.committer.email) throw new Error('Signed delivery requires signing.key and committer.name/email');
    const format = signing.format ?? 'openpgp';
    options.push('-c', `gpg.format=${format}`, '-c', `user.signingkey=${signing.key_file ? path.resolve(project, signing.key_file) : signing.key}`, '-c', 'commit.gpgsign=true');
    if (signing.program) options.push('-c', `gpg.${format}.program=${/[\\/]/.test(signing.program) ? path.resolve(project, signing.program) : signing.program}`);
  } else options.push('-c', 'commit.gpgsign=false');
  return options;
}

export async function verifyCommit(cwd: string, sha: string, delivery?: DeliveryConfig, project = cwd): Promise<void> {
  if (!signingEnabled(delivery)) return;
  const result = await git(cwd, ...commitOptions(delivery, project), 'show', '-s', '--format=%G?%x00%GF%x00%GP%x00%an%x00%ae%x00%cn%x00%ce', sha);
  const [status, key, primaryKey, author, email, committer, committerEmail] = result.split('\0');
  const identity = delivery!.committer!;
  if (!['G', 'U'].includes(status) || ![key, primaryKey].includes(delivery!.signing!.key!) || author !== identity.name || email !== identity.email || committer !== identity.name || committerEmail !== identity.email) {
    throw new Error('Commit does not satisfy configured signature and author/committer identity');
  }
}

export async function push(cwd: string, project: string, config: AiwgConfig, remote: string, refspec: string, upstream = false): Promise<void> {
  const helper = config.remotes?.transport?.helper;
  // Helper follows the established helper contract: push options/refspec, configured primary remote owned by helper.
  if (helper) await command(cwd, path.resolve(project, helper), [...(upstream ? ['-u'] : []), refspec]);
  else await git(cwd, 'push', ...(upstream ? ['-u'] : []), remote, refspec);
}
