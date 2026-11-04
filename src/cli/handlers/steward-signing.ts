// Offer optional signed local merges with a reviewable preview and an explicit config-only apply.
import { readAiwgConfig, writeAiwgConfig, type SigningFormat } from '../../config/aiwg-config.js';

export async function stewardSignedMerges(args: string[], cwd: string): Promise<void> {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    if (['--apply', '--skip', '--help'].includes(args[i])) continue;
    if (!['--key', '--key-file', '--name', '--email', '--format', '--program'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Invalid signed-merges option');
    values.set(args[i], args[++i]);
  }
  if (args.includes('--skip')) { console.log('Signed merge setup skipped; project configuration preserved.'); return; }
  const config = await readAiwgConfig(cwd);
  if (!config) throw new Error('Signed merge setup requires .aiwg/aiwg.config');
  const existing = config.delivery;
  const key = values.get('--key') ?? existing?.signing?.key;
  const name = values.get('--name') ?? existing?.committer?.name;
  const email = values.get('--email') ?? existing?.committer?.email;
  const format = values.get('--format') ?? existing?.signing?.format ?? 'openpgp';
  if (!['openpgp', 'ssh', 'x509'].includes(format)) throw new Error('Signing format must be openpgp, ssh, or x509');
  if (args.includes('--help') || !key || !name || !email) {
    console.log('Recommended, optional: set up signed merges using an existing signing key and permitted repository policy. Skip when signing is unavailable or unwanted.\naiwg steward signed-merges --key <fingerprint> --name <committer> --email <email> [--format openpgp|ssh|x509] [--key-file <path>] [--program <path>]\nReview the preview, then add --apply to save. Use --skip to preserve unsigned delivery. SSH signing uses --key SHA256:... for verification and --key-file for the signing key path. This step creates no keys and changes no repository policies.');
    if (args.includes('--apply')) throw new Error('Applying signed merges requires key, name, and email');
    return;
  }
  const delivery = { ...existing, merge: 'local-signed' as const, require_signed_commits: true,
    committer: { name, email }, signing: { ...existing?.signing, key, format: format as SigningFormat, enforce: 'commits' as const,
      ...(values.has('--key-file') ? { key_file: values.get('--key-file') } : {}),
      ...(values.has('--program') ? { program: values.get('--program') } : {}) } };
  console.log(JSON.stringify({ delivery }, null, 2));
  if (args.includes('--apply')) { await writeAiwgConfig(cwd, { ...config, delivery }); console.log('Signed local merge configuration saved.'); }
  else console.log('Preview only. Add --apply to save, or --skip to keep current delivery.');
}
