// Score retained raw worker artifacts as a protected --check or EvalHarness score instrument.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { strictJson, digest } from './structured-artifact-json.mjs';
import { compileOutputSchema, loadFixtureManifest } from './structured-artifact-manifest.mjs';
import { scoreField, leaves, arrayItems } from './structured-artifact-fields.mjs';

const operational = ['success', 'transport-failure', 'schema-admission-rejection', 'truncation', 'missing-output'];
export function scoreArtifact(fixture, bytes, { operationalOutcome = 'success', repair } = {}) {
  if (!operational.includes(operationalOutcome)) throw new Error('Unknown operational outcome');
  const raw = Buffer.from(bytes ?? '');
  if (raw.length > 10 * 1024 * 1024) throw new Error('Artifact exceeds 10 MiB');
  let value, parseable = false, parseError = null;
  try { value = strictJson(raw); parseable = true; } catch (error) { parseError = error.message; }
  const validate = compileOutputSchema(fixture.schema);
  const schemaValid = parseable && validate(value);
  const outcome = operationalOutcome !== 'success' ? operationalOutcome : !raw.length ? 'empty-response'
    : !parseable ? 'parse-failure' : !schemaValid ? 'schema-violation' : 'success';
  const structure = { transportSuccess: operationalOutcome !== 'transport-failure', parseable, schemaValid: !!schemaValid,
    outcome, parseError, schemaErrors: schemaValid ? [] : validate.errors ?? [] };
  const fields = fixture.fields.map(policy => scoreField(policy, value, fixture.source));
  const fieldPasses = outcome === 'success' ? fields.filter(f => f.pass).length : 0;
  const supportedPasses = outcome === 'success' ? fields.filter(f => f.outcome === 'supported-pass').length : 0;
  const accepted = outcome === 'success' && fields.every(f => f.pass);
  const result = {
    id: fixture.id, domain: fixture.domain, arm: fixture.arm,
    binding: { sourceDigest: fixture.sourceDigest, schemaDigest: fixture.schemaDigest, policyVersion: 'REF-3174-v1' },
    raw: { base64: raw.toString('base64'), digest: digest(raw) }, structure, fields, fieldPasses, supportedPasses, accepted,
    criticalGate: outcome === 'success' && fields.filter(f => f.severity === 'critical').every(f => f.pass),
    requiredArmSchemaConflict: fixture.arm === 'required' && fixture.fields.every(f => f.expected.state === 'UNKNOWN'),
    denominators: { attempts: 1, schema_field_positions: fields.length,
      expanded_leaf_values: fixture.fields.reduce((n, f) => n + leaves(f.expected.value), 0),
      array_items: fixture.fields.reduce((n, f) => n + arrayItems(f.expected.value), 0) },
  };
  if (repair) {
    if (typeof repair.transformation !== 'string' || !repair.transformation || repair.raw === undefined) throw new Error('Repair requires separate bytes and transformation log');
    result.repair = { ...scoreArtifact(fixture, repair.raw, { operationalOutcome }), intervention: 'repair', transformation: repair.transformation };
  }
  return result;
}
const fraction = (n, d) => d ? n / d : null;
function interval(passes, total) {
  if (!total) return null;
  const p = passes / total, z2 = 3.841458820694124;
  const center = (p + z2 / (2 * total)) / (1 + z2 / total);
  const margin = Math.sqrt(z2 * (p * (1 - p) / total + z2 / (4 * total * total))) / (1 + z2 / total);
  return { method: 'wilson-95', passes, total, lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}
function counter(group, key) { return group[key] ??= { attempts: 0, total: 0, passes: 0 }; }
export function scoreFixtureAttempts(manifest, attempts) {
  const scheduled = new Set(manifest.cases.map(c => c.id));
  const byId = new Map();
  for (const attempt of attempts) {
    if (!scheduled.has(attempt.id) || byId.has(attempt.id)) throw new Error('Unscheduled or duplicate attempt; repetitions need separate run identifiers');
    byId.set(attempt.id, attempt);
  }
  const results = manifest.cases.map(c => {
    const a = byId.get(c.id);
    return scoreArtifact(c, a?.raw, a ? { operationalOutcome: a.operationalOutcome, repair: a.repair } : { operationalOutcome: 'missing-output' });
  });
  const denominators = { attempts: 0, schema_field_positions: 0, expanded_leaf_values: 0, array_items: 0 };
  const strata = { domain: {}, arm: {}, severity: {}, fieldType: {} };
  const outcomes = {}; let passes = 0; let validPasses = 0; let validTotal = 0; let validAttempts = 0;
  for (const r of results) {
    Object.keys(denominators).forEach(key => { denominators[key] += r.denominators[key]; });
    passes += r.fieldPasses;
    const valid = r.structure.outcome === 'success';
    if (valid) { validAttempts++; validPasses += r.fieldPasses; validTotal += r.fields.length; }
    for (const [name, key] of [['domain', r.domain], ['arm', r.arm]]) {
      const c = counter(strata[name], key); c.attempts++; c.total += r.fields.length; c.passes += r.fieldPasses;
    }
    for (const f of r.fields) {
      outcomes[f.outcome] = (outcomes[f.outcome] ?? 0) + 1;
      if (!valid) outcomes['structural-failure'] = (outcomes['structural-failure'] ?? 0) + 1;
      for (const [name, key] of [['severity', f.severity], ['fieldType', f.type]]) {
        const c = counter(strata[name], key); c.attempts++; c.total++; c.passes += valid && f.pass ? 1 : 0;
      }
    }
  }
  const domains = Object.values(strata.domain);
  const missingEvidence = {};
  for (const r of results) {
    const c = missingEvidence[`${r.domain}/${r.arm}`] ??= { absentAttempts: 0, absentPositions: 0, fabricatedCases: 0,
      fabricatedFields: 0, validAbstentions: 0, presentPositions: 0, supportedCorrect: 0, overAbstentions: 0, failedOutputs: 0 };
    const absent = r.fields.filter(f => f.goldState === 'UNKNOWN');
    if (absent.length) {
      c.absentAttempts++; c.absentPositions += absent.length;
      const fabricated = absent.filter(f => f.outcome === 'unsupported-addition');
      c.fabricatedFields += fabricated.length; c.fabricatedCases += fabricated.length > 0 ? 1 : 0;
      c.validAbstentions += r.structure.outcome === 'success' && absent.every(f => f.outcome === 'valid-abstention') ? 1 : 0;
    }
    const present = r.fields.filter(f => f.goldState === 'PRESENT');
    c.presentPositions += present.length;
    c.supportedCorrect += r.structure.outcome === 'success' ? present.filter(f => f.outcome === 'supported-pass').length : 0;
    c.overAbstentions += present.filter(f => f.outcome === 'over-abstention').length;
    c.failedOutputs += r.structure.outcome !== 'success' ? 1 : 0;
  }
  for (const c of Object.values(missingEvidence)) {
    c.intervals = { caseFabrication: interval(c.fabricatedCases, c.absentAttempts),
      fieldFabrication: interval(c.fabricatedFields, c.absentPositions),
      validAbstention: interval(c.validAbstentions, c.absentAttempts),
      presentCorrectness: interval(c.supportedCorrect, c.presentPositions),
      overAbstention: interval(c.overAbstentions, c.presentPositions) };
  }
  return { version: 1, scope: 'fixture-only; no model reliability claim', manifestDigest: manifest.manifestDigest,
    policyVersion: manifest.policyVersion, goldVersion: manifest.goldVersion, denominators, outcomes, strata, missingEvidence,
    micro: { passes, total: denominators.schema_field_positions, rate: fraction(passes, denominators.schema_field_positions) },
    macro: { domains: domains.length, rate: domains.length ? domains.reduce((n, c) => n + c.passes / c.total, 0) / domains.length : null },
    validOnly: { label: 'schema-valid operational successes only', attempts: validAttempts, passes: validPasses, total: validTotal, rate: fraction(validPasses, validTotal) },
    criticalGate: results.length > 0 && results.every(r => r.criticalGate), results };
}

// Existing --check accepts an absolute Node interpreter and this installed script;
// manifest, digest and case ID are conductor-owned arguments, never worker metadata.
export function runStructuredArtifactCheck(args, stdout = console.log) {
  try {
    if (args.length !== 4) throw new Error('Expected manifest path, pinned digest, case ID, artifact path');
    const [manifestPath, expectedDigest, caseId, artifactPath] = args;
    const manifest = loadFixtureManifest(manifestPath, expectedDigest);
    const fixture = manifest.cases.find(c => c.id === caseId);
    if (!fixture) throw new Error('Case not in pinned manifest');
    const result = scoreArtifact(fixture, readFileSync(artifactPath));
    stdout(JSON.stringify({ ...result, binding: { ...result.binding, manifestDigest: manifest.manifestDigest, goldVersion: manifest.goldVersion },
      score: result.accepted ? 100 : 0, pass_count: result.fieldPasses, total_count: result.fields.length }));
    return result.accepted ? 0 : 1;
  } catch (error) {
    stdout(JSON.stringify({ score: 0, pass_count: 0, total_count: 1, error: error.message }));
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = runStructuredArtifactCheck(process.argv.slice(2));
