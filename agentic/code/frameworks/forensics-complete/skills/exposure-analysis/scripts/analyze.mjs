// Reconstruct exposure from operator-supplied sanitized captures without host access.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isIP } from 'node:net';
import { inRange, scope, parseFirewall, trace, listeners } from './firewall.mjs';

export function analyze(data) {
  if (!data.host || !Number.isFinite(Date.parse(data.capturedAt))) throw new Error('host and ISO capturedAt are required');
  const findings = [];
  const add = (code, detail, extra = {}) => findings.push({ code, detail, ...extra });
  const evidence = {};
  for (const key of ['ss', 'docker', 'iptables4', 'iptables6', 'ufw', 'nftables', 'firewalld']) {
    if (typeof data[key] === 'string') {
      const sha256 = createHash('sha256').update(data[key]).digest('hex');
      if (data.hashes?.[key] && data.hashes[key] !== sha256) throw new Error(`Integrity mismatch for ${key}`);
      evidence[key] = { sha256, verification: data.hashes?.[key] ? 'matched supplied collection hash' : 'collection hash not supplied' };
    }
  }
  const sockets = listeners(data.ss, data.vpnAddresses ?? []);
  const firewalls = { 4: parseFirewall(data.iptables4, 4), 6: parseFirewall(data.iptables6, 6) };
  const rules = Object.values(firewalls).flatMap(firewall => firewall.rules);
  for (const [key, code] of [['ss', 'missing-listener-evidence'], ['docker', 'missing-docker-evidence'],
    ['iptables4', 'missing-ipv4-evidence'], ['iptables6', 'missing-ipv6-evidence']]) {
    if (!data[key]) add(code, `${key} unavailable; absence is not proof of closure`);
  }
  if (data.nftables || data.firewalld) add('manual-backend-review', 'Native nftables/firewalld order and hook priorities need manual correlation; automated verdicts are unknown');
  const containers = JSON.parse(data.docker ?? '[]');
  const exposures = [];
  for (const container of containers) {
    for (const [containerPort, bindings] of Object.entries(container.NetworkSettings?.Ports ?? {})) {
      if (!bindings) continue;
      const [targetPort, protocol] = containerPort.split('/');
      for (const binding of bindings) {
        const address = binding.HostIp ?? '';
        const family = isIP(address) || 4;
        const port = Number(binding.HostPort);
        const firewall = firewalls[family];
        const bindScope = scope(address, data.vpnAddresses ?? []);
        const requested = container.HostConfig?.PortBindings?.[containerPort] ?? [];
        if (!address || requested.some(entry => !entry.HostIp)) add('missing-bind', 'Publish omitted a bind address', { port, family });
        const guard = firewall.tables.filter?.['DOCKER-USER'];
        if (!guard || guard.rules.every(rule => rule.target === 'RETURN')) add('empty-docker-user', 'DOCKER-USER has no effective guard', { family, port });
        const packet = { port, protocol, source: '*', destination: scope(address) === 'all-interfaces' ? '*' : address, input: data.ingressInterface };
        const nat = trace(firewall, 'nat', 'PREROUTING', packet);
        const translated = nat.rule?.dnat?.match(/^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/);
        const destination = translated?.[1] ?? translated?.[2];
        const networkAddresses = Object.values(container.NetworkSettings?.Networks ?? {}).flatMap(network => [network.IPAddress, network.GlobalIPv6Address]);
        const forward = trace(firewall, 'filter', 'FORWARD', { ...packet, destination, port: Number(translated?.[3]) });
        let verdict = 'unknown';
        const unsupported = data.nftables || data.firewalld || Object.keys(firewall.tables).some(table => !['filter', 'nat'].includes(table));
        if (!unsupported && nat.verdict === 'DNAT' && Number(translated?.[3]) === Number(targetPort) && networkAddresses.includes(destination)) {
          if (['DROP', 'REJECT'].includes(forward.verdict)) verdict = 'blocked on captured host path';
          if (forward.verdict === 'ACCEPT' && ['all-interfaces', 'public'].includes(bindScope)) verdict = 'internet-reachable via Docker';
          if (forward.verdict === 'ACCEPT' && ['private', 'vpn', 'loopback'].includes(bindScope)) verdict = 'restricted bind; routing requires review';
        }
        const entry = { container: container.Name, port, protocol, address, family, scope: bindScope,
          verdict, path: [...nat.path, ...forward.path], limitation: 'Captured host path only; upstream routing and cloud controls unverified' };
        exposures.push(entry);
        const input = trace(firewall, 'filter', 'INPUT', packet);
        const ufwDeny = (data.ufw ?? '').split('\n').some(line => new RegExp(`^${port}(?:/${protocol})?\\s+DENY`).test(line));
        if (verdict === 'internet-reachable via Docker' && (ufwDeny || ['DROP', 'REJECT'].includes(input.verdict))) {
          add('docker-ufw-bypass', 'UFW/INPUT deny is bypassed by Docker DNAT and FORWARD', { port, family });
        }
      }
    }
  }
  for (const rule of rules) {
    if (rule.target === 'ACCEPT' && rule.port && /^\d+$/.test(rule.port) && rule.chain === 'INPUT' && data.ss) {
      const active = sockets.some(socket => (socket.family === rule.family || socket.family === 0) && socket.port === Number(rule.port)
        && (!rule.protocol || socket.protocol === rule.protocol));
      const published = exposures.some(entry => entry.family === rule.family && entry.port === Number(rule.port));
      if (!active && !published) add('stale-rule', 'No captured listener or publish; validate standby/activation before removal', { port: Number(rule.port), family: rule.family, rule: rule.raw });
    }
    if (rule.target === 'ACCEPT' && rule.source && !rule.port && !rule.unknown) {
      if ((data.cdnRanges ?? []).includes(rule.source)) add('over-broad-cdn', 'CDN source range permits all ports; recommend reviewed 80/443 scope', { rule: rule.raw });
      else if (['public', 'all-interfaces'].includes(scope(rule.source.split('/')[0]))) add('over-broad-source', 'Public source permits all ports', { rule: rule.raw });
    }
    const chainRules = firewalls[rule.family].tables[rule.table][rule.chain].rules;
    const earlier = chainRules.slice(0, chainRules.indexOf(rule));
    const selectors = ['source', 'destination', 'protocol', 'port', 'input', 'output', 'state', 'dstType'];
    if (!rule.unknown && earlier.some(first => !first.unknown && ['ACCEPT', 'DROP', 'REJECT'].includes(first.target)
      && selectors.every(key => !first[key] || first[key] === rule[key]))) add('shadowed-rule', 'Earlier terminal rule covers these selectors', { family: rule.family, rule: rule.raw });
  }
  if (data.iptables4 && data.iptables6) {
    const signature = family => JSON.stringify({ policy: firewalls[family].tables.filter?.INPUT?.policy,
      rules: rules.filter(rule => rule.family === family && rule.table === 'filter').map(rule => rule.raw) });
    if (signature(4) !== signature(6)) add('v4-v6-asymmetry', 'IPv4/IPv6 policy or rule coverage differs; review family-specific listener reachability');
  }
  const hostExposures = sockets.flatMap(socket => {
    const families = socket.family ? [socket.family] : [4, 6];
    return families.map(family => {
      const firewall = firewalls[family];
      const packet = { port: socket.port, protocol: socket.protocol, source: '*',
        destination: socket.scope === 'all-interfaces' ? '*' : socket.address, input: data.ingressInterface };
      const result = trace(firewall, 'filter', 'INPUT', packet);
      const unsupported = data.nftables || data.firewalld || Object.keys(firewall.tables).some(table => !['filter', 'nat'].includes(table));
      const verdict = unsupported ? 'unknown' : ['loopback', 'vpn', 'private'].includes(socket.scope) ? 'restricted bind; routing requires review'
        : result.verdict === 'ACCEPT' ? 'accepted on captured host path'
        : ['DROP', 'REJECT'].includes(result.verdict) ? 'blocked on captured host path' : 'unknown';
      return { ...socket, family, verdict, path: result.path };
    });
  });
  const policies = Object.entries(firewalls).flatMap(([family, firewall]) => Object.entries(firewall.tables).flatMap(([table, chains]) =>
    Object.entries(chains).filter(([, body]) => body.policy !== '-').map(([chain, body]) =>
      ({ family: Number(family), table, chain, type: 'policy', target: body.policy }))));
  const mappedRules = rules.map(rule => ({ ...rule, listenerMatches: sockets.filter(socket =>
    (socket.family === rule.family || !socket.family) && (!rule.port || Number(rule.port) === socket.port)
    && (!rule.protocol || rule.protocol === socket.protocol)).map(socket => `${socket.address}:${socket.port}/${socket.protocol}`) }));
  const external = (data.external ?? []).map(probe => {
    const family = isIP(probe.source);
    const allow = rules.find(rule => rule.family === family && rule.target === 'ACCEPT' && rule.source
      && !['0.0.0.0/0', '::/0'].includes(rule.source) && inRange(probe.source, rule.source));
    if (allow) add('allowlisted-vantage', 'Probe source matches an allowlist; external coverage is unrepresentative', { family, port: probe.port });
    return { ...probe, provesClosed: false, reason: allow
      ? 'Probe source matches an allowlist; closed result proves nothing about ordinary internet sources'
      : 'Result is limited to this vantage, protocol, port and capture time; it cannot prove general closure' };
  });
  const unknown = findings.filter(finding => /missing-.*evidence|manual-backend/.test(finding.code)).length + exposures.filter(entry => entry.verdict === 'unknown').length;
  const failed = findings.length - findings.filter(finding => /missing-.*evidence|manual-backend/.test(finding.code)).length;
  return { host: data.host, capturedAt: data.capturedAt, mode: 'read-only', evidence,
    listeners: sockets, rules: [...mappedRules, ...policies], exposures, hostExposures, findings, external,
    summary: { status: failed ? 'FAIL' : unknown ? 'UNKNOWN' : 'PASS', failed, unknown } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--snapshot') throw new Error('Usage: analyze.mjs --snapshot sanitized-snapshot.json');
    const report = analyze(JSON.parse(readFileSync(args[1], 'utf8')));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.summary.status === 'FAIL' ? 2 : report.summary.status === 'UNKNOWN' ? 3 : 0;
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
