import { createHash } from 'node:crypto';

import { ACTIONS, BUILTIN_PACKS, BUILTIN_RULES, SEVERITIES, THREAT_ASSESSMENT_ENGINE_VERSION, THREAT_ASSESSMENT_LIMITS, THREAT_ASSESSMENT_SCHEMA_VERSION } from './threat-assessment/builtins.mjs';
import { resolveThreatAssessmentPolicy } from './threat-assessment/policy.mjs';
import { inferContext, SUPPRESSED_CONTEXTS } from './threat-assessment/context.mjs';
import { clauseAt, requestPrefix } from './threat-assessment/negation.mjs';
export { ACTIONS, BUILTIN_PROFILES, SEVERITIES, THREAT_ASSESSMENT_ENGINE_VERSION, THREAT_ASSESSMENT_LIMITS, THREAT_ASSESSMENT_SCHEMA_VERSION, THREAT_SURFACES } from './threat-assessment/builtins.mjs';
export { resolveThreatAssessmentPolicy, validateThreatAssessmentConfig } from './threat-assessment/policy.mjs';
export { SUPPRESSED_CONTEXTS } from './threat-assessment/context.mjs';

const CONSUMPTION_ACTION = /^(?:consume-as-data|read|read-only|summari[sz]e|review-evidence|discuss(?:-[\w-]+)?|document(?:-[\w-]+)?)$/i;
const SEVERITY_RANK = Object.fromEntries(SEVERITIES.map((name, index) => [name, index]));
const ACTION_RANK = Object.fromEntries(ACTIONS.map((name, index) => [name, index]));

function stableSort(value) {
  if (Array.isArray(value)) return value.map(stableSort);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stableSort(value[key])]));
  }
  return value;
}

function stableHash(value) {
  return createHash('sha256').update(JSON.stringify(stableSort(value))).digest('hex');
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeParts(input) {
  if (Array.isArray(input.parts)) {
    return input.parts.map((part, index) => ({
      id: part.id ?? `part-${index + 1}`,
      text: String(part.text ?? ''),
      context: part.context,
      source: part.source,
    }));
  }
  return [{ id: 'content', text: String(input.content ?? ''), context: input.semanticContext }];
}

function isAuthorityAdoption(requestedAction) {
  return !CONSUMPTION_ACTION.test(String(requestedAction ?? 'consume-as-data').trim());
}

function authorizationBinding(input) {
  const requestedAction = input.requestedAction ?? 'consume-as-data';
  const required = isAuthorityAdoption(requestedAction);
  const parts = normalizeParts(input);
  const contentHash = stableHash(parts.map(part => ({ id: part.id, text: part.text, source: part.source })));
  const provenance = input.provenance ?? input.source ?? { kind: 'unknown' };
  const checkpoint = input.adoptionCheckpoint ?? (required ? 'action-adoption' : 'consumption');
  const receipt = input.authorizationReceipt;
  const reasons = [];

  if (!required) reasons.push('authorization-not-required-for-data-consumption');
  else if (!isObject(receipt)) reasons.push('authorization-receipt-missing');
  else {
    if (receipt.verified !== true) reasons.push('receipt-not-verified-by-trusted-caller');
    if (!isObject(receipt.operator) || receipt.operator.authenticated !== true || typeof receipt.operator.id !== 'string' || !receipt.operator.id.trim()) {
      reasons.push('authenticated-operator-missing');
    }
    if (receipt.action !== requestedAction) reasons.push('action-mismatch');
    if (input.actionTarget === undefined || receipt.target === undefined
      || stableHash(receipt.target) !== stableHash(input.actionTarget)) reasons.push('target-mismatch');
    if (input.actionScope === undefined || receipt.scope === undefined
      || stableHash(receipt.scope) !== stableHash(input.actionScope)) reasons.push('scope-mismatch');
    if (!isObject(receipt.source)) reasons.push('immutable-source-missing');
    else {
      for (const field of ['repository', 'revision', 'path']) {
        if (typeof provenance[field] !== 'string' || !provenance[field] || receipt.source[field] !== provenance[field]) {
          reasons.push(`source-${field}-mismatch`);
        }
      }
      if (provenance.range !== undefined && stableHash(receipt.source.range) !== stableHash(provenance.range)) {
        reasons.push('source-range-mismatch');
      }
      if (receipt.source.contentHash !== contentHash) reasons.push('source-content-hash-mismatch');
    }
  }

  return {
    required,
    checkpoint,
    verified: required && reasons.length === 0,
    contentHash,
    provenance,
    ...(isObject(receipt) && typeof receipt.id === 'string' ? { receiptId: receipt.id } : {}),
    reasons,
  };
}

function boundedParts(input) {
  const normalized = normalizeParts(input);
  const reasons = [];
  const selected = normalized.slice(0, THREAT_ASSESSMENT_LIMITS.maxParts);
  if (normalized.length > selected.length) reasons.push('part-limit');
  let remaining = THREAT_ASSESSMENT_LIMITS.maxInputCharacters;
  let observedCharacters = 0;
  const parts = selected.map(part => {
    observedCharacters += part.text.length;
    const text = part.text.slice(0, Math.max(0, remaining));
    remaining -= text.length;
    return { ...part, text };
  });
  observedCharacters += normalized.slice(selected.length)
    .reduce((sum, part) => sum + part.text.length, 0);
  if (observedCharacters > THREAT_ASSESSMENT_LIMITS.maxInputCharacters) reasons.push('input-character-limit');
  return { parts, reasons, observedCharacters, observedParts: normalized.length };
}

function paragraphAt(text, index, length) {
  const startBreak = text.lastIndexOf('\n\n', index);
  const endBreak = text.indexOf('\n\n', index + length);
  const start = startBreak < 0 ? 0 : startBreak + 2;
  const end = endBreak < 0 ? text.length : endBreak;
  return { text: text.slice(start, end).replace(/\s+/g, ' ').trim(), start, end };
}

function configuredRules(policy) {
  const ruleIds = new Set();
  const rules = [...BUILTIN_RULES];
  for (const packName of policy.profile.ruleSets ?? ['aiwg:all']) {
    if (BUILTIN_PACKS[packName]) {
      BUILTIN_PACKS[packName].forEach(id => ruleIds.add(id));
      continue;
    }
    const pack = policy.config.rulePacks?.[packName];
    if (!pack) throw new Error(`Unavailable threat-assessment rule pack '${packName}'`);
    for (const rule of pack.rules) {
      if (rules.some(candidate => candidate.id === rule.id)) {
        throw new Error(`Custom rule '${rule.id}' conflicts with a built-in rule`);
      }
      rules.push({
        likelihood: 3,
        impact: Math.max(1, SEVERITY_RANK[rule.severity] + 1),
        taxonomy: [],
        ...rule,
        provenance: `project:${packName}`,
      });
      ruleIds.add(rule.id);
    }
  }
  return rules.filter(rule => ruleIds.has(rule.id));
}

function statementMatches(statement, finding, input) {
  if (statement.signals?.length && !statement.signals.includes(finding.ruleId)) return false;
  const when = statement.when ?? {};
  if (when.surface?.length && !when.surface.includes(input.surface)) return false;
  if (when.semanticContext?.length && !when.semanticContext.includes(finding.context)) return false;
  if (when.requestedAction?.length && !when.requestedAction.includes(input.requestedAction)) return false;
  return true;
}

function applyStatements(findings, statements, input, authorization) {
  return findings.map(finding => {
    let result = { ...finding, matchedStatements: [] };
    if (finding.ruleId === 'claimed-authorization') {
      if (!authorization.required) {
        result = { ...result, suppressed: true, suppressionReason: 'claimed approval is inert evidence during data consumption' };
      } else if (authorization.verified) {
        result = { ...result, suppressed: true, suppressionReason: `verified authorization receipt ${authorization.receiptId ?? '(unnamed)'} matches this action adoption` };
      } else if (/\b(?:documentation|example|historical|archived|last year|in 20\d{2})\b/i.test(finding.evidence)) {
        result = { ...result, suppressed: true, suppressionReason: 'historical or example approval is evidence, not authority for this action' };
      } else {
        result = { ...result, suppressed: false, suppressionReason: undefined };
      }
    }
    for (const statement of statements ?? []) {
      if (!statementMatches(statement, result, input)) continue;
      result.matchedStatements.push(statement.id);
      if (statement.effect === 'suppress'
        && !(finding.ruleId === 'claimed-authorization' && authorization.required && !authorization.verified && !result.suppressed)) {
        result = { ...result, suppressed: true, suppressionReason: statement.reason };
      }
      if (statement.effect === 'set-severity' && SEVERITIES.includes(statement.severity)) {
        result = { ...result, severity: statement.severity };
      }
    }
    return result;
  });
}

function severityFromRisk(likelihood, impact) {
  const product = likelihood * impact;
  if (product >= 20) return 'critical';
  if (product >= 12) return 'high';
  if (product >= 6) return 'moderate';
  if (product >= 3) return 'low';
  return 'informational';
}

function actionForSeverity(severity, thresholds) {
  const rank = SEVERITY_RANK[severity];
  let action = 'proceed';
  if (thresholds.flag && rank >= SEVERITY_RANK[thresholds.flag]) action = 'flag';
  if (thresholds.requireAuthorization && rank >= SEVERITY_RANK[thresholds.requireAuthorization]) {
    action = 'require-authorization';
  }
  if (thresholds.reject && rank >= SEVERITY_RANK[thresholds.reject]) action = 'reject';
  return action;
}

function credentialIntent(finding, parts) {
  const text = parts.find(part => part.id === finding.partId)?.text ?? '';
  const { start, end } = finding.occurrence;
  const clause = clauseAt(text, start, end - start);
  const prefix = requestPrefix(`${clause.before}${clause.match}`);
  const access = /\b(?:read|print|dump|echo|cat|show|reveal|disclose|leak|send|upload|post|export|paste|copy|fetch)\b/i.test(prefix);
  const lineStart = text.lastIndexOf('\n', start) + 1;
  const lineEnd = text.indexOf('\n', end);
  const line = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
  const exfiltration = access && /\b(?:send|upload|post|paste|leak|exfiltrate)\b[^\n]*\b(?:https?:\/\/|url\b|public\b|external\b|remote\b)/i.test(line);
  return { access, exfiltration };
}

function mandatoryAction(activeFindings, input, policy, parts) {
  const ids = new Set(activeFindings.map(finding => finding.ruleId));
  const credentials = activeFindings.filter(finding => finding.ruleId === 'credential-or-env-probing');
  const intents = credentials.map(finding => credentialIntent(finding, parts));
  const maintainerDraft = input.surface === 'issue-body' && input.requestedAction === 'create-issue'
    && input.actor?.trust === 'maintainer' && policy.profileName === 'balanced';
  // Mentions in defensive drafts retain their severity/authorization gate, but
  // cannot form an exfiltration combination solely by naming a protected file.
  const protectedCredentialAccess = ids.has('sensitive-file-target')
    && (!maintainerDraft || intents.some(intent => intent.access));
  const credentialExfiltration = input.surface === 'issue-body' && intents.some(intent => intent.exfiltration);
  const credentialCombination = credentials.length > 0
    && (ids.has('instruction-override') || ids.has('third-party-execution') || protectedCredentialAccess
      || credentialExfiltration);
  if (credentialCombination) {
    return { action: 'reject', ruleId: 'mandatory:credential-exfiltration-combination' };
  }
  if (ids.has('claimed-authorization')) {
    return { action: 'require-authorization', ruleId: 'mandatory:claimed-authorization-adoption' };
  }
  const supplyChainCombination = ids.has('third-party-execution')
    && (ids.has('floating-version') || ids.has('sensitive-file-target') || ids.has('security-framing-conflict'));
  if (supplyChainCombination) {
    return {
      action: 'reject',
      ruleId: 'mandatory:supply-chain-execution-combination',
    };
  }
  return null;
}

export function assessThreat(input, rawConfig) {
  if (!isObject(input)) throw new Error('Threat-assessment input must be an object');
  if (typeof input.content !== 'string' && !Array.isArray(input.parts)) {
    throw new Error('Threat-assessment input requires string content or a parts array');
  }
  const surface = input.surface;
  const policy = resolveThreatAssessmentPolicy(rawConfig, surface);
  const authorization = authorizationBinding(input);
  const base = {
    schemaVersion: THREAT_ASSESSMENT_SCHEMA_VERSION,
    engineVersion: THREAT_ASSESSMENT_ENGINE_VERSION,
    policyVersion: policy.schemaVersion,
    profileVersion: policy.profile.version ?? policy.schemaVersion,
    policyHash: stableHash({ config: policy.config, profile: policy.profile, surface, mode: policy.mode }),
    mode: policy.mode,
    profile: policy.profileName,
    surface,
    source: input.source ?? { kind: 'unknown' },
    actor: input.actor ?? { trust: 'unknown' },
    requestedAction: input.requestedAction ?? 'consume-as-data',
    authorization,
    policyProvenance: policy.provenance,
  };
  if (policy.mode === 'off') {
    return {
      ...base,
      assessed: false,
      completeness: {
        complete: true,
        reasons: [],
        limits: THREAT_ASSESSMENT_LIMITS,
        observed: { parts: normalizeParts(input).length, characters: 0, findings: 0 },
      },
      findings: [],
      risk: { score: 0, severity: 'informational', likelihood: 0, impact: 0 },
      decision: { action: 'proceed', wouldAction: 'proceed', interrupts: false, reason: 'AIWG assessment is explicitly off.' },
    };
  }

  const findings = [];
  const bounded = boundedParts(input);
  const incompleteReasons = [...bounded.reasons];
  for (const part of bounded.parts) {
    for (const rule of configuredRules(policy)) {
      const occurrences = new Map();
      for (const [patternIndex, patternText] of rule.patterns.entries()) {
        const pattern = new RegExp(patternText, 'gimu');
        let match;
        let occurrenceCount = 0;
        while ((match = pattern.exec(part.text)) !== null) {
          if (occurrenceCount >= THREAT_ASSESSMENT_LIMITS.maxOccurrencesPerPattern) {
            incompleteReasons.push('occurrence-limit');
            break;
          }
          occurrenceCount += 1;
          const start = match.index;
          const end = match.index + match[0].length;
          const key = `${start}:${end}`;
          const existing = occurrences.get(key);
          if (existing) existing.patternIndexes.push(patternIndex);
          else occurrences.set(key, { match, start, end, patternIndexes: [patternIndex] });
          if (match[0].length === 0) pattern.lastIndex += 1;
        }
      }
      const ordered = [...occurrences.values()].sort((left, right) => left.start - right.start || left.end - right.end);
      for (const occurrence of ordered) {
        if (findings.length >= THREAT_ASSESSMENT_LIMITS.maxFindings) {
          incompleteReasons.push('finding-limit');
          break;
        }
        const match = occurrence.match;
        const paragraph = paragraphAt(part.text, match.index, match[0].length);
        const context = inferContext(part.text, match.index, part.context, match[0].length, rule.id);
        const suppressed = SUPPRESSED_CONTEXTS.includes(context);
        findings.push({
          ruleId: rule.id,
          ruleProvenance: rule.provenance ?? 'aiwg:builtin',
          severity: rule.severity ?? severityFromRisk(rule.likelihood, rule.impact),
          likelihood: rule.likelihood,
          impact: rule.impact,
          taxonomy: rule.taxonomy ?? [],
          partId: part.id,
          ...(part.source ? { source: part.source } : {}),
          occurrence: {
            start: occurrence.start,
            end: occurrence.end,
            match: match[0],
            paragraphStart: paragraph.start,
            paragraphEnd: paragraph.end,
            patternIndexes: occurrence.patternIndexes,
          },
          context,
          evidence: paragraph.text,
          suppressed,
          suppressionReason: suppressed
            ? context === 'orchestrator-status'
              ? 'orchestrator-authored status comment: the loop reporting its own delivered work is not untrusted input'
              : `balanced contextual suppression: ${context} content is evidence/documentation, not a requested action`
            : undefined,
          matchedStatements: [],
        });
      }
    }
  }

  const reasons = [...new Set(incompleteReasons)];
  const complete = reasons.length === 0;
  const statements = [...(policy.config.statements ?? []), ...(policy.profile.statements ?? [])];
  const evaluated = applyStatements(findings, statements, input, authorization);
  const active = evaluated.filter(finding => !finding.suppressed);
  const likelihood = active.reduce((max, finding) => Math.max(max, finding.likelihood ?? 0), 0);
  const impact = active.reduce((max, finding) => Math.max(max, finding.impact ?? 0), 0);
  const score = active.reduce((sum, finding) => sum + (finding.likelihood ?? 0) * (finding.impact ?? 0), 0);
  const severity = active.reduce(
    (highest, finding) => SEVERITY_RANK[finding.severity] > SEVERITY_RANK[highest] ? finding.severity : highest,
    'informational',
  );
  let wouldAction = actionForSeverity(severity, policy.profile.thresholds ?? BUILTIN_PROFILES.balanced.thresholds);
  const mandatory = mandatoryAction(active, input, policy, bounded.parts);
  if (mandatory && ACTION_RANK[mandatory.action] > ACTION_RANK[wouldAction]) wouldAction = mandatory.action;
  if (!complete && ACTION_RANK['require-authorization'] > ACTION_RANK[wouldAction]) {
    wouldAction = 'require-authorization';
  }
  const action = policy.mode === 'audit' ? (active.length ? 'record' : 'proceed') : wouldAction;
  const appliedAction = policy.mode === 'audit' && !complete ? 'record' : action;
  return {
    ...base,
    assessed: true,
    completeness: {
      complete,
      reasons,
      limits: THREAT_ASSESSMENT_LIMITS,
      observed: {
        parts: bounded.observedParts,
        characters: bounded.observedCharacters,
        findings: findings.length,
      },
    },
    findings: evaluated,
    risk: { score, severity, likelihood, impact },
    decision: {
      action: appliedAction,
      wouldAction,
      interrupts: policy.mode === 'enforce' && ['flag', 'require-authorization', 'reject'].includes(appliedAction),
      reason: !complete
        ? `assessment-incomplete: ${reasons.join(', ')}`
        : mandatory?.ruleId ?? (active.length ? `profile threshold selected '${wouldAction}'` : 'no active findings'),
      matchedMandatoryRule: mandatory?.ruleId,
    },
  };
}

function describeSource(finding) {
  const source = finding.source;
  if (!source || typeof source !== 'object') return '';
  const bits = [];
  if (source.author) bits.push(`by ${source.author}`);
  if (source.commentId !== undefined) bits.push(`comment ${source.commentId}`);
  return bits.length ? `; ${bits.join(', ')}` : '';
}

export function formatThreatAssessment(report) {
  const active = report.findings.filter(finding => !finding.suppressed);
  const suppressed = report.findings.filter(finding => finding.suppressed);
  const lines = [
    `Threat-assessment policy: **${report.profile}** / **${report.mode}**`,
    `Decision: **${report.decision.action}** (severity ${report.risk.severity}; would ${report.decision.wouldAction})`,
    '',
    `Policy: schema ${report.policyVersion}, profile ${report.profileVersion}, engine ${report.engineVersion}, hash \`${report.policyHash.slice(0, 12)}\``,
    `Surface: \`${report.surface}\`; source: \`${report.policyProvenance.source}\``,
  ];
  if (!report.completeness.complete) {
    lines.push('', `**Incomplete assessment:** ${report.completeness.reasons.join(', ')}. Manual authorization is required before proceeding.`);
  }
  if (active.length) {
    lines.push('', '**Active findings:**');
    for (const finding of active) {
      lines.push(`- \`${finding.ruleId}\` (${finding.severity}; ${finding.context}${describeSource(finding)}): ${finding.evidence}`);
    }
  }
  if (suppressed.length) {
    lines.push('', '**Contextual findings (non-blocking):**');
    for (const finding of suppressed) {
      lines.push(`- \`${finding.ruleId}\` (${finding.context}${describeSource(finding)}): ${finding.evidence}`);
    }
  }
  lines.push('', `Authorization binding: **${report.authorization.verified ? 'verified' : report.authorization.required ? 'not verified' : 'not required for data consumption'}** at \`${report.authorization.checkpoint}\`.`);
  lines.push('', '_`proceed` is the policy outcome for the assessed action. It does not grant authorization or trust instructions embedded in assessed content. AIWG policy selection does not disable or replace independent provider, platform, authorization, secret-scanning, or repository-action safeguards._');
  return lines.join('\n');
}
