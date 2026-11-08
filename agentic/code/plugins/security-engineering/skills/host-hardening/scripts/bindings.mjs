// Check Compose and docker run publishes without executing or rewriting them.
import yaml from 'js-yaml';
import { isIP } from 'node:net';

function bindOf(value) {
  if (typeof value === 'object' && value !== null) return value.host_ip;
  const text = String(value).replace(/\/(tcp|udp|sctp)$/, '');
  const ipv6 = text.match(/^\[([^\]]+)\]:[^:]+:[^:]+$/);
  if (ipv6) return ipv6[1];
  const parts = text.split(':');
  return parts.length === 3 ? parts[0] : undefined;
}
function finding(value, location) {
  const address = bindOf(value);
  if (!address || !isIP(address)) return { code: 'missing-bind', location,
    detail: 'Explicit literal bind address required; unresolved variables require rendered Compose review' };
  if (['0.0.0.0', '::'].includes(address)) return { code: 'wildcard-bind', location,
    detail: 'All-interface publish needs documented public-service justification and firewall review' };
  return undefined;
}
export function checkCompose(text) {
  const document = yaml.load(text);
  if (!document || typeof document !== 'object' || !document.services) throw new Error('Compose services mapping required');
  const findings = [];
  for (const [name, service] of Object.entries(document.services)) {
    if (!service || typeof service !== 'object') continue;
    if (service.network_mode === 'host') findings.push({ code: 'host-network', location: name, detail: 'Host networking requires listener review; ports do not constrain it' });
    if (service.ports !== undefined && !Array.isArray(service.ports)) throw new Error('Compose ports must be an array');
    for (const [index, port] of (service.ports ?? []).entries()) {
      const issue = finding(port, `services.${name}.ports[${index}]`);
      if (issue) findings.push(issue);
    }
  }
  return findings;
}
export function checkDockerRun(text) {
  const findings = [];
  for (const [index, line] of text.split('\n').entries()) {
    // A bounded lexical check; shell expansion and generated commands require manual review.
    const publishes = line.matchAll(/(?:^|\s)(?:-p\s*|--publish(?:=|\s+))('[^']*'|"[^"]*"|\S+)/g);
    for (const match of publishes) {
      const issue = finding(match[1].replace(/^['"]|['"]$/g, ''), `line ${index + 1}`);
      if (issue) findings.push(issue);
    }
    if (/(?:^|\s)(?:-P|--publish-all)(?:\s|$)/.test(line)) findings.push({ code: 'missing-bind', location: `line ${index + 1}`, detail: 'Publish-all has no explicit bind address' });
  }
  return findings;
}
