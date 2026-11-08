// Produce a hardening baseline and operator-only remediation plan from safe metadata.
import { readFileSync } from 'node:fs';
import { checkCompose, checkDockerRun } from './bindings.mjs';

const controls = [
  ['ssh.passwordAuthentication', 'no', 'Disable password authentication after access gates', '/etc/ssh/sshd_config'],
  ['ssh.permitRootLogin', 'no', 'Disable root login after access gates', '/etc/ssh/sshd_config'],
  ['ssh.maxAuthTries', 3, 'Limit MaxAuthTries to at most 3', '/etc/ssh/sshd_config'],
  ['ssh.caTrustReviewed', true, 'Review TrustedUserCAKeys and principals without collecting key material', '/etc/ssh/sshd_config'],
  ['ssh.authorizedKeysFromRestricted', true, 'Constrain authorized_keys with from=; operator supplies boolean only', 'authorized_keys (operator-owned)'],
  ['firewall.defaultDeny4', true, 'Default-deny IPv4 inbound', 'IPv4 firewall rules'],
  ['firewall.defaultDeny6', true, 'Default-deny IPv6 inbound', 'IPv6 firewall rules'],
  ['firewall.persistent', true, 'Verify persisted rules and boot loading', 'firewall persistence configuration'],
  ['docker.userGuard', true, 'Review ordered DOCKER-USER ingress guard', 'Docker firewall rules'],
  ['docker.afterVpn', true, 'Order Docker after VPN readiness, including restart behavior', 'Docker service drop-in'],
  ['docker.liveRestore', true, 'Enable Docker live-restore where supported', '/etc/docker/daemon.json'],
  ['docker.explicitBinds', true, 'Specify private/VPN bind addresses in rendered Compose and docker run', 'compose.yaml'],
  ['datastores.authAcl', true, 'Require datastore authentication and least-privilege ACLs', 'datastore configuration'],
  ['datastores.redisDangerousCommandsRestricted', true, 'Deny dangerous Redis commands through ACLs; review version-specific alternatives', 'Redis ACL configuration'],
  ['datastores.postgresConnectionLogging', true, 'Enable PostgreSQL connection logging', 'PostgreSQL configuration'],
  ['datastores.appRolesNotSuperuser', true, 'Remove superuser from application roles after dependency review', 'PostgreSQL role definitions'],
  ['exporters.privateBind', true, 'Bind exporters to private/VPN interfaces', 'exporter configuration'],
  ['exporters.fixedTargets', true, 'Disable caller-chosen multi-target exporter scrapes', 'exporter configuration'],
  ['audit.rulesLoaded', true, 'Review auditd rules against sensitive file and authentication events', 'auditd rules'],
  ['audit.retentionReviewed', true, 'Review audit/log retention capacity and remote preservation', 'auditd and journal retention configuration'],
];
const valueAt = (data, path) => path.split('.').reduce((value, part) => value?.[part], data);
try {
  const args = process.argv.slice(2);
  if (args.some(arg => ['--apply', '--authorized'].includes(arg))) throw new Error('read-only skill: operator must execute separately reviewed changes; apply is unavailable');
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--snapshot', '--compose', '--docker-run'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: check.mjs --snapshot safe.json [--compose compose.yaml] [--docker-run commands.txt]');
    options[args[i]] = args[i + 1];
  }
  if (!options['--snapshot']) throw new Error('--snapshot is required');
  const data = JSON.parse(readFileSync(options['--snapshot'], 'utf8'));
  if (!data.host || !Number.isFinite(Date.parse(data.capturedAt))) throw new Error('host and ISO capturedAt required');
  const checks = controls.map(([id, expected, recommendation, file]) => {
    const actual = valueAt(data.baseline, id);
    const known = typeof actual === typeof expected;
    const pass = id === 'ssh.maxAuthTries' ? Number.isInteger(actual) && actual > 0 && actual <= expected : actual === expected;
    return { id, status: !known ? 'UNKNOWN' : pass ? 'PASS' : 'FAIL', recommendation, file };
  });
  const findings = [];
  if (options['--compose']) findings.push(...checkCompose(readFileSync(options['--compose'], 'utf8')).map(finding => ({ ...finding, file: options['--compose'] })));
  if (options['--docker-run']) findings.push(...checkDockerRun(readFileSync(options['--docker-run'], 'utf8')).map(finding => ({ ...finding, file: options['--docker-run'] })));
  const changes = checks.filter(check => check.status === 'FAIL');
  const diff = changes.map(check => {
    const names = { 'ssh.passwordAuthentication': 'PasswordAuthentication', 'ssh.permitRootLogin': 'PermitRootLogin', 'ssh.maxAuthTries': 'MaxAuthTries' };
    const name = names[check.id];
    return name ? `--- ${check.file}\n-${name} ${valueAt(data.baseline, check.id)}\n+${name} ${controls.find(control => control[0] === check.id)[1]}`
      : `--- ${check.file}\n- control ${check.id}: failed\n+ recommendation: ${check.recommendation}`;
  }).concat(findings.map(finding => `--- ${finding.file} (${finding.location})\n- ${finding.code}: current publish requires review\n+ use operator-reviewed private/VPN bind; retain required service reachability`)).join('\n');
  const datedSuffix = new Date(data.capturedAt).toISOString().replace('.000', '').replaceAll(':', '-');
  const backups = [...new Set([...changes.map(check => check.file), ...findings.map(finding => finding.file)])].map(file => ({ action: 'operator-backup', file, datedSuffix,
    verify: 'Record SHA-256 before change, restrict access, verify restore procedure; never copy secrets into the report' }));
  const failed = changes.length + findings.length;
  const unknown = checks.filter(check => check.status === 'UNKNOWN').length;
  const report = { host: data.host, capturedAt: data.capturedAt, mode: 'read-only', checks, findings,
    plan: { backups, diff, ruleReview: 'Review exposure-analysis stale and over-broad rules; map each removal to owner and named service before preparing exact diffs',
      gates: ['explicit operator authorization', 'verified key-based access', 'verified console break-glass access'],
      safety: ['HIGH blast radius for network/auth changes', 'Test sshd effective Match contexts and syntax before reload',
        'Keep current SSH session and timed rollback; validate second key session before retiring old access',
        'Operator takes dated backups before any separately authorized application; this skill never applies'],
      reverify: ['listeners', 'IPv4 firewall', 'IPv6 firewall', 'Docker forwarding and binds', 'new key-based SSH session', ...(data.healthChecks ?? [])],
      execution: 'Operator applies outside this read-only skill, then supplies fresh captures and named health results for a new report; no apply is performed or claimed' },
    summary: { status: failed ? 'FAIL' : unknown ? 'UNKNOWN' : 'PASS', passed: checks.filter(check => check.status === 'PASS').length, failed, unknown } };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = failed ? 2 : unknown ? 3 : 0;
} catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
