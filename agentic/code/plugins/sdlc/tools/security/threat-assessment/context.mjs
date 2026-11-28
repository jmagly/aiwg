// Classify matched content as requested action or inert evidence.
import { clauseAt, IMPERATIVE_LEAD, isNegatedMaterial, requestPrefix } from './negation.mjs';
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

const REQUEST_CUE = /\b(?:please|you (?:should|must|need to|have to|can)|we (?:should|must|need to|have to)|make sure|be sure|so that (?:you|it) can|in order to)\b/i;
const DESCRIPTIVE_CUE = /\b(?:added|implemented|delivered|documented|recorded|verified|tested|passed|failed|opened|landed|merged|shipped|fixed|removed|renamed|introduced|wired|gated|configured|trialed|reviewed|observed|checked|confirmed|reconciled|mapped|covered|installed|proceeded|returned|classified|assessed|scored|flagged|contains?|preserves?|keeps?|remains?|names?|describ(?:es|ed|ing)|declares?|records?|reports?|states?|lists?|carries|existing|currently|already|was|were|has been|have been)\b/i;
const SENTENCE_LEAD_MARKERS = /^(?:[\s|>]|[-*+]\s|\d+[.)]\s|\[[ xX]\]\s|\*\*|`)+/;
const ENV_MATERIAL = /^env(?:ironment)?[ _-]?(?:vars?|variables?)$/i;
// Match extraction aimed at the material itself or its values, not config advice.
const ENV_VALUE_REQUEST = new RegExp([
  String.raw`\b(?:read|print|dump|echo|cat|show|reveal|disclose|leak|send|upload|post|export|paste|share|give|provide|display|output|expose|extract|retrieve|collect|list|inspect|include|get|fetch|capture|log|return|copy|attach|transmit|forward)\s+`,
  String.raw`(?:(?:out|over|me|us|with me|with us)\s+)?`,
  String.raw`(?:(?:the|an?|all|of|my|your|our|these|those|current|raw|full|entire|actual|runtime|deployment|production)\s+)*`,
  String.raw`(?:(?:values?|contents?|data)\s+(?:of|from|in|for)\s+(?:(?:the|all|my|your|our|these|those|current)\s+)*)?[\x60"'*]*$`,
].join(''), 'i');
const ENV_PASSIVE_REQUEST = /^\s*[`"'*]*(?:\s+(?:values?|contents?))?\s+(?:(?:must|should|need to|have to)\s+be\s+|(?:to\s+be\s+))?(?:printed|dumped|echoed|read|shown|revealed|disclosed|sent|uploaded|posted|exported|pasted|shared|displayed|extracted)\b/i;
const FILE_ACTION = [
  'read|cat|print|paste|send|upload|dump|echo|show|reveal|disclose|share|extract|inspect|attach|post|include|provide|display|output|return|download|fetch|retrieve|collect|transmit|forward|leak|exfiltrate',
  'delete|overwrite|edit|update|modify|change|rewrite|replace|remove|open|write|append|add|insert|copy|move|configure|set|use|load|source|run|execute|invoke|install|export|enable|disable|migrate|commit|push|apply|ignore|treat',
  'rm|cp|mv|head|tail|less|more|tee|truncate|touch|sed|awk|perl|grep|rg',
].join('|');
const FILE_ACTION_LEAD = new RegExp(String.raw`^(?:please\s+|now\s+|just\s+|also\s+)*(?:${FILE_ACTION})\b`, 'i');
// The action must address the file, its contents, or a coordinated file list.
// "Print the report about AGENTS.md" does not address AGENTS.md itself.
const FILE_TARGET_REQUEST = new RegExp([
  String.raw`\b(?:${FILE_ACTION})\s+`,
  String.raw`(?:(?:[\w-]+\s+){1,12}(?:in|inside|within|from|of|to|into)\s+)?`,
  String.raw`(?:(?:out|over|me|us|with me|with us|to|into|from|of|in|the|an?|all|my|your|our|these|those|current|raw|full|entire|actual|file|files|contents?|data|text|instructions?|credentials|generated)\s+)*`,
  String.raw`(?:--?\S+\s+)*`,
  String.raw`(?:[\x60"'*]*(?:[\w.~/-]+\.(?:md|ya?ml))[\x60"'*]*\s*(?:,\s*(?:and\s+)?|and\s+))*`,
  String.raw`[\x60"'*]*(?:[\w.~/-]+/)*$`,
].join(''), 'i');
const FILE_SHELL_REQUEST = /\b(?:sed|awk|perl|grep|rg)\s+[^;\n|]*\s+[\x60"']*(?:[\w.~/-]+\/)*$/i;
const FILE_PASSIVE_REQUEST = /^[\s`"'*:]*(?:\s+(?:contents?|file|it))?\s+(?:(?:must|should|needs?\s+to|has\s+to|have\s+to|will)\s+be\s+|(?:is\s+)?to\s+be\s+)(?:read|opened|printed|pasted|sent|uploaded|deleted|overwritten|edited|modified|changed|rewritten|replaced|removed|updated|shared|copied|disclosed)\b/i;

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
  return { text: text.slice(start, end), leading, trailing: text.slice(index + length, end) };
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

export function inferContext(text, index, explicit, length = 0, ruleId = '', surface = '') {
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
  const clause = clauseAt(text, index, length);
  if (ruleId === 'credential-or-env-probing' && isNegatedMaterial(clause)) return 'descriptive';
  // Suppress only complete citation forms; extra instructions prevent a match.
  if (ruleId === 'sensitive-file-target' && /^(?:(?:see|refer to)\s+(?:the\s+)?)?`?AIWG\.md`?(?:\s+parallelism\s+section)?\.?$/i.test(
    text.slice(lineStart, text.indexOf('\n', index) < 0 ? text.length : text.indexOf('\n', index)).replace(SENTENCE_LEAD_MARKERS, '').trim(),
  )) return 'descriptive';
  const localPrefix = requestPrefix(ruleId === 'sensitive-file-target' ? clause.before : `${clause.before} ${clause.match}`).toLowerCase();
  if (/(?:must not|do not|don't|never|avoid|prevent|forbid|out[- ]of[- ]scope|warning against|without)\b[^.!?\n]{0,100}$/i.test(localPrefix)
    || /\bno\s+(?:[\w-]+\s+){0,3}$/i.test(localPrefix)) {
    // "no model credentials needed", "no secret was accessed": a bare "no"
    // within three words of the match negates it; "no" further back does not.
    return 'negative';
  }
  if (ruleId === 'credential-or-env-probing' && ENV_MATERIAL.test(clause.match)
    && !ENV_VALUE_REQUEST.test(requestPrefix(clause.before)) && !ENV_PASSIVE_REQUEST.test(clause.after)) {
    return 'descriptive';
  }
  const leading = requestPrefix(clause.before).replace(SENTENCE_LEAD_MARKERS, '').trimStart();
  if (ruleId === 'sensitive-file-target') {
    const direct = FILE_TARGET_REQUEST.test(leading) || FILE_SHELL_REQUEST.test(leading);
    const trailing = requestPrefix(sentence.trailing).replace(/^[\s`"'*:,]*(?:and\s+)?/i, '');
    const indirect = /\b(?:(?:can|could|would|will)\s+you|(?:the\s+fix\s+is|you\s+need|i\s+want\s+you)\s+to)\s+(.+)$/i.exec(leading);
    if (FILE_PASSIVE_REQUEST.test(sentence.trailing) || FILE_ACTION_LEAD.test(trailing)) return 'requested';
    if (!direct) return 'descriptive';
    if (FILE_ACTION_LEAD.test(leading) || REQUEST_CUE.test(leading)
      || (indirect && FILE_ACTION_LEAD.test(indirect[1]))) return 'requested';
    // Reports on these surfaces need an affirmative request even for ambiguous
    // verbs such as "read" that can also describe a completed action.
    if (['outbound-maintainer-comment', 'release-note'].includes(surface)) return 'descriptive';
  }
  if (IMPERATIVE_LEAD.test(`${leading}${clause.match}`) || REQUEST_CUE.test(leading)) return 'requested';
  if (DESCRIPTIVE_CUE.test(sentence.text)) return 'descriptive';
  return 'requested';
}

