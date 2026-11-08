// Parse captured iptables rules and conservatively trace a new inbound packet.
import { isIP } from 'node:net';

function addressNumber(address) {
  if (isIP(address) === 4) return address.split('.').reduce((n, part) => (n << 8n) + BigInt(part), 0n);
  if (isIP(address) !== 6) return undefined;
  let text = address;
  if (text.includes('.')) {
    const split = text.lastIndexOf(':');
    const v4 = addressNumber(text.slice(split + 1));
    text = `${text.slice(0, split)}:${(v4 >> 16n).toString(16)}:${(v4 & 65535n).toString(16)}`;
  }
  const halves = text.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return groups.reduce((n, group) => (n << 16n) + BigInt(`0x${group}`), 0n);
}
export function inRange(address, cidr) {
  const [base, mask] = cidr.split('/');
  const family = isIP(base);
  if (!family || isIP(address) !== family) return false;
  const bits = family === 4 ? 32 : 128;
  const prefix = mask === undefined ? bits : Number(mask);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return false;
  const shift = BigInt(bits - prefix);
  return addressNumber(address) >> shift === addressNumber(base) >> shift;
}
export function scope(address, vpn = []) {
  if (vpn.includes(address)) return 'vpn';
  if (['*', '0.0.0.0', '::', ''].includes(address)) return 'all-interfaces';
  if (inRange(address, '127.0.0.0/8') || address === '::1') return 'loopback';
  if (['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', 'fc00::/7', 'fe80::/10'].some(range => inRange(address, range))) return 'private';
  return isIP(address) ? 'public' : 'unknown';
}
export function parseFirewall(raw, family) {
  const tables = {};
  const rules = [];
  let table;
  for (const line of (raw ?? '').split('\n')) {
    if (line.startsWith('*')) { table = line.slice(1); tables[table] = {}; }
    if (line.startsWith(':') && table) {
      const [name, policy] = line.slice(1).split(/\s+/);
      tables[table][name] = { policy, rules: [] };
    }
    if (!line.startsWith('-A ') || !table) continue;
    const tokens = line.match(/"[^"]*"|\S+/g) ?? [];
    const rule = { family, table, chain: tokens[1], raw: line, unknown: false };
    for (let i = 2; i < tokens.length; i++) {
      const token = tokens[i];
      const fields = { '-s': 'source', '-d': 'destination', '-p': 'protocol', '--dport': 'port',
        '-j': 'target', '--to-destination': 'dnat', '-i': 'input', '-o': 'output', '--ctstate': 'state', '--dst-type': 'dstType' };
      if (fields[token]) rule[fields[token]] = tokens[++i];
      else if (token === '-m') { if (!['tcp', 'udp', 'conntrack', 'addrtype', 'comment'].includes(tokens[++i])) rule.unknown = true; }
      else if (token === '--comment') i++;
      else rule.unknown = true;
    }
    if (!tables[table][rule.chain]) tables[table][rule.chain] = { policy: '-', rules: [] };
    tables[table][rule.chain].rules.push(rule);
    rules.push(rule);
  }
  return { tables, rules };
}
function match(rule, packet) {
  let unknown = rule.unknown;
  for (const key of ['source', 'destination']) {
    if (!rule[key] || ['0.0.0.0/0', '::/0'].includes(rule[key])) continue;
    if (!packet[key] || packet[key] === '*') unknown = true;
    else if (!inRange(packet[key], rule[key])) return false;
  }
  if (rule.protocol && rule.protocol !== 'all' && rule.protocol !== packet.protocol) return false;
  if (rule.port) {
    if (!/^\d+$/.test(rule.port)) unknown = true;
    else if (Number(rule.port) !== packet.port) return false;
  }
  for (const key of ['input', 'output']) {
    if (!rule[key]) continue;
    if (!packet[key]) unknown = true;
    else if (rule[key] !== packet[key]) return false;
  }
  if (rule.state && !rule.state.split(',').includes('NEW')) return false;
  if (rule.dstType && rule.dstType !== 'LOCAL') unknown = true;
  return unknown ? 'unknown' : true;
}
export function trace(firewall, table, chain, packet, seen = []) {
  const name = `${table}/${chain}`;
  const path = [name];
  const body = firewall.tables[table]?.[chain];
  if (!body || seen.includes(name)) return { verdict: 'UNKNOWN', path };
  for (const rule of body.rules) {
    const matches = match(rule, packet);
    if (matches === false) continue;
    if (matches === 'unknown') return { verdict: 'UNKNOWN', path };
    const target = rule.target;
    if (['ACCEPT', 'DROP', 'REJECT', 'RETURN', 'DNAT'].includes(target)) return { verdict: target, path, rule };
    if (['LOG', 'NFLOG'].includes(target)) continue;
    const nested = trace(firewall, table, target, packet, [...seen, name]);
    path.push(...nested.path);
    if (nested.verdict !== 'RETURN') return { ...nested, path };
  }
  return { verdict: body.policy === '-' ? 'RETURN' : body.policy, path };
}
export function listeners(raw, vpn) {
  return (raw ?? '').split('\n').flatMap(line => {
    const columns = line.trim().split(/\s+/);
    if (!['tcp', 'udp'].includes(columns[0]) || !['LISTEN', 'UNCONN'].includes(columns[1])) return [];
    const endpoint = columns[4]?.match(/^(?:\[([^\]]+)\]|(.+)):(\d+)$/);
    if (!endpoint) return [];
    const address = endpoint[1] ?? endpoint[2];
    return [{ protocol: columns[0], address, port: Number(endpoint[3]), family: isIP(address) || 0,
      scope: scope(address, vpn), owner: line.match(/users:\(\((.*)\)\)/)?.[1] ?? 'unknown' }];
  });
}
