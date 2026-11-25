// Deterministic field policies and reviewable one-to-one array alignment for REF-3174.
import { isDeepStrictEqual as equal } from 'node:util';
export const MISSING = Symbol('MISSING_KEY');
export function at(value, pointer) {
  for (const key of pointer.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return MISSING;
    value = value[key];
  }
  return value;
}
export const leaves = value => value && typeof value === 'object'
  ? Object.values(value).reduce((n, v) => n + leaves(v), 0) : 1;
export const arrayItems = value => Array.isArray(value) ? value.length + value.reduce((n, v) => n + arrayItems(v), 0)
  : value && typeof value === 'object' ? Object.values(value).reduce((n, v) => n + arrayItems(v), 0) : 0;
const typed = (v, type) => type === 'integer' ? Number.isSafeInteger(v) : type === 'array' ? Array.isArray(v)
  : type === 'object' ? v !== null && typeof v === 'object' && !Array.isArray(v) : typeof v === type;
const normalized = (s, policy) => policy === 'collapse' ? s.replace(/\s+/g, ' ').trim() : s;

// JSON numeric values are compared as decimal rationals at tolerance boundaries.
function decimal(number) {
  const [mantissa, exponent = '0'] = String(number).split('e');
  const places = (mantissa.split('.')[1] ?? '').length - Number(exponent);
  const integer = BigInt(mantissa.replace('.', ''));
  return places >= 0 ? [integer, 10n ** BigInt(places)] : [integer * 10n ** BigInt(-places), 1n];
}
const add = (a, b) => [a[0] * b[1] + b[0] * a[1], a[1] * b[1]];
const multiply = (a, b) => [a[0] * b[0], a[1] * b[1]];
const absolute = a => [a[0] < 0n ? -a[0] : a[0], a[1]];
function withinTolerance(value, policy) {
  const gold = decimal(policy.expected.value);
  let predicted = decimal(typeof value === 'number' ? value : value.value);
  if (typeof value === 'object') {
    const unit = decimal(policy.units[value.unit]); const base = decimal(policy.units[policy.unit]);
    predicted = multiply(predicted, multiply(unit, [base[1], base[0]]));
  }
  const error = absolute(add(predicted, [-gold[0], gold[1]]));
  const tolerance = add(decimal(policy.absTol), multiply(decimal(policy.relTol), absolute(gold)));
  return error[0] * tolerance[1] <= tolerance[0] * error[1];
}

function align(policy, predicted, source) {
  const gold = policy.expected.value;
  const identity = v => policy.itemKey ? at(v, policy.itemKey) : v;
  const used = new Set(); const alignment = []; const duplicates = []; const spurious = [];
  const seen = [];
  predicted.forEach((v, prediction) => {
    const id = identity(v);
    if (seen.some(x => equal(x, id))) duplicates.push(prediction);
    seen.push(id);
    const match = gold.findIndex((g, i) => !used.has(i) && (!policy.ordered || i === prediction)
      && id !== MISSING && equal(identity(g), id));
    if (match === -1) spurious.push(prediction);
    else { used.add(match); alignment.push({ gold: match, prediction }); }
  });
  alignment.sort((a, b) => a.gold - b.gold);
  const content = alignment.map(pair => ({ ...pair, fields: (policy.attributes ?? []).map(attribute =>
    scoreField({ ...attribute, expected: { ...attribute.expected, value: at(gold[pair.gold], attribute.path) } }, predicted[pair.prediction], source)) }));
  const tp = alignment.length, fp = predicted.length - tp, fn = gold.length - tp;
  const knownEmpty = gold.length === 0;
  const precision = tp + fp ? tp / (tp + fp) : knownEmpty ? 1 : 0;
  const recall = gold.length ? tp / gold.length : 1;
  const f1 = 2 * tp + fp + fn ? 2 * tp / (2 * tp + fp + fn) : 1;
  return { tp, fp, fn, precision, recall, f1, knownEmpty, alignment, duplicates, spurious,
    misses: gold.map((_, i) => i).filter(i => !used.has(i)), content,
    pass: fp === 0 && fn === 0 && content.every(c => c.fields.every(f => f.pass)) };
}

export function scoreField(policy, object, source) {
  const raw = at(object, policy.path);
  let value = raw;
  let unknown = false;
  if (policy.tagged && raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (raw.state === 'known' && Object.keys(raw).length === 2 && Object.hasOwn(raw, 'value')) value = raw.value;
    else if (raw.state === 'unknown') unknown = true;
  }
  const state = raw === MISSING ? 'MISSING_KEY' : unknown ? 'UNKNOWN' : value === null ? 'EXPLICIT_NULL'
    : Array.isArray(value) && value.length === 0 ? 'KNOWN_EMPTY' : 'PRESENT';
  const result = { path: policy.path, metric: policy.metric, severity: policy.severity, type: policy.type,
    goldState: policy.expected.state, state, ...(raw === MISSING ? {} : { raw }), pass: false };
  const finish = (outcome, pass = false) => ({ ...result, outcome, pass });
  if (raw === MISSING) return finish('omission');
  if (policy.expected.state === 'UNKNOWN') {
    if (state === 'EXPLICIT_NULL' && policy.unknownRepresentations.includes('null')) return finish('valid-abstention', true);
    if (unknown && policy.unknownRepresentations.includes('tagged') && Object.keys(raw).length === 2
      && raw.reason === policy.expected.reason) return finish('valid-abstention', true);
    if (unknown || value === null) return finish('unauthorized-abstention');
    return finish('unsupported-addition');
  }
  if (policy.expected.state === 'EXPLICIT_NULL') return value === null ? finish('supported-pass', true) : finish('wrong-value');
  if (unknown || value === null) return finish('over-abstention');
  if (policy.metric === 'quantity') {
    let number = value;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (typeof value.value !== 'number' || !Number.isFinite(value.value) || Object.keys(value).length !== 2
        || !Object.hasOwn(policy.units, value.unit)) return finish('wrong-value');
      number = value.value * policy.units[value.unit] / policy.units[policy.unit];
    }
    if (typeof number !== 'number' || !Number.isFinite(number)) return finish('wrong-type');
    const pass = withinTolerance(value, policy);
    return { ...finish(pass ? 'supported-pass' : 'wrong-value', pass), normalized: number };
  }
  if (!typed(value, policy.type)) return finish('wrong-type');
  if (policy.metric === 'array') {
    const aligned = align(policy, value, source);
    return { ...finish(aligned.pass ? 'supported-pass' : aligned.fp ? 'spurious-addition' : aligned.fn ? 'omission' : 'wrong-value', aligned.pass), ...aligned };
  }
  let pass;
  if (policy.metric === 'quote') {
    const span = policy.expected.evidence;
    pass = typeof value === 'string' && normalized(value, policy.whitespace) === normalized(source.slice(span.start, span.end), policy.whitespace);
  } else if (policy.metric === 'alias') pass = equal(value, policy.expected.value) || policy.aliases.includes(value);
  else pass = equal(value, policy.expected.value);
  return finish(pass ? 'supported-pass' : 'wrong-value', pass);
}
