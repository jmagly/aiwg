import { createHash } from 'node:crypto';
import { scanCurrentPatterns, type PatternTier, type CurrentPatternFinding } from './current-patterns.js';
import { modelAssistedPatterns, type WritingJudgmentOptions } from './structural-judgment.js';
import { maskProse, protectedRegions } from './prose-mask.js';
import { scanCampaignPatterns, type CampaignFinding } from './campaign-patterns.js';

/** Offsets use JavaScript UTF-16 code units, so content.slice(start, end) is exact. */
export interface WritingSpan { start: number; end: number }
export type WritingContext = 'prose' | 'code' | 'quote' | 'inventory' | 'checklist' | 'questionnaire' | 'literal';
export interface DiagnosticRule {
  id: string;
  /** Literal phrase matching: user preferences are data, never executable regexes. */
  phrase: string;
  explanation: string;
  suggestion: string;
  authority: 'advisory' | 'user';
  enabled?: boolean;
  tier?: PatternTier;
}
export interface WritingException extends WritingSpan {
  ruleId: string;
  contentHash: string;
  reason: string;
}
export interface ContextualDiagnostic extends WritingSpan {
  scope?: 'file' | 'cross';
  related?: Array<{ documentId: string; line: number }>;
  id: string;
  ruleId: string;
  text: string;
  context: WritingContext;
  explanation: string;
  suggestion: string;
  authority: 'advisory' | 'user';
  /** A heuristic match is not calibrated statistical confidence. */
  confidence: { kind: 'heuristic'; calibrated: false } | { kind: 'model-assisted'; value: number; calibrated: false };
  resolution: 'review' | 'retained';
  reason?: string;
  tier?: PatternTier;
}
export interface DiagnosticOptions {
  /** Compare sentence repetition, eight-word runs and boundary skeletons in a batch. */
  cross?: boolean;
  language?: string;
  rules?: DiagnosticRule[];
  /** Explicit user rules override defaults by ID; disabled rules suppress the default. */
  overrides?: DiagnosticRule[];
  contexts?: Array<WritingSpan & { context: WritingContext }>;
  exceptions?: WritingException[];
  /** Domain terms are exempt from advisory phrase matches, but not explicit user rules. */
  terminology?: string[];
}
export interface ContextualDiagnosticResult {
  schemaVersion: 1;
  contentHash: string;
  language: string;
  offsetEncoding: 'utf-16';
  diagnostics: ContextualDiagnostic[];
  notices: string[];
  publicationGate: false;
}

const DEFAULT_RULES: DiagnosticRule[] = [
  { id: 'phrase:delve', phrase: 'delve', authority: 'advisory', explanation: 'This phrase can be formulaic in general introductions; inspect what the reader needs.', suggestion: 'Retain deliberate usage or state the concrete action.' },
  { id: 'phrase:rich-tapestry', phrase: 'rich tapestry', authority: 'advisory', explanation: 'This metaphor can obscure the subject; literal textile descriptions are valid.', suggestion: 'Retain literal or intentional use, or describe the subject specifically.' },
  { id: 'phrase:in-conclusion', phrase: 'in conclusion', authority: 'advisory', explanation: 'A generic closing transition may repeat an already clear ending.', suggestion: 'Retain when it serves the structure; otherwise end with the useful point.' },
];

export function writingContentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function validSpan(span: WritingSpan, length: number): boolean {
  return Number.isInteger(span.start) && Number.isInteger(span.end) && span.start >= 0 && span.end > span.start && span.end <= length;
}

function protectedContexts(content: string): Array<WritingSpan & { context: WritingContext }> {
  const spans: Array<WritingSpan & { context: WritingContext }> = [];
  let fence: { start: number; marker: string } | undefined;
  for (const line of content.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!line[0]) continue;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)/.exec(line[0]);
    if (!marker) continue;
    if (!fence) fence = { start: line.index!, marker: marker[1] };
    else if (marker[1][0] === fence.marker[0] && marker[1].length >= fence.marker.length && !marker[2].trim()) {
      spans.push({ start: fence.start, end: line.index! + line[0].length, context: 'code' });
      fence = undefined;
    }
  }
  if (fence) spans.push({ start: fence.start, end: content.length, context: 'code' });
  // Preserve arbitrary-length backtick/tilde fences and multiline Markdown quotes.
  const patterns: Array<[WritingContext, RegExp]> = [
    ['code', /(`+)[^\n]*?\1/g],
    ['quote', /^ {0,3}>[^\n]*(?:\n {0,3}>[^\n]*)*/gm],
    ['quote', /“[^”]*”|"[^"\n]+"/g],
    ['checklist', /^\s*[-*+] \[[ xX]\][^\n]*/gm],
    ['inventory', /^\s*(?:[-*+] |\d+[.)] )[^\n]*/gm],
  ];
  for (const [context, pattern] of patterns) {
    for (const match of content.matchAll(pattern)) spans.push({ start: match.index!, end: match.index! + match[0].length, context });
  }
  return spans;
}

function contextAt(span: WritingSpan, contexts: Array<WritingSpan & { context: WritingContext }>, whole = false): WritingContext {
  const matches = contexts.filter(c => whole ? c.start <= span.start && c.end >= span.end : span.start < c.end && span.end > c.start);
  return matches.find(c => c.context === 'code' || c.context === 'quote')?.context ?? matches[0]?.context ?? 'prose';
}

/** Advisory editorial findings, without an authorship score or automatic rewrite. */
export function diagnoseWriting(content: string, options: DiagnosticOptions = {}): ContextualDiagnosticResult {
  return diagnoseDocument(content, options);
}

/** Async callers may request advisory judgments; the synchronous API remains deterministic. */
export async function reviewWritingPatterns(content: string, options: DiagnosticOptions = {}, runtime: WritingJudgmentOptions = {}) {
  const contexts = [...(options.contexts ?? []), ...protectedContexts(content), ...protectedRegions(content)];
  if (contexts.some(s => !validSpan(s, content.length))) throw new Error('Invalid context span');
  const prose = maskProse(content, contexts.filter(c => c.context !== 'prose' && (c.context !== 'quote' || options.contexts?.includes(c))).map(c => ({ ...c, context: 'code' as const })));
  const assisted = (options.language ?? 'en').split('-')[0] === 'en' ? await modelAssistedPatterns(content, runtime, prose) : [];
  return { assisted, result: diagnoseDocument(content, options, undefined, undefined, undefined, assisted) };
}

export async function diagnoseWritingAssisted(content: string, options: DiagnosticOptions = {}, runtime: WritingJudgmentOptions = {}): Promise<ContextualDiagnosticResult> {
  return (await reviewWritingPatterns(content, options, runtime)).result;
}

function diagnoseDocument(content: string, options: DiagnosticOptions, priorParagraphs = new Map<string, string>(), documentId = '', campaign: CampaignFinding[] = [], assisted: CurrentPatternFinding[] = []): ContextualDiagnosticResult {
  const contentHash = writingContentHash(content);
  const language = options.language ?? 'en';
  const notices: string[] = [];
  const diagnostics: ContextualDiagnostic[] = [];
  const contexts = [...(options.contexts ?? []), ...protectedContexts(content), ...protectedRegions(content)];
  if (contexts.some(s => !validSpan(s, content.length))) throw new Error('Invalid context span');
  const rules = new Map<string, DiagnosticRule>();
  if (language.split('-')[0] === 'en') for (const rule of DEFAULT_RULES) rules.set(rule.id, rule);
  else notices.push(`No built-in phrase rules are qualified for ${language}; only explicit rules and exact repetition are inspected.`);
  for (const rule of [...(options.rules ?? []), ...(options.overrides ?? [])]) {
    if (!rule.id || (!rule.phrase.trim() && !rule.id.startsWith('repetition:')) || !rule.explanation.trim() || !rule.suggestion.trim()) throw new Error('Diagnostic rules require an ID, phrase, explanation and suggestion');
    rules.set(rule.id, rule);
  }
  const exceptions = options.exceptions ?? [];
  for (const exception of exceptions) {
    if (exception.contentHash !== contentHash) { notices.push(`Stale exception for ${exception.ruleId}; review it against the current content.`); continue; }
    if (!validSpan(exception, content.length) || !exception.reason.trim()) throw new Error('Exceptions require a valid span and a reason');
  }
  const emit = (span: WritingSpan, rule: DiagnosticRule, context: WritingContext) => {
    const exception = exceptions.find(e => e.contentHash === contentHash && e.ruleId === rule.id && e.start === span.start && e.end === span.end);
    diagnostics.push({ ...span, id: `${rule.id}:${span.start}:${span.end}`, ruleId: rule.id, text: content.slice(span.start, span.end), context,
      explanation: rule.explanation, suggestion: rule.suggestion, authority: rule.authority,
      confidence: { kind: 'heuristic', calibrated: false }, resolution: exception ? 'retained' : 'review', ...(exception ? { reason: exception.reason } : {}), ...(rule.tier ? { tier: rule.tier } : {}) });
  };
  // The shared scanner masks automatic quotations; explicit caller contexts stay protected.
  const current = language.split('-')[0] === 'en' ? scanCurrentPatterns(maskProse(content, contexts.filter(c => c.context !== 'prose' && (c.context !== 'quote' || options.contexts?.includes(c))).map(c => ({ ...c, context: 'code' as const })))) : [];
  for (const f of [...current, ...campaign, ...assisted]) {
    const override = rules.get(f.ruleId);
    if (override?.enabled === false) continue;
    emit(f, override ?? { id: f.ruleId, phrase: '', authority: 'advisory', explanation: f.explanation, suggestion: f.suggestion, tier: f.tier }, 'prose');
    if (f.modelAssisted) diagnostics.at(-1)!.confidence = { kind: 'model-assisted', value: f.confidence!, calibrated: false };
    if ('scope' in f) Object.assign(diagnostics.at(-1)!, { scope: f.scope, related: f.related });
  }
  for (const rule of rules.values()) {
    if (rule.enabled === false || rule.id.startsWith('repetition:')) continue;
    const escaped = rule.phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'giu');
    for (const match of content.matchAll(pattern)) {
      const span = { start: match.index!, end: match.index! + match[0].length };
      const context = contextAt(span, contexts);
      if (current.some(f => f.ruleId === rule.id && span.start < f.end && span.end > f.start)) continue;
      if (context === 'code' || context === 'quote') continue;
      if (rule.authority === 'advisory' && (context !== 'prose' || options.terminology?.some(t => t.toLocaleLowerCase() === match[0].toLocaleLowerCase()))) continue;
      if (rule.authority === 'advisory' && ['phrase:delve', 'phrase:rich-tapestry'].includes(rule.id)) {
        const paragraphStart = content.lastIndexOf('\n\n', span.start);
        if (current.some(f => f.ruleId === 'lexical-cluster' && content.lastIndexOf('\n\n', f.start) === paragraphStart)) continue;
        const paragraph = content.slice(paragraphStart < 0 ? 0 : paragraphStart + 2, content.indexOf('\n\n', span.end) < 0 ? content.length : content.indexOf('\n\n', span.end));
        if (rule.id === 'phrase:rich-tapestry' && /\b(?:textile|woven|weaving|cloth|fabric|border)\b/i.test(paragraph)) continue;
      }
      emit(span, rule, context);
    }
  }
  // Exact paragraph repetition is reviewable even when separated by other paragraphs.
  const seen = new Set<string>();
  const repetitionRule: DiagnosticRule = { id: 'repetition:paragraph', phrase: '', authority: 'advisory', explanation: 'This paragraph repeats earlier prose verbatim; repetition may be intentional.', suggestion: 'Retain necessary repetition with a reason, or remove redundant prose.' };
  const repetitionOverride = rules.get(repetitionRule.id);
  if (repetitionOverride?.enabled !== false) for (const match of content.matchAll(/\S[^\n]*(?:\n(?!\s*\n)[^\n]+)*/g)) {
    const text = match[0].trim();
    const span = { start: match.index!, end: match.index! + match[0].length };
    if (contextAt(span, contexts, true) !== 'prose') continue;
    const priorDocument = priorParagraphs.get(text);
    const coveredByCampaign = campaign.some(f => f.ruleId === 'repeated-sentence' && f.start >= span.start && f.end <= span.end);
    if (!coveredByCampaign && (seen.has(text) || priorDocument !== undefined)) emit(span, repetitionOverride ?? { ...repetitionRule, explanation: priorDocument !== undefined && priorDocument !== documentId ? `This paragraph also occurs in document ${priorDocument}; repetition may be intentional.` : repetitionRule.explanation }, 'prose');
    seen.add(text);
    if (priorDocument === undefined) priorParagraphs.set(text, documentId);
  }
  const wordRule: DiagnosticRule = { id: 'repetition:word', phrase: '', authority: 'advisory', explanation: 'An adjacent word repeats; grammar or emphasis may require it.', suggestion: 'Retain deliberate repetition with a reason, or remove an accidental duplicate.' };
  const wordOverride = rules.get(wordRule.id);
  if (wordOverride?.enabled !== false) for (const match of content.matchAll(/(?<![\p{L}\p{M}\p{N}_])(\p{L}[\p{L}\p{M}]*)[ \t]+\1(?![\p{L}\p{M}\p{N}_])/giu)) {
    const span = { start: match.index!, end: match.index! + match[0].length };
    if (contextAt(span, contexts) === 'prose') emit(span, wordOverride ?? wordRule, 'prose');
  }
  diagnostics.sort((a, b) => a.start - b.start || a.end - b.end || a.ruleId.localeCompare(b.ruleId));
  return { schemaVersion: 1, contentHash, language, offsetEncoding: 'utf-16', diagnostics, notices: [...new Set(notices)], publicationGate: false };
}

/** Cross-document exact paragraph repetition; document IDs must be unique. */
export function diagnoseWritingBatch(documents: Array<{ id: string; content: string }>, options: DiagnosticOptions = {}): Map<string, ContextualDiagnosticResult> {
  const results = new Map<string, ContextualDiagnosticResult>();
  const seen = new Map<string, string>();
  const campaign = options.cross ? scanCampaignPatterns(documents.map(d => ({ ...d, content: maskProse(d.content, (options.contexts ?? []).filter(c => c.context !== 'prose').map(c => ({ ...c, context: 'code' as const }))) }))) : undefined;
  for (const document of documents) {
    if (results.has(document.id)) throw new Error(`Duplicate document ID: ${document.id}`);
    const result = diagnoseDocument(document.content, options, seen, document.id, campaign?.get(document.id));
    results.set(document.id, result);
  }
  return results;
}

/** Keep deterministic campaign findings while adding local advisory judgments once per document. */
export async function diagnoseWritingBatchAssisted(documents: Array<{ id: string; content: string }>, options: DiagnosticOptions = {}, runtime: WritingJudgmentOptions = {}): Promise<Map<string, ContextualDiagnosticResult>> {
  const results = diagnoseWritingBatch(documents, options);
  for (const document of documents) {
    const assisted = (await diagnoseWritingAssisted(document.content, options, runtime)).diagnostics.filter(f => f.confidence.kind === 'model-assisted');
    results.get(document.id)!.diagnostics.push(...assisted);
    results.get(document.id)!.diagnostics.sort((a, b) => a.start - b.start || a.end - b.end || a.ruleId.localeCompare(b.ruleId));
  }
  return results;
}
