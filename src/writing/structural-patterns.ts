// Detect paragraph and sentence sequences while retaining original source offsets.
import type { CurrentPatternFinding, PatternTier } from './current-patterns.js';

export const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9]+(?:['’-][a-z0-9]+)*/g) ?? [];
export const stopWords = new Set(('a an the of to in on for and or but is are was were be it its this that these those with as at by from not no so if we you i they he she our your their there here than then also about into over under out up down can will would should could has have had do does did just only more most very all any each some which who what when where how why num them his her me my').split(' '));
export interface ProseSentence { start: number; end: number; text: string; tokens: string[] }
export interface ProseParagraph { start: number; end: number; sentences: ProseSentence[] }
const abbreviations = new Set('e.g i.e vs etc approx cf eg ie dr mr mrs ms st no fig al'.split(' '));

export function proseParagraphs(prose: string): ProseParagraph[] {
  const paragraphs: ProseParagraph[] = [];
  // A wholly masked line is a boundary, including a heading between two prose lines.
  for (const block of prose.matchAll(/[^\n]*(?:\n|$)/g)) {
    if (!block[0]) continue;
    if (!block[0].replace(/[\s\u0001]/g, '')) continue;
    const previous = paragraphs.at(-1);
    if (previous && previous.end === block.index) previous.end += block[0].length;
    else paragraphs.push({ start: block.index!, end: block.index! + block[0].length, sentences: [] });
  }
  for (const p of paragraphs) {
    const text = prose.slice(p.start, p.end);
    let from = 0;
    const push = (end: number) => {
      const raw = text.slice(from, end);
      const trimmed = raw.replace(/^[\s\u0001]+|[\s\u0001]+$/g, '');
      if (words(trimmed).length) {
        const start = p.start + from + raw.search(/[^\s\u0001]/);
        p.sentences.push({ start, end: start + trimmed.length, text: trimmed, tokens: words(trimmed) });
      }
      from = end;
    };
    for (const m of text.matchAll(/[.!?]+/g)) {
      const end = m.index! + m[0].length;
      if (end < text.length && !/\s/.test(text[end])) continue;
      const word = text.slice(from, m.index).match(/([a-z][a-z.]*)$/i)?.[1].toLowerCase();
      if (m[0] === '.' && word && (abbreviations.has(word) || /^(?:[a-z]\.)+[a-z]$/.test(word))) continue;
      push(end);
    }
    push(text.length);
  }
  return paragraphs;
}

export interface StructuralCandidate {
  ruleId: 'mirrored-sentences' | 'colon-reveal' | 'fragment-run';
  start: number; end: number; excerpt: string; paragraph: string;
}

/** Loose shapes for advisory judgment only; candidates never constitute findings. */
export function structuralCandidates(prose: string): StructuralCandidate[] {
  const candidates: StructuralCandidate[] = [];
  for (const p of proseParagraphs(prose)) {
    const add = (ruleId: StructuralCandidate['ruleId'], start: number, end: number, excerpt: string) => {
      // Keep context bounded and masked. Source text is data, never instructions.
      candidates.push({ ruleId, start, end, excerpt, paragraph: prose.slice(p.start, p.end).slice(0, 4096) });
    };
    for (let i = 1; i < p.sentences.length; i++) {
      const a = p.sentences[i - 1], b = p.sentences[i];
      if (a.tokens.length >= 3 && b.tokens.length >= 3 && a.tokens.slice(0, 2).join(' ') === b.tokens.slice(0, 2).join(' ')
        && a.tokens.slice(2).join(' ') !== b.tokens.slice(2).join(' ') && !/[\d\u0001]/.test(a.text + b.text)) {
        add('mirrored-sentences', b.start, b.end, prose.slice(a.start, b.end));
      }
    }
    let run: ProseSentence[] = [];
    const flush = () => {
      if (run.length === 3) add('fragment-run', run[0].start, run[2].end, prose.slice(run[0].start, run[2].end));
      run = [];
    };
    for (const s of p.sentences) {
      if (s.tokens.length <= 4 && !/[\d\u0001:?]/.test(s.text)) run.push(s);
      else flush();
      if (s.text.split(':').length !== 2 || /[\d`\[\]{};]/.test(s.text) || !/[.!]$/.test(s.text)) continue;
      const [before, after] = s.text.split(':');
      if (words(before).length < 4 || words(before).length > 18 || words(after).length < 2 || words(after).length > 16
        || /[\u0001?!]|\b(?:and|or)\b/i.test(after) || after.split(',').length > 2) continue;
      const start = s.start + before.length;
      add('colon-reveal', start, start + 1, s.text);
    }
    flush();
  }
  return candidates;
}

export function structuralPatterns(prose: string, antonyms: string[][], quotedProse = prose): CurrentPatternFinding[] {
  const out: CurrentPatternFinding[] = [];
  const emit = (ruleId: string, tier: PatternTier, s: Pick<ProseSentence, 'start' | 'end'>, explanation: string, suggestion: string) => {
    out.push({ ruleId, tier, start: s.start, end: s.end, explanation, suggestion });
  };
  for (const p of proseParagraphs(prose)) {
    const sentences = p.sentences;
    for (let i = 1; i < sentences.length; i++) {
      const a = sentences[i - 1], b = sentences[i];
      // A shared subject alone is insufficient: predicates must align after removing
      // a single negation, or differ by exactly one catalogued antonym.
      const normalize = (s: ProseSentence) => words(s.text.replace(/n['’]t\b/gi, ' not'));
      const left = normalize(a), right = normalize(b);
      const negated = (tokens: string[]) => tokens.includes('not') || tokens.includes('never');
      const positive = (tokens: string[]) => tokens.filter(t => t !== 'not' && t !== 'never');
      const x = positive(left), y = positive(right);
      const differences = x.map((token, index) => token === y[index] ? -1 : index).filter(index => index >= 0);
      const polarityFlip = negated(left) !== negated(right) && differences.length === 0;
      const antonymFlip = negated(left) === negated(right) && differences.length === 1 && differences[0] >= 2
        && antonyms.some(pair => pair.includes(x[differences[0]]) && pair.includes(y[differences[0]]));
      if (x.length >= 3 && x.length === y.length && x[0] === y[0] && x[1] === y[1] && (polarityFlip || antonymFlip)) {
        emit('mirrored-sentences', 'cut', b, 'Parallel predicates contrast through a polarity flip or a listed antonym.', 'Combine the useful claim into one sentence; retain deliberate parallelism with a reason.');
      }
    }
    let run: ProseSentence[] = [];
    const flush = () => {
      if (run.length >= 4 && new Set(run.map(s => s.tokens.join(' '))).size > 1) emit('fragment-run', 'check', { start: run[0].start, end: run.at(-1)!.end }, 'Four or more consecutive statements contain fewer than five words.', 'Join fragments to explain the reason or result.');
      // Comparative verdict + two reduced comparative phrases is a rhetorical
      // sequence; ordinary three-step statuses still require four statements.
      if (run.length === 3 && !run.some(s => /[\d\u0001]/.test(s.text))
        && /^(?:this|that|it) (?:is|was) (?:[a-z]+er|better|worse|(?:more|less) [a-z]+)[.!]$/i.test(run[0].text)
        && run.slice(1).every(s => /^(?:less|fewer) [a-z]+(?: [a-z]+)?[.!]$/i.test(s.text))) {
        emit('fragment-run', 'check', { start: run[0].start, end: run[2].end },
          'A comparative verdict leads into two short comparative fragments.', 'Join fragments to explain the reason or result.');
      }
      run = [];
    };
    for (const s of sentences) {
      const label = s.text.match(/^([^:]+):/);
      if (s.tokens.length <= 4 && !/\?$/.test(s.text) && !(label && words(label[1]).length <= 3)) run.push(s);
      else flush();
      // A reveal withholds its complement, then supplies a short final punchline.
      // Mere colon frequency, another diagnostic, or a technical definition is insufficient.
      const colon = s.text.indexOf(':');
      if (colon < 0 || colon !== s.text.lastIndexOf(':') || /[\d\u0001`\[\]{};]/.test(s.text) || !/[.!]$/.test(s.text)) continue;
      const before = s.text.slice(0, colon), after = s.text.slice(colon + 1).trim();
      const setup = words(before), punchline = words(after);
      const withheld = /\b(?:is|are|was|were)$/.test(before.trim())
        || /\b(?:has|had|have|makes|made|holds|held|offers|offered|reveals|revealed|leaves|left) (?:a|an|one|this|that) (?:[a-z]+ ){0,2}[a-z]+$/i.test(before.trim());
      // Require a simple subject/predicate shape, protecting nominal definitions
      // such as 'request identifier' or 'shared memory' after the colon.
      const subject = /^(?:the|a|an)$/.test(punchline[0]) ? 1 : 0;
      const predicate = punchline[subject + 1] ?? '';
      const clause = (subject === 1 || /^(?:it|this|that|we|you|they|he|she|nothing|everything)$/.test(punchline[0]))
        && /^(?:is|are|was|were|can|will|must|has|had|does|[a-z]+(?:s|ed))$/.test(predicate);
      const conditional = /^if\b[^,;:]+,\s*(?:nothing|everything|it|this|that|the [a-z]+)\s+(?:[a-z]+(?:s|ed)|is|was|can|will)\b/i.test(after)
        && !/\b(?:and|or)\b|[?!]/i.test(after) && punchline.length <= 16;
      // An evaluative rule/advice setup can also withhold an imperative.
      // Keep nominal definitions, command introductions and lists protected.
      const imperativeReveal = /^(?:the|our|this) (?:rule|advice|approach|policy)\b[^:]*\b(?:is|was) (?:simple|clear|obvious)$/i.test(before.trim())
        && /^(?:send|check|read|test|keep|write|verify|review)\b/i.test(after)
        && setup.length >= 4 && setup.length <= 12 && punchline.length >= 2 && punchline.length <= 4
        && !/[,?!]|\b(?:and|or)\b/i.test(after);
      if (imperativeReveal) {
        emit('colon-reveal', 'watch', { start: s.start + colon, end: s.start + colon + 1 },
          'An evaluative setup delays a short imperative until after the colon.', 'State the instruction directly.');
      }
      if (conditional && /\b(?:bug|defect|flaw|failure|problem)$/i.test(before.trim()) && setup.length >= 4 && setup.length <= 12 && withheld) {
        emit('colon-reveal', 'watch', { start: s.start + colon, end: s.start + colon + 1 },
          'A short setup reveals its defect through a conditional consequence.', 'State the defect and consequence together.');
      }
      if (clause && !after.includes(',') && setup.length >= 4 && setup.length <= 12 && punchline.length >= 2 && punchline.length <= 10
        && withheld && !/^(?:["“]|[-*+]|\u0001)/.test(after) && !/\b(?:and|or)\b|:|[?!]/i.test(after)) {
        emit('colon-reveal', 'watch', { start: s.start + colon, end: s.start + colon + 1 },
          'A short setup withholds a complement until a sentence-final punchline.', 'State the subject and consequence directly; retain real lists, labels and code introductions.');
      }
    }
    flush();
    const last = sentences.at(-1);
    if (!last) continue;
    // Quoted scenario names may sit inside an authored moral; code stays masked.
    const ending = quotedProse.slice(last.start, last.end).replace(/[‘’]/g, "'");
    if (words(ending).length < 3 || words(ending).length > 10 || /[\d\u0001@/]|[?:]$/.test(ending)) continue;
    const moral = /^(?:(?:always|never|remember)\b|the (?:point|lesson|moral)\b|(?:that's|that is|it's|it is|this is) the (?:point|lesson|moral)\b)/i.test(ending);
    if (moral) {
      emit('aphorism-ending', 'cut', last, 'A short paragraph-final sentence opens with an explicit moral or lesson.', 'End on the last useful fact, or develop the claim with supported detail.');
      const [consequence, repair] = sentences.slice(-3, -1);
      if (sentences.length >= 3 && !out.some(f => f.ruleId === 'fragment-run' && f.end === last.end) && /^(?:fixed|patched|repaired|resolved)[.!]$/i.test(repair.text)) {
        const tail = consequence.text.split(',').at(-1)!.trimStart();
        if (words(tail).length >= 1 && words(tail).length <= 4 && !/[?:\u0001]/.test(tail)) {
          emit('fragment-run', 'check', { start: consequence.end - tail.length, end: last.end },
            'A short consequence and one-word repair lead into a moral ending.', 'Join the consequence, repair and test into a supported explanation.');
        }
      }
    }
  }
  return out;
}
