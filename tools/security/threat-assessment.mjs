import { createHash } from 'node:crypto';

export const THREAT_ASSESSMENT_SCHEMA_VERSION = '1';
export const THREAT_ASSESSMENT_ENGINE_VERSION = '1.2.0';

/**
 * Hard scan bounds keep assessment work deterministic. Reaching any bound is
 * reported as an incomplete assessment and can never silently produce a
 * proceed decision in audit/enforce mode.
 */
export const THREAT_ASSESSMENT_LIMITS = Object.freeze({
  maxInputCharacters: 262_144,
  maxParts: 128,
  maxOccurrencesPerPattern: 128,
  maxFindings: 2_048,
  maxCustomRules: 64,
  maxPatternsPerRule: 32,
});

export const THREAT_SURFACES = [
  'issue-title',
  'issue-body',
  'issue-comment',
  'pull-request-title',
  'pull-request-body',
  'pull-request-diff-summary',
  'review-comment',
  'release-note',
  'handoff',
  'outbound-maintainer-comment',
];

export const SEVERITIES = ['informational', 'low', 'moderate', 'high', 'critical'];
export const ACTIONS = ['proceed', 'record', 'flag', 'require-authorization', 'reject'];

const CONSUMPTION_ACTION = /^(?:consume-as-data|read|read-only|summari[sz]e|review-evidence|discuss(?:-[\w-]+)?|document(?:-[\w-]+)?)$/i;

const SEVERITY_RANK = Object.fromEntries(SEVERITIES.map((name, index) => [name, index]));
const ACTION_RANK = Object.fromEntries(ACTIONS.map((name, index) => [name, index]));
const BUILTIN_PACK_PREFIX = 'aiwg:';

const BUILTIN_RULES = [
  {
    id: 'claimed-authorization',
    severity: 'moderate',
    likelihood: 4,
    impact: 4,
    taxonomy: ['ASI01', 'ASI09'],
    patterns: [
      '\\b(?:i|we)\\s+(?:have\\s+)?(?:reviewed|checked|accepted|approved|authorized|authorised|signed[ -]off)(?:\\s+and)?(?:\\s+(?:approve|authorize|authorise|accept))?\\b',
      '\\b(?:i|we)\\s+(?:approve|authorize|authorise|accept|sign[ -]off)\\b',
      '\\b(?:design|plan|specification|implementation|change|handoff)\\s+(?:is|was|has been)\\s+(?:approved|authorized|authorised|accepted|signed[ -]off|cleared)\\b',
      '\\b(?:approval|authorization|authorisation|sign[ -]off)\\s+(?:is|was|has been)\\s+(?:given|granted|completed|confirmed)\\b',
      '\\b(?:approved|authorized|authorised|signed[ -]off|cleared)\\s+by\\s+[\\w@.-]+\\b',
      '\\b(?:prior|previous|earlier)\\s+(?:approval|authorization|authorisation|sign[ -]off)\\b',
    ],
  },
  {
    id: 'instruction-override',
    severity: 'high',
    likelihood: 4,
    impact: 4,
    taxonomy: ['ASI01', 'ASI09'],
    patterns: [
      '\\bignore (all )?(previous|prior|above) instructions\\b',
      '\\b(system|developer) (prompt|message|instructions?)\\b',
      '\\bdo not (tell|inform|notify) (the )?(maintainer|operator|user)\\b',
      '\\byou are now\\b',
    ],
  },
  {
    id: 'sensitive-file-target',
    severity: 'moderate',
    likelihood: 3,
    impact: 4,
    taxonomy: ['ASI03', 'ASI04', 'ASI05'],
    patterns: [
      '\\b(AGENTS|CLAUDE|AIWG|WARP)\\.md\\b',
      '\\b(MCP|mcp) config\\b',
      '\\.github/workflows/|\\.gitea/workflows/|workflow[s]?\\.ya?ml',
      '\\bagent definitions?\\b',
      '\\brules/RULES-INDEX\\.md\\b',
    ],
  },
  {
    id: 'third-party-execution',
    severity: 'high',
    likelihood: 4,
    impact: 4,
    taxonomy: ['ASI02', 'ASI04', 'ASI05'],
    patterns: [
      '\\bnpx\\s+[-@\\w./]+',
      '\\bnpm\\s+(install|i|exec)\\s+[-@\\w./]+',
      '\\bpipx?\\s+install\\s+[-\\w./]+',
      '\\bcargo\\s+install\\s+[-\\w./]+',
      '\\bcurl\\b[^|\\n]*\\|\\s*(sh|bash|zsh)\\b',
      '\\bbash\\s+<\\(\\s*curl\\b',
      '\\bgit\\+https?://',
    ],
  },
  {
    id: 'floating-version',
    severity: 'moderate',
    likelihood: 3,
    impact: 3,
    taxonomy: ['ASI04'],
    patterns: [
      '@latest\\b',
      'uses:\\s*[-\\w./]+@(main|master|latest|v?\\d+)\\b',
      'image:\\s*[-\\w./:]+:latest\\b',
      '\\b(unpinned|floating) (dependency|version|action|container)\\b',
    ],
  },
  {
    id: 'credential-or-env-probing',
    severity: 'high',
    likelihood: 4,
    impact: 5,
    taxonomy: ['ASI03', 'ASI09'],
    patterns: [
      '\\b(printenv|env\\s*\\||env\\s*$|process\\.env|os\\.environ)\\b',
      '\\.env\\b',
      '\\b(api[_-]?keys?|secrets?|cookies?|document\\.cookie|credentials?|authentication material)\\b',
      '\\b(?:api|access|auth(?:entication)?|bearer|session|refresh|oauth|jwt|signing|github|gitea|cloud)(?:[_-]?\\s*)tokens?\\b',
      '\\b(id_rsa|ssh keys?|gpg keys?|aws_access_key|cloud credentials?)\\b',
    ],
  },
  {
    id: 'pressure-without-evidence',
    severity: 'low',
    likelihood: 2,
    impact: 2,
    taxonomy: ['ASI09'],
    patterns: [
      '\\b(blocking release|urgent|must be done|priority:\\s*high|critical security|do this now)\\b',
      '\\bsecurity critical\\b',
    ],
  },
  {
    id: 'unverifiable-authority-claim',
    severity: 'low',
    likelihood: 2,
    impact: 3,
    taxonomy: ['ASI01', 'ASI09'],
    patterns: [
      '\\bP-\\d{4}-\\d{3,}\\b',
      '\\bpolicy\\s+[A-Z]-?\\d{3,}\\b',
      '\\bhex\\s+[0-9a-f]{6,12}\\b',
      '\\bCVE-\\d{4}-\\d{4,}\\b(?![\\s\\S]{0,160}https?://)',
      '\\b(advisory|standard|RFC)\\b(?![\\s\\S]{0,160}https?://)',
    ],
  },
  {
    id: 'security-framing-conflict',
    severity: 'moderate',
    likelihood: 3,
    impact: 4,
    taxonomy: ['ASI04', 'ASI09'],
    patterns: [
      '\\b(improve|fix|harden|secure|audit).{0,120}\\b(npx\\b|@latest\\b|curl\\b[^|\\n]*\\||printenv|\\.env)\\b',
      '\\b(security|secure).{0,120}\\b(add|install|run).{0,80}\\b(latest|remote|third[- ]party)\\b',
    ],
  },
];

const BUILTIN_PACKS = Object.freeze({
  'aiwg:prompt-injection': ['instruction-override', 'pressure-without-evidence', 'unverifiable-authority-claim'],
  'aiwg:supply-chain': ['sensitive-file-target', 'third-party-execution', 'floating-version', 'security-framing-conflict'],
  'aiwg:credential-protection': ['credential-or-env-probing'],
  'aiwg:all': BUILTIN_RULES.map(rule => rule.id),
});

export const BUILTIN_PROFILES = Object.freeze({
  trusted: {
    version: '1.0.0',
    mode: 'off',
    description: 'Explicitly disables the AIWG classifier. Independent provider/platform safeguards remain active.',
    ruleSets: [],
    thresholds: { requireAuthorization: 'critical', reject: 'critical' },
  },
  audit: {
    version: '1.0.0',
    mode: 'audit',
    description: 'Records balanced findings without interrupting work.',
    ruleSets: ['aiwg:all'],
    thresholds: { flag: 'moderate', requireAuthorization: 'high', reject: 'critical' },
  },
  balanced: {
    version: '1.0.0',
    mode: 'enforce',
    description: 'Backward-compatible default with contextual false-positive suppression.',
    ruleSets: ['aiwg:all'],
    thresholds: { flag: 'moderate', requireAuthorization: 'high', reject: 'critical' },
  },
  strict: {
    version: '1.0.0',
    mode: 'enforce',
    description: 'Requires authorization at moderate severity and rejects critical findings.',
    ruleSets: ['aiwg:all'],
    thresholds: { flag: 'low', requireAuthorization: 'moderate', reject: 'critical' },
  },
  'high-assurance': {
    version: '1.0.0',
    mode: 'enforce',
    description: 'Rejects high/critical findings and requires authorization at moderate severity.',
    ruleSets: ['aiwg:all'],
    thresholds: { flag: 'low', requireAuthorization: 'moderate', reject: 'high' },
  },
});

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

function validatePattern(pattern, where, errors) {
  if (typeof pattern !== 'string' || pattern.length === 0 || pattern.length > 500) {
    errors.push(`${where}: must be a non-empty regex string no longer than 500 characters`);
    return;
  }
  try {
    new RegExp(pattern, 'imu');
  } catch (error) {
    errors.push(`${where}: invalid regular expression (${error.message})`);
  }
  if (/\\[1-9]/.test(pattern) || /\(\?<([=!])/.test(pattern)
    || /\([^)]*[+*][^)]*\)[+*{]/.test(pattern) || /(?:\.\*){2,}/.test(pattern)) {
    errors.push(`${where}: unsafe regex construct (backreference, lookbehind, or nested unbounded quantifier)`);
  }
}

function validateStatement(statement, where, errors) {
  if (!isObject(statement)) {
    errors.push(`${where}: must be an object`);
    return;
  }
  if (typeof statement.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(statement.id)) {
    errors.push(`${where}.id: must be a kebab-case identifier`);
  }
  if (!['suppress', 'set-severity'].includes(statement.effect)) {
    errors.push(`${where}.effect: must be suppress or set-severity`);
  }
  if (typeof statement.reason !== 'string' || !statement.reason.trim()) {
    errors.push(`${where}.reason: must be a non-empty string`);
  }
  if (statement.signals !== undefined
    && (!Array.isArray(statement.signals) || !statement.signals.every(signal => typeof signal === 'string'))) {
    errors.push(`${where}.signals: must be an array of strings`);
  }
  if (statement.effect === 'suppress') {
    if (!statement.signals?.length) errors.push(`${where}.signals: suppress statements must name at least one signal`);
    const when = statement.when;
    if (!isObject(when) || !Object.values(when).some(value => Array.isArray(value) && value.length)) {
      errors.push(`${where}.when: suppress statements require at least one narrow condition`);
    }
    if (!isObject(statement.riskAcceptance)
      || typeof statement.riskAcceptance.acceptedBy !== 'string'
      || typeof statement.riskAcceptance.rationale !== 'string') {
      errors.push(`${where}.riskAcceptance: suppress statements require acceptedBy and rationale`);
    }
  }
  if (statement.effect === 'set-severity' && !SEVERITIES.includes(statement.severity)) {
    errors.push(`${where}.severity: set-severity requires a known severity`);
  }
}

export function validateThreatAssessmentConfig(value) {
  const errors = [];
  if (value === undefined || value === null) return errors;
  if (!isObject(value)) return ['security.threatAssessment: must be an object'];
  if (value.schemaVersion !== undefined && value.schemaVersion !== '1') {
    errors.push("security.threatAssessment.schemaVersion: must be '1'");
  }
  if (value.mode !== undefined && !['off', 'audit', 'enforce'].includes(value.mode)) {
    errors.push('security.threatAssessment.mode: must be off, audit, or enforce');
  }
  if (value.defaultProfile !== undefined && typeof value.defaultProfile !== 'string') {
    errors.push('security.threatAssessment.defaultProfile: must be a string');
  }
  if (value.surfaces !== undefined) {
    if (!isObject(value.surfaces)) errors.push('security.threatAssessment.surfaces: must be an object');
    else {
      for (const [surface, entry] of Object.entries(value.surfaces)) {
        if (!THREAT_SURFACES.includes(surface)) {
          errors.push(`security.threatAssessment.surfaces.${surface}: unknown surface`);
          continue;
        }
        if (!isObject(entry)) {
          errors.push(`security.threatAssessment.surfaces.${surface}: must be an object`);
          continue;
        }
        if (entry.mode !== undefined && !['off', 'audit', 'enforce'].includes(entry.mode)) {
          errors.push(`security.threatAssessment.surfaces.${surface}.mode: must be off, audit, or enforce`);
        }
      }
    }
  }
  if (value.rulePacks !== undefined) {
    if (!isObject(value.rulePacks)) errors.push('security.threatAssessment.rulePacks: must be an object');
    else {
      let customRuleCount = 0;
      for (const [name, pack] of Object.entries(value.rulePacks)) {
        const where = `security.threatAssessment.rulePacks.${name}`;
        if (name.startsWith(BUILTIN_PACK_PREFIX)) errors.push(`${where}: project rule packs cannot shadow aiwg: built-ins`);
        if (!isObject(pack) || !Array.isArray(pack.rules)) {
          errors.push(`${where}.rules: must be an array`);
          continue;
        }
        customRuleCount += pack.rules.length;
        if (typeof pack.version !== 'string' || !pack.version.trim()) {
          errors.push(`${where}.version: must be a non-empty string`);
        }
        const ids = new Set();
        pack.rules.forEach((rule, index) => {
          const ruleWhere = `${where}.rules[${index}]`;
          if (!isObject(rule)) {
            errors.push(`${ruleWhere}: must be an object`);
            return;
          }
          if (typeof rule.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(rule.id)) {
            errors.push(`${ruleWhere}.id: must be a kebab-case identifier`);
          } else if (BUILTIN_RULES.some(builtin => builtin.id === rule.id)) {
            errors.push(`${ruleWhere}.id: cannot shadow built-in rule '${rule.id}'`);
          } else if (ids.has(rule.id)) {
            errors.push(`${ruleWhere}.id: duplicate '${rule.id}'`);
          } else ids.add(rule.id);
          if (!SEVERITIES.includes(rule.severity)) errors.push(`${ruleWhere}.severity: unknown severity`);
          for (const dimension of ['likelihood', 'impact']) {
            if (rule[dimension] !== undefined
              && (!Number.isInteger(rule[dimension]) || rule[dimension] < 1 || rule[dimension] > 5)) {
              errors.push(`${ruleWhere}.${dimension}: must be an integer from 1 to 5`);
            }
          }
          if (!Array.isArray(rule.patterns) || rule.patterns.length === 0) {
            errors.push(`${ruleWhere}.patterns: must be a non-empty array`);
          } else if (rule.patterns.length > THREAT_ASSESSMENT_LIMITS.maxPatternsPerRule) {
            errors.push(`${ruleWhere}.patterns: cannot exceed ${THREAT_ASSESSMENT_LIMITS.maxPatternsPerRule} patterns`);
          } else rule.patterns.forEach((pattern, patternIndex) =>
            validatePattern(pattern, `${ruleWhere}.patterns[${patternIndex}]`, errors));
        });
      }
      if (customRuleCount > THREAT_ASSESSMENT_LIMITS.maxCustomRules) {
        errors.push(`security.threatAssessment.rulePacks: cannot exceed ${THREAT_ASSESSMENT_LIMITS.maxCustomRules} custom rules`);
      }
    }
  }
  const profiles = value.profiles ?? {};
  if (!isObject(profiles)) errors.push('security.threatAssessment.profiles: must be an object');
  else {
    const visit = (name, stack = []) => {
      if (stack.includes(name)) {
        errors.push(`security.threatAssessment.profiles.${name}.extends: cyclic inheritance (${[...stack, name].join(' -> ')})`);
        return;
      }
      const profile = profiles[name];
      if (!isObject(profile)) return;
      const parents = profile.extends ?? [];
      if (!Array.isArray(parents)) {
        errors.push(`security.threatAssessment.profiles.${name}.extends: must be an array`);
        return;
      }
      for (const parent of parents) {
        if (!(parent in profiles) && !(parent in BUILTIN_PROFILES) && !String(parent).startsWith('aiwg:')) {
          errors.push(`security.threatAssessment.profiles.${name}.extends: unknown profile '${parent}'`);
        }
        const local = String(parent).replace(/^aiwg:/, '');
        if (local in profiles) visit(local, [...stack, name]);
      }
    };
      for (const [name, profile] of Object.entries(profiles)) {
      const where = `security.threatAssessment.profiles.${name}`;
      if (!isObject(profile)) {
        errors.push(`${where}: must be an object`);
        continue;
      }
      if (name in BUILTIN_PROFILES || name.startsWith(BUILTIN_PACK_PREFIX)) {
        errors.push(`${where}: project profiles cannot shadow built-in profiles`);
      }
      if (profile.mode !== undefined && !['off', 'audit', 'enforce'].includes(profile.mode)) {
        errors.push(`${where}.mode: must be off, audit, or enforce`);
      }
      if (profile.version !== undefined && (typeof profile.version !== 'string' || !profile.version.trim())) {
        errors.push(`${where}.version: must be a non-empty string`);
      }
      if (profile.ruleSets !== undefined) {
        if (!Array.isArray(profile.ruleSets) || !profile.ruleSets.every(pack => typeof pack === 'string')) {
          errors.push(`${where}.ruleSets: must be an array of strings`);
        } else {
          for (const pack of profile.ruleSets) {
            if (!BUILTIN_PACKS[pack] && !value.rulePacks?.[pack]) {
              errors.push(`${where}.ruleSets: unavailable rule pack '${pack}'`);
            }
          }
        }
      }
      if (profile.statements !== undefined) {
        if (!Array.isArray(profile.statements)) errors.push(`${where}.statements: must be an array`);
        else profile.statements.forEach((statement, index) =>
          validateStatement(statement, `${where}.statements[${index}]`, errors));
      }
      for (const [threshold, severity] of Object.entries(profile.thresholds ?? {})) {
        if (!['flag', 'requireAuthorization', 'reject'].includes(threshold) || !SEVERITIES.includes(severity)) {
          errors.push(`${where}.thresholds.${threshold}: must use a known action threshold and severity`);
        }
      }
      visit(name);
    }
  }
  const defaultName = value.defaultProfile ?? 'balanced';
  if (!(defaultName in BUILTIN_PROFILES) && !(defaultName in profiles)) {
    errors.push(`security.threatAssessment.defaultProfile: unknown profile '${defaultName}'`);
  }
  if (value.statements !== undefined) {
    if (!Array.isArray(value.statements)) errors.push('security.threatAssessment.statements: must be an array');
    else value.statements.forEach((statement, index) =>
      validateStatement(statement, `security.threatAssessment.statements[${index}]`, errors));
  }
  return Array.from(new Set(errors));
}

function mergeProfile(base, extension) {
  return {
    ...base,
    ...extension,
    thresholds: { ...(base.thresholds ?? {}), ...(extension.thresholds ?? {}) },
    ruleSets: extension.ruleSets ?? base.ruleSets ?? [],
    statements: [...(base.statements ?? []), ...(extension.statements ?? [])],
  };
}

function resolveProfile(name, config, stack = []) {
  const builtinName = String(name).replace(/^aiwg:/, '');
  if (BUILTIN_PROFILES[builtinName]) return structuredClone(BUILTIN_PROFILES[builtinName]);
  if (stack.includes(name)) throw new Error(`Cyclic threat-assessment profile inheritance: ${[...stack, name].join(' -> ')}`);
  const raw = config.profiles?.[name];
  if (!raw) throw new Error(`Unknown threat-assessment profile '${name}'`);
  let resolved = {};
  for (const parent of raw.extends ?? ['aiwg:balanced']) {
    resolved = mergeProfile(resolved, resolveProfile(parent, config, [...stack, name]));
  }
  return mergeProfile(resolved, raw);
}

export function resolveThreatAssessmentPolicy(rawConfig, surface) {
  const config = rawConfig ?? {};
  const errors = validateThreatAssessmentConfig(config);
  if (errors.length) throw new Error(`Invalid threat-assessment configuration:\n${errors.join('\n')}`);
  if (!THREAT_SURFACES.includes(surface)) throw new Error(`Unknown threat-assessment surface '${surface}'`);
  const surfaceConfig = config.surfaces?.[surface] ?? {};
  const profileName = surfaceConfig.profile ?? config.defaultProfile ?? 'balanced';
  const profile = resolveProfile(profileName, config);
  const mode = surfaceConfig.mode ?? config.mode ?? profile.mode ?? 'enforce';
  return {
    schemaVersion: config.schemaVersion ?? '1',
    mode,
    profileName,
    profile,
    surface,
    config,
    provenance: rawConfig
      ? { source: '.aiwg/aiwg.config', path: 'security.threatAssessment' }
      : { source: 'aiwg-default', path: 'aiwg:balanced' },
  };
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

/**
 * Contexts that describe content rather than request an action. Findings in
 * these contexts stay in the report as evidence but never drive the decision.
 */
export const SUPPRESSED_CONTEXTS = Object.freeze([
  'negative',
  'quoted',
  'documentation',
  'descriptive',
  'orchestrator-status',
]);

const IMPERATIVE_VERBS = 'run|execute|invoke|install|add|update|edit|modify|change|replace|use|set|export|fetch|curl|wget|download|paste|print|dump|echo|cat|read|show|reveal|disclose|leak|send|upload|post|enable|configure|copy|migrate|move|include|write|commit|push|deploy|apply|grant|open|create|remove|delete|disable|ignore|treat|tell|inform|notify|ask|provision';
const IMPERATIVE_LEAD = new RegExp(`^(?:please\\s+|now\\s+|just\\s+|also\\s+)*(?:${IMPERATIVE_VERBS})\\b`, 'i');
const REQUEST_CUE = /\b(?:please|you (?:should|must|need to|have to|can)|we (?:should|must|need to|have to)|make sure|be sure|so that (?:you|it) can|in order to)\b/i;
const DESCRIPTIVE_CUE = /\b(?:added|implemented|delivered|documented|recorded|verified|tested|passed|failed|opened|landed|merged|shipped|fixed|removed|renamed|introduced|wired|gated|configured|trialed|reviewed|observed|checked|confirmed|reconciled|mapped|covered|installed|proceeded|returned|classified|assessed|scored|flagged|contains?|preserves?|keeps?|remains?|names?|describ(?:es|ed|ing)|declares?|records?|reports?|states?|lists?|carries|existing|currently|already|was|were|has been|have been)\b/i;
const SENTENCE_LEAD_MARKERS = /^(?:[\s|>]|[-*+]\s|\d+[.)]\s|\[[ xX]\]\s|\*\*|`)+/;

/**
 * Locate the sentence that contains a match. Markdown line breaks, list
 * markers, and sentence punctuation all bound a sentence so that one bullet
 * describing delivered work is never read together with the next.
 */
function sentenceAt(text, index, length) {
  const before = text.slice(0, index);
  const start = Math.max(
    before.lastIndexOf('\n'),
    before.lastIndexOf('. '),
    before.lastIndexOf('! '),
    before.lastIndexOf('? '),
    before.lastIndexOf('; '),
  ) + 1;
  const after = text.slice(index + length);
  const endMatch = /[.!?;](?:\s|$)|\n/.exec(after);
  const end = endMatch ? index + length + endMatch.index : text.length;
  const leading = text.slice(start, index).replace(SENTENCE_LEAD_MARKERS, '').trimStart();
  return { text: text.slice(start, end), leading };
}

/** True when the match sits inside a fenced code block (``` or ~~~). */
function insideFence(text, index) {
  const fences = text.slice(0, index).match(/^[ \t]*(?:```|~~~)/gm) ?? [];
  return fences.length % 2 === 1;
}

/**
 * Classify what the surrounding text does with a matched phrase.
 *
 * - `quoted`: block quotes, fenced code, or text introduced as evidence.
 * - `negative`: a prohibition or boundary statement.
 * - `requested`: an imperative or request that names the phrase as something
 *   to do (the only context that drives the decision).
 * - `descriptive`: a report about work that already happened or state that
 *   already exists (an AL CYCLE status line, a reconciliation note). These
 *   mention credentials, env gates, or launchers without asking for anything.
 */
/**
 * True when the match is glued to a hyphenated identifier on either side
 * (`credential-or-env-probing`, `launch-cookie`). `\\b` treats the hyphen as
 * a boundary, but a request names "the cookies", never "launch-cookie".
 */
function insideHyphenatedIdentifier(text, index, length) {
  const before = text[index - 1];
  const after = text[index + length];
  const wordBefore = index >= 2 && before === '-' && /\w/.test(text[index - 2]);
  const wordAfter = after === '-' && /\w/.test(text[index + length + 1] ?? '');
  return wordBefore || wordAfter;
}

function inferContext(text, index, explicit, length = 0) {
  if (explicit) return explicit;
  if (insideFence(text, index)) return 'quoted';
  if (length > 0 && insideHyphenatedIdentifier(text, index, length)) return 'documentation';
  const before = text.slice(Math.max(0, index - 120), index).toLowerCase();
  const wider = text.slice(Math.max(0, index - 400), index);
  const lineStart = text.lastIndexOf('\n', index) + 1;
  const line = text.slice(lineStart, index).trimStart();
  if (/^(>|```)/.test(line) || /(?:quoted|example|evidence|documentation)\s*[:\-]?\s*$/i.test(before)) return 'quoted';
  // An evidence cue followed by a quotation mark that has not closed yet:
  //   evidence: "Run X with current cookies; ..."  -> the match sits inside the quote.
  if (/(?:quoted|quote|example|evidence)\s*[:\-]?\s*["\u201c][^"\u201d]*$/i.test(wider)) return 'quoted';
  const sentence = sentenceAt(text, index, length);
  const localPrefix = `${sentence.leading} ${text.slice(index, index + length)}`.toLowerCase();
  if (/(?:must not|do not|don't|never|avoid|prevent|forbid|out[- ]of[- ]scope|warning against|without)\b[^.!?\n]{0,100}$/i.test(localPrefix)
    || /\bno\s+(?:[\w-]+\s+){0,3}$/i.test(localPrefix)) {
    // "no model credentials needed", "no secret was accessed": a bare "no"
    // within three words of the match negates it; "no" further back does not.
    return 'negative';
  }
  if (IMPERATIVE_LEAD.test(sentence.leading) || REQUEST_CUE.test(sentence.leading)) return 'requested';
  if (DESCRIPTIVE_CUE.test(sentence.text)) return 'descriptive';
  return 'requested';
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

function mandatoryAction(activeFindings) {
  const ids = new Set(activeFindings.map(finding => finding.ruleId));
  if (ids.has('claimed-authorization')) {
    return { action: 'require-authorization', ruleId: 'mandatory:claimed-authorization-adoption' };
  }
  const credentialCombination = ids.has('credential-or-env-probing')
    && (ids.has('instruction-override') || ids.has('third-party-execution') || ids.has('sensitive-file-target'));
  const supplyChainCombination = ids.has('third-party-execution')
    && (ids.has('floating-version') || ids.has('sensitive-file-target') || ids.has('security-framing-conflict'));
  if (credentialCombination || supplyChainCombination) {
    return {
      action: 'reject',
      ruleId: credentialCombination ? 'mandatory:credential-exfiltration-combination' : 'mandatory:supply-chain-execution-combination',
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
        const context = inferContext(part.text, match.index, part.context, match[0].length);
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
  const mandatory = mandatoryAction(active);
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
