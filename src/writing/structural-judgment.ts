// Promote loose structural candidates only after a confident advisory decision.
import { createRequire } from 'node:module';
import { askDecision, type DecisionAskRuntimeOptions } from '../decision/ask.js';
import { scanCurrentPatterns, type CurrentPatternFinding } from './current-patterns.js';
import { maskProse } from './prose-mask.js';
import { structuralCandidates } from './structural-patterns.js';
import type judgmentData from './structural-judgment.catalogue.json';

const rules: Record<keyof typeof judgmentData, { question: string; tier: CurrentPatternFinding['tier']; suggestion: string }> =
  createRequire(import.meta.url)('./structural-judgment.catalogue.json');

/** Runtime injection uses the existing decision engine settings; no writing config. */
export interface WritingJudgmentOptions extends DecisionAskRuntimeOptions {
  ask?: typeof askDecision;
  threshold?: number;
}

export async function modelAssistedPatterns(content: string, options: WritingJudgmentOptions = {}, prose = maskProse(content)): Promise<CurrentPatternFinding[]> {
  if ((options.env ?? process.env).AIWG_DECISION_ENABLED === '0') return [];
  const deterministic = scanCurrentPatterns(content);
  const findings: CurrentPatternFinding[] = [];
  const threshold = options.threshold ?? 0.8;
  for (const candidate of structuralCandidates(prose)) {
    if (deterministic.some(f => f.ruleId === candidate.ruleId && f.start <= candidate.start && f.end >= candidate.end)) continue;
    const rule = rules[candidate.ruleId];
    const section = [...content.slice(0, candidate.start).matchAll(/^ {0,3}#{1,6}\s+([^\n]+)/gm)].at(-1)?.[1].slice(0, 200) ?? '';
    try {
      const decision = await (options.ask ?? askDecision)({ question: rule.question, mode: { kind: 'yes-no' },
        context: JSON.stringify({ pattern: candidate.ruleId, excerpt: candidate.excerpt, paragraph: candidate.paragraph, section }), threshold },
      { ...options, cwd: options.cwd ?? process.cwd() });
      if (decision.status !== 'answered' || decision.answer !== true || typeof decision.confidence !== 'number'
        || !Number.isFinite(decision.confidence) || decision.confidence < threshold || decision.confidence > 1) continue;
      findings.push({ ruleId: candidate.ruleId, tier: rule.tier, start: candidate.start, end: candidate.end,
        explanation: `Model-assisted advisory review: ${rule.question} (confidence ${decision.confidence}).`,
        suggestion: rule.suggestion, modelAssisted: true, confidence: decision.confidence });
    } catch { /* Unavailable judgment leaves deterministic behavior intact. */ }
  }
  return findings;
}
