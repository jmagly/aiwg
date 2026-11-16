// Compare prose sentences and opening/closing forms within one explicit campaign set.
import { maskProse } from './prose-mask.js';
import { proseParagraphs, stopWords, words, type ProseSentence } from './structural-patterns.js';
import type { CurrentPatternFinding, PatternTier } from './current-patterns.js';

interface SentenceRecord extends ProseSentence { document: WritingDocument; key: string; line: number }
export interface WritingDocument { id: string; content: string }
export interface CampaignFinding extends CurrentPatternFinding {
  scope: 'cross'; related: Array<{ documentId: string; line: number }>;
}
export const MAX_CAMPAIGN_DOCUMENTS = 200;
export function checkCampaignSize(count: number): void {
  if (count > MAX_CAMPAIGN_DOCUMENTS) throw new RangeError(`Campaign exceeds ${MAX_CAMPAIGN_DOCUMENTS} documents; split it into smaller campaign sets.`);
}
export function scanCampaignPatterns(documents: WritingDocument[]): Map<string, CampaignFinding[]> {
  checkCampaignSize(documents.length);
  const byDocument = new Map<string, SentenceRecord[]>();
  const out = new Map<string, CampaignFinding[]>();
  const records = documents.flatMap(d => {
    if (out.has(d.id)) throw new Error(`Duplicate document ID: ${d.id}`);
    out.set(d.id, []);
    const own = proseParagraphs(maskProse(d.content)).flatMap(p => p.sentences);
    const indexed = own.map(s => ({ ...s, document: d, key: s.tokens.join(' '), line: d.content.slice(0, s.start).split('\n').length }));
    byDocument.set(d.id, indexed);
    return indexed;
  });
  type Record = typeof records[number];
  const emit = (id: string, tier: PatternTier, r: Record, related: Record[], explanation: string, suggestion: string) => {
    // A one-sentence post can share both boundaries; keep one diagnostic per span/rule.
    if (out.get(r.document.id)!.some(f => f.ruleId === id && f.start === r.start && f.end === r.end)) return;
    out.get(r.document.id)!.push({ ruleId: id, tier, start: r.start, end: r.end, scope: 'cross', explanation, suggestion,
      related: related.filter(o => o !== r).map(o => ({ documentId: o.document.id, line: o.line })).sort((a, b) => a.documentId.localeCompare(b.documentId) || a.line - b.line) });
  };
  const group = (pairs: Array<[string, Record]>) => {
    const map = new Map<string, Record[]>();
    for (const [key, record] of pairs) {
      let occurrences = map.get(key);
      if (!occurrences) { occurrences = []; map.set(key, occurrences); }
      occurrences.push(record);
    }
    return map;
  };
  const repeated = new Set<string>();
  for (const [key, occurrences] of group(records.filter(r => r.tokens.length >= 6).map(r => [r.key, r]))) {
    if (occurrences.length < 2) continue;
    repeated.add(key);
    for (const r of occurrences) emit('repeated-sentence', 'cut', r, occurrences, 'This sentence repeats within the campaign set.', 'Write each channel from its relevant facts; retain required repetition with a reason.');
  }
  const shingles = group(records.flatMap(r => r.tokens.slice(0, -7).map((_, i) => [r.tokens.slice(i, i + 8).join(' '), r] as [string, Record])));
  const shingleDocuments = new Map([...shingles].map(([key, occurrences]) => [key, new Set(occurrences.map(r => r.document.id)).size]));
  for (const r of records) {
    if (repeated.has(r.key)) continue;
    const covered = new Set<number>();
    const related = new Set<Record>();
    for (let i = 0; i + 8 <= r.tokens.length; i++) {
      const key = r.tokens.slice(i, i + 8).join(' ');
      if (shingleDocuments.get(key)! < 3) continue;
      const occurrences = shingles.get(key)!;
      for (let j = i; j < i + 8; j++) covered.add(j);
      for (const o of occurrences) related.add(o);
    }
    // Shingles identify shared runs; each affected sentence receives one phrase finding.
    for (const index of covered) if (!covered.has(index - 1)) emit('repeated-phrase', 'check', r, [...related], 'An eight-word or longer run is shared by at least three documents.', 'Rewrite the shared run for the reader and channel.');
  }
  for (const edge of ['opening', 'closing'] as const) {
    const pairs: Array<[string, Record]> = [];
    for (const d of documents) {
      const own = byDocument.get(d.id)!;
      const r = edge === 'opening' ? own[0] : own.at(-1);
      if (!r) continue;
      const normalized = words(r.text.replace(/\d+(?:[.-]\d+)*/g, ' num '));
      if (normalized.length < 3) continue;
      const key = (edge === 'opening' ? normalized.slice(0, 3) : normalized.slice(-3)).join(' ');
      if (key.split(' ').some(w => !stopWords.has(w))) pairs.push([key, r]);
    }
    for (const occurrences of group(pairs).values()) {
      if (new Set(occurrences.map(r => r.document.id)).size < 3) continue;
      for (const r of occurrences) emit('shared-skeleton', 'check', r, occurrences, `The ${edge} shares three boundary words across at least three documents; numbers and versions are normalized.`, 'Lead or close with the useful change for this channel instead of a recurring template.');
    }
  }
  for (const findings of out.values()) findings.sort((a, b) => a.start - b.start || a.ruleId.localeCompare(b.ruleId));
  return out;
}
