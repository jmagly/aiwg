// Local editorial pattern matching shared by validation and contextual diagnostics.
import { createRequire } from 'node:module';
import type patternData from '../../agentic/code/addons/writing-quality/skills/ai-pattern-detection/references/current-patterns.json';
import { maskProse } from './prose-mask.js';
import { structuralPatterns } from './structural-patterns.js';

const require = createRequire(import.meta.url);
const resource = 'agentic/code/addons/writing-quality/skills/ai-pattern-detection/references/current-patterns.json';
const catalogue: typeof patternData = (() => {
  try { return require(`../../${resource}`); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') throw error;
    return require(`../../../${resource}`); // Compiled dist/src/writing location.
  }
})();

export type PatternTier = 'cut' | 'check' | 'watch';
export interface CurrentPatternFinding {
  scope?: 'file' | 'cross';
  related?: Array<{ documentId: string; line: number }>;
  ruleId: string; tier: PatternTier; start: number; end: number;
  explanation: string; suggestion: string;
}
const compiled = catalogue.rules.map(rule => ({ ...rule, regex: new RegExp(rule.pattern, 'gim') }));
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lexicon = catalogue.lexicon.sets.map(set => ({ ...set,
  regex: new RegExp(`\\b(?:${set.words.map(escape).join('|')})\\b`, 'gi') }));
export const rhetoricalTriad = new RegExp(catalogue.triadPattern, 'gi');
const tokens = (s: string) => s.toLowerCase().match(/[a-z]+(?:['-][a-z]+)*/g) ?? [];

/** Grounding must be near this comparison, rather than anywhere in its sentence. */
function groundedComparison(text: string, start: number, end: number): boolean {
  const words = (s: string) => s.match(/[a-z0-9]+(?:['.-][a-z0-9]+)*/gi) ?? [];
  for (const cue of text.matchAll(/\b(?:because|while|correction|earlier|previously|misconception|you said)\b/gi)) {
    const gap = cue.index! >= end ? text.slice(end, cue.index) : cue.index! + cue[0].length <= start ? text.slice(cue.index! + cue[0].length, start) : '';
    if (!/[;:]/.test(gap) && words(gap).length <= 4) return true;
  }
  const divider = /\brather\s+than\b|\bbut\b|,\s+not\b|^,$/i.exec(text.slice(start, end));
  if (!divider) return false;
  const pivot = start + divider.index;
  const left = words(text.slice(0, pivot).split(/[;:]/).at(-1)!).slice(-6);
  const right = words(text.slice(pivot + divider[0].length).split(/[;:]/)[0]).slice(0, 6);
  return left.some(w => /\d/.test(w)) && right.some(w => /\d/.test(w));
}

export function scanCurrentPatterns(content: string): CurrentPatternFinding[] {
  const prose = maskProse(content).replace(/[‘’]/g, "'");
  const findings: CurrentPatternFinding[] = [];
  const paragraphs = [...prose.matchAll(/\S[^\n]*(?:\n(?!\s*\n)[^\n]+)*/g)];
  const lexical: Array<{ start: number; end: number; tier: PatternTier; hits: number }> = [];
  const emit = (ruleId: string, tier: PatternTier, start: number, end: number, explanation: string, suggestion: string) => {
    findings.push({ ruleId, tier, start, end, explanation, suggestion });
  };
  for (const m of prose.matchAll(rhetoricalTriad)) {
    emit('struct_three_items', 'watch', m.index!, m.index! + m[0].length,
      'Rhetorical three-item predicate detected.', 'Replace generic claims with supported details; retain real inventories.');
  }
  for (const p of paragraphs) {
    const hits = lexicon.flatMap(set => [...p[0].matchAll(set.regex)].map(m => ({ start: p.index! + m.index!, end: p.index! + m.index! + m[0].length, tier: set.tier as PatternTier })));
    hits.sort((a, b) => a.start - b.start);
    if (hits.length) lexical.push({ ...hits[0], tier: hits.some(h => h.tier === 'check') ? 'check' : 'watch', hits: hits.length });
  }
  const total = lexical.reduce((n, p) => n + p.hits, 0);
  for (const p of lexical) if (p.hits >= catalogue.lexicon.paragraphMinHits || total >= catalogue.lexicon.fileMinHits) {
    emit('lexical-cluster', p.tier, p.start, p.end, 'Dated lexical markers cluster in this prose.', 'Replace vague markers with the specific action or fact.');
  }
  // Clause checks retain the existing protected-region boundaries.
  for (const sentence of prose.matchAll(/[^.!?\n\u0001]+(?:[.!?]+|(?=[\n\u0001]|$))/g)) {
    const text = sentence[0];
    const contrast = /\bnot\s+[^.!?;:\n]{1,100}?,?\s+but\b/i.test(text);
    for (const rule of compiled) {
      if (rule.id === 'negate-then-assert' && contrast) continue;
      for (const m of text.matchAll(rule.regex)) {
        if (['contrast-not-but', 'contrast-x-not-y', 'rather-than', 'negate-then-assert'].includes(rule.id) && groundedComparison(text, m.index!, m.index! + m[0].length)) continue;
        const start = sentence.index! + m.index! + m[0].length - m[0].trimStart().length;
        emit(rule.id, rule.tier as PatternTier, start, sentence.index! + m.index! + m[0].length, rule.message, rule.fix);
      }
    }
    for (const comma of text.matchAll(/,/g)) {
      if (groundedComparison(text, comma.index!, comma.index! + 1)) continue;
      const left = tokens(text.slice(0, comma.index)).slice(-3);
      const right = tokens(text.slice(comma.index! + 1)).slice(0, 2);
      if (left.length < 2 || right.length < 2) continue;
      if (catalogue.antonyms.some(([a, b]) => (left.includes(a) && right.includes(b)) || (left.includes(b) && right.includes(a)))) {
        const start = sentence.index! + text.length - text.trimStart().length;
        emit('antithesis-pair', 'cut', start, sentence.index! + text.length, 'Mirrored antonyms across a comma.', 'Keep the fact and drop the mirrored half.');
        break;
      }
    }
  }
  findings.push(...structuralPatterns(prose, catalogue.antonyms));
  return findings.sort((a, b) => a.start - b.start || a.ruleId.localeCompare(b.ruleId));
}

/** Adapt local findings to the existing validation issue contract. */
export function currentPatternIssues(content: string, campaign: CurrentPatternFinding[] = []) {
  const severity = { cut: 'critical', check: 'warning', watch: 'info' } as const;
  // Validation already emits triads through its existing structural rule loader.
  return [...scanCurrentPatterns(content), ...campaign].filter(f => f.ruleId !== 'struct_three_items').map(f => ({
    type: 'formulaic_structure' as const, severity: severity[f.tier], ruleId: f.ruleId,
    tier: f.tier,
    message: f.explanation, suggestion: f.suggestion,
    location: { start: f.start, end: f.end, line: content.slice(0, f.start).split('\n').length,
      column: f.start - content.lastIndexOf('\n', f.start - 1) },
    context: content.slice(f.start, f.end),
    ...(f.scope === 'cross' ? { scope: f.scope, related: f.related } : {}),
  }));
}
