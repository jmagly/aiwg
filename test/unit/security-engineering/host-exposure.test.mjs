// Exercise offline host exposure and hardening skills with sanitized captures.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const fixtures = resolve('test/fixtures/host-exposure');
const exposure = resolve('agentic/code/frameworks/forensics-complete/skills/exposure-analysis/scripts/analyze.mjs');
const hardening = resolve('agentic/code/frameworks/security-engineering/skills/host-hardening/scripts/check.mjs');
const dirs = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function capture() {
  const read = name => readFileSync(join(fixtures, name), 'utf8');
  return {
    host: 'fixture-cache', capturedAt: '2026-11-01T00:00:00Z', ingressInterface: 'eth0',
    vpnAddresses: ['10.8.0.2'], cdnRanges: ['192.0.2.0/24'],
    ss: read('ss.txt'), iptables4: read('iptables-save.txt'),
    iptables6: read('ip6tables-save.txt'), ufw: read('ufw.txt'), docker: read('docker.json'),
  };
}
function run(script, snapshot, extra = []) {
  const dir = mkdtempSync(join(tmpdir(), 'aiwg-exposure-'));
  dirs.push(dir);
  const input = join(dir, 'snapshot.json');
  writeFileSync(input, JSON.stringify(snapshot));
  const result = spawnSync(process.execPath, [script, '--snapshot', input, ...extra], {
    cwd: dir, encoding: 'utf8', timeout: 20_000,
  });
  return { ...result, dir, report: result.stdout.trim() ? JSON.parse(result.stdout) : undefined };
}
const codes = report => report.findings.map(finding => finding.code);

describe('exposure reconstruction', () => {
  it('traces Docker reachability despite a UFW deny and hashes captures', () => {
    const result = run(exposure, capture());
    expect(result.status, result.stderr).toBe(2);
    expect(result.report.exposures).toContainEqual(expect.objectContaining({
      port: 6379, family: 4, verdict: 'internet-reachable via Docker',
      path: expect.arrayContaining(['nat/PREROUTING', 'nat/DOCKER', 'filter/FORWARD', 'filter/DOCKER-USER', 'filter/DOCKER']),
    }));
    expect(codes(result.report)).toEqual(expect.arrayContaining(['docker-ufw-bypass', 'empty-docker-user', 'missing-bind']));
    expect(result.report.evidence.ss.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.report.capturedAt).toBe('2026-11-01T00:00:00Z');
    expect(readdirSync(result.dir)).toEqual(['snapshot.json']);
  });
  it('correlates rules with listeners, CDN scope, shadowing and IPv6', () => {
    const { report } = run(exposure, capture());
    expect(codes(report)).toEqual(expect.arrayContaining(['stale-rule', 'over-broad-cdn', 'shadowed-rule', 'v4-v6-asymmetry']));
    expect(report.findings).toContainEqual(expect.objectContaining({ code: 'stale-rule', port: 5432 }));
    expect(report.rules.some(rule => rule.family === 6)).toBe(true);
    expect(report.listeners.map(listener => listener.scope)).toEqual(expect.arrayContaining(['loopback', 'vpn', 'all-interfaces']));
  });
  it('honors a DOCKER-USER drop before Docker accept', () => {
    const data = capture();
    data.iptables4 = data.iptables4.replace('-A FORWARD', '-A DOCKER-USER -p tcp --dport 6379 -j DROP\n-A FORWARD');
    const { report } = run(exposure, data);
    expect(report.exposures.find(entry => entry.port === 6379).verdict).toBe('blocked on captured host path');
    expect(codes(report)).not.toContain('docker-ufw-bypass');
  });
  it.each(['-A FORWARD -m mystery --unknown yes -j ACCEPT', '-A FORWARD -j MISSING'])('reports unknown rather than proving reachability for %s', rule => {
    const data = capture();
    data.iptables4 = data.iptables4.replace('-A FORWARD -j DOCKER-USER', rule + '\n-A FORWARD -j DOCKER-USER');
    expect(run(exposure, data).report.exposures[0].verdict).toBe('unknown');
  });
  it('requires actual DNAT evidence and never treats missing IPv6 as closed', () => {
    const data = capture();
    data.iptables4 = data.iptables4.replace('-A DOCKER -p tcp --dport 6379 -j DNAT --to-destination 172.18.0.2:6379', '');
    delete data.iptables6;
    const { report } = run(exposure, data);
    expect(report.exposures[0].verdict).toBe('unknown');
    expect(codes(report)).toContain('missing-ipv6-evidence');
  });
  it('maps direct host listeners to INPUT policy and reports unmatched rule evidence', () => {
    const { report } = run(exposure, capture());
    expect(report.hostExposures).toContainEqual(expect.objectContaining({ port: 22, family: 6, verdict: 'accepted on captured host path' }));
    expect(report.rules.find(rule => rule.port === '5432').listenerMatches).toEqual([]);
  });
  it('stops on changed evidence when collection hashes are supplied', () => {
    const data = capture();
    data.hashes = { ss: '0'.repeat(64) };
    const result = run(exposure, data);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/integrity mismatch.*ss/i);
  });
  it('traces IPv6 Docker publishing and does not assume an INPUT deny protects it', () => {
    const data = capture();
    data.iptables6 = data.iptables4.replaceAll('172.18.0.2', '2001:db8:2::2').replaceAll('/32', '/128')
      .replace('--to-destination 2001:db8:2::2:6379', '--to-destination [2001:db8:2::2]:6379');
    const docker = JSON.parse(data.docker);
    docker[0].NetworkSettings.Ports['6379/tcp'][0].HostIp = '::';
    docker[0].NetworkSettings.Networks.bridge.GlobalIPv6Address = '2001:db8:2::2';
    data.docker = JSON.stringify(docker);
    expect(run(exposure, data).report.exposures).toContainEqual(expect.objectContaining({ family: 6, verdict: 'internet-reachable via Docker' }));
  });
  it('fails conservatively for native nftables or earlier raw hooks', () => {
    const data = capture();
    data.nftables = 'table inet filter { }';
    expect(run(exposure, data).report.exposures[0].verdict).toBe('unknown');
    delete data.nftables;
    data.iptables4 = '*raw\n:PREROUTING ACCEPT [0:0]\nCOMMIT\n' + data.iptables4;
    expect(run(exposure, data).report.exposures[0].verdict).toBe('unknown');
  });
  it.each(['192.0.2.80', '2001:db8:1234::80'])('rejects closed proof from allowlisted probe %s', source => {
    const data = capture();
    data.iptables6 = data.iptables6.replace('COMMIT\n*filter', 'COMMIT\n*filter')
      .replace(':INPUT ACCEPT [0:0]', ':INPUT DROP [0:0]\n-A INPUT -s 2001:db8:1234::/48 -j ACCEPT');
    data.external = [{ source, port: 6379, protocol: 'tcp', result: 'closed' }];
    const verification = run(exposure, data).report.external[0];
    expect(verification.provesClosed).toBe(false);
    expect(verification.reason).toMatch(/allowlist/i);
  });
  it('does not report PASS when an allowlisted probe is the only external evidence', () => {
    const data = capture();
    data.external = [{ source: '192.0.2.80', port: 6379, protocol: 'tcp', result: 'closed' }];
    expect(codes(run(exposure, data).report)).toContain('allowlisted-vantage');
  });
  it('does not generalize a clean external closed result beyond its vantage', () => {
    const data = capture();
    data.external = [{ source: '198.51.100.80', port: 6379, protocol: 'tcp', result: 'closed' }];
    const verification = run(exposure, data).report.external[0];
    expect(verification.provesClosed).toBe(false);
    expect(verification.reason).toMatch(/vantage/i);
  });
});

describe('read-only hardening', () => {
  it('flags short and long compose publishes without binds and preserves explicit IPv6 binds', () => {
    const result = run(hardening, capture(), ['--compose', join(fixtures, 'compose.yaml')]);
    expect(result.status, result.stderr).toBe(2);
    expect(result.report.findings.filter(finding => finding.code === 'missing-bind')).toHaveLength(2);
    expect(result.report.plan.backups).toContainEqual(expect.objectContaining({ file: join(fixtures, 'compose.yaml') }));
    expect(result.report.plan.diff).toContain('operator-reviewed private/VPN bind');
    expect(readdirSync(result.dir)).toEqual(['snapshot.json']);
  });
  it('produces dated backup and diff plans with SSH gates and named rechecks', () => {
    const data = capture();
    data.baseline = { ssh: { passwordAuthentication: 'yes', permitRootLogin: 'yes', maxAuthTries: 6 } };
    data.healthChecks = ['queue-ready', 'metrics-targets-up'];
    const { report } = run(hardening, data);
    expect(report.mode).toBe('read-only');
    expect(report.plan.backups).toContainEqual(expect.objectContaining({ action: 'operator-backup', datedSuffix: '2026-11-01T00-00-00Z' }));
    expect(report.plan.diff).toContain('-PasswordAuthentication yes');
    expect(report.plan.diff).toContain('+PasswordAuthentication no');
    expect(report.plan.gates).toEqual(expect.arrayContaining(['explicit operator authorization', 'verified key-based access', 'verified console break-glass access']));
    expect(report.plan.reverify).toEqual(expect.arrayContaining(['listeners', 'IPv4 firewall', 'IPv6 firewall', 'queue-ready', 'metrics-targets-up']));
    expect(report.summary.status).toBe('FAIL');
    expect(report.checks.some(check => check.status === 'UNKNOWN')).toBe(true);
  });
  it('flags docker run publish variants and wildcard binds without reading the host', () => {
    const dir = mkdtempSync(join(tmpdir(), 'aiwg-publish-'));
    dirs.push(dir);
    const commands = join(dir, 'commands.txt');
    writeFileSync(commands, ['docker run -p 6379:6379 cache', 'docker run --publish=9121:9121 exporter',
      'docker run -p127.0.0.1:6380:6379 cache', 'docker run -p "[::1]:6381:6379" cache', 'docker run -P cache',
      'docker run -p 0.0.0.0:80:80 web'].join('\n'));
    const { report } = run(hardening, capture(), ['--docker-run', commands]);
    expect(report.findings.filter(finding => finding.code === 'missing-bind')).toHaveLength(3);
    expect(report.findings.filter(finding => finding.code === 'wildcard-bind')).toHaveLength(1);
  });
  it('never passes a missing baseline and never creates backup files', () => {
    const result = run(hardening, capture());
    expect(result.report.summary.status).toBe('UNKNOWN');
    expect(result.status).toBe(3);
    expect(result.report.plan.backups).toEqual([]);
    expect(readdirSync(result.dir)).toEqual(['snapshot.json']);
  });
  it('rejects apply even with authorization and writes nothing', () => {
    const result = run(hardening, capture(), ['--apply', '--authorized']);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/read-only.*operator/i);
    expect(readdirSync(result.dir)).toEqual(['snapshot.json']);
  });
});

// Required rules must accompany plugin skills outside the source checkout.
it.each([
  'agentic/code/plugins/security-engineering/rules/published-port-binding.md',
  'agentic/code/plugins/forensics/rules/evidence-integrity.md',
  'agentic/code/plugins/forensics/rules/non-destructive.md',
])('packages required rule %s', path => {
  expect(readFileSync(resolve(path), 'utf8')).toMatch(/Enforcement Level/);
});
