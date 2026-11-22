"""Sentence-sequence and campaign editorial heuristics with source code-point offsets."""
import re
from collections import defaultdict

STOP = set("a an the of to in on for and or but is are was were be it its this that these those with as at by from not no so if we you i they he she our your their there here than then also about into over under out up down can will would should could has have had do does did just only more most very all any each some which who what when where how why num them his her me my".split())
ABBREVIATIONS = set('e.g i.e vs etc approx cf eg ie dr mr mrs ms st no fig al'.split())
SEVERITY = {'cut': 'critical', 'check': 'warning', 'watch': 'info'}
FIXES = {
    'mirrored-sentences': 'Combine the useful claim into one sentence; retain deliberate parallelism with a reason.',
    'fragment-run': 'Join fragments to explain the reason or result.',
    'aphorism-ending': 'End on the last useful fact, or develop the claim with supported detail.',
    'colon-reveal': 'State the subject and consequence directly; retain real lists, labels and code introductions.',
    'repeated-sentence': 'Write each channel from its relevant facts; retain required repetition with a reason.',
    'repeated-phrase': 'Rewrite the shared run for the reader and channel.',
    'shared-skeleton': 'Lead or close with the useful change for this channel instead of a recurring template.'
}


def words(text):
    return re.findall(r"[a-z0-9]+(?:['’-][a-z0-9]+)*", text.lower())


def paragraphs(prose):
    blocks = []
    for line in re.finditer(r'[^\n]*(?:\n|$)', prose):
        if not re.sub(r'[\s\x01]', '', line.group()):
            continue
        if blocks and blocks[-1]['end'] == line.start():
            blocks[-1]['end'] = line.end()
        else:
            blocks.append({'start': line.start(), 'end': line.end()})
    for p in blocks:
        text = prose[p['start']:p['end']]
        ends = []
        segment_start = 0
        for match in re.finditer(r'[.!?]+', text):
            if match.end() < len(text) and not text[match.end()].isspace():
                continue
            word = re.search(r'([a-z][a-z.]*)$', text[segment_start:match.start()], re.I)
            if match.group() == '.' and word and (word[1].lower() in ABBREVIATIONS or re.fullmatch(r'(?:[a-z]\.)+[a-z]', word[1], re.I)):
                continue
            ends.append(match.end())
            segment_start = match.end()
        ends.append(len(text))
        start = 0
        p['sentences'] = []
        for end in ends:
            raw = text[start:end]
            trimmed = raw.strip(' \t\r\n\x01')
            if words(trimmed):
                offset = p['start'] + start + len(raw) - len(raw.lstrip(' \t\r\n\x01'))
                p['sentences'].append({'start': offset, 'end': offset + len(trimmed), 'text': trimmed, 'tokens': words(trimmed)})
            start = end
    return blocks


def structural_candidates(prose):
    """Loose shapes only: no candidate becomes a finding without judgment."""
    out = []
    for p in paragraphs(prose):
        def add(rule, start, end, excerpt):
            out.append(dict(ruleId=rule, start=start, end=end, excerpt=excerpt,
                            paragraph=prose[p['start']:p['end']][:4096]))
        seq = p['sentences']
        for a, b in zip(seq, seq[1:]):
            if len(a['tokens']) >= 3 and len(b['tokens']) >= 3 and a['tokens'][:2] == b['tokens'][:2] and a['tokens'][2:] != b['tokens'][2:] and not re.search(r'[\d\x01]', a['text'] + b['text']):
                add('mirrored-sentences', b['start'], b['end'], prose[a['start']:b['end']])
        run = []
        def flush():
            if len(run) == 3:
                add('fragment-run', run[0]['start'], run[-1]['end'], prose[run[0]['start']:run[-1]['end']])
            run.clear()
        for s in seq:
            text = s['text']
            if len(s['tokens']) <= 4 and not re.search(r'[\d\x01:?]', text):
                run.append(s)
            else:
                flush()
            if text.count(':') != 1 or re.search(r'[\d`\[\]{};]', text) or not re.search(r'[.!]$', text):
                continue
            before, after = text.split(':')
            if not 4 <= len(words(before)) <= 18 or not 2 <= len(words(after)) <= 16 or re.search(r'[\x01?!]|\b(?:and|or)\b', after, re.I) or len(after.split(',')) > 2:
                continue
            start = s['start'] + len(before)
            add('colon-reveal', start, start + 1, text)
        flush()
    return out


def structural_matches(prose, antonyms, match_type, quoted_prose=None):
    quoted_prose = prose if quoted_prose is None else quoted_prose
    out = []
    def emit(rule, sentence, tier):
        out.append(match_type(rule, prose[sentence['start']:sentence['end']], sentence['start'], SEVERITY[tier]))
    for p in paragraphs(prose):
        seq = p['sentences']
        for a, b in zip(seq, seq[1:]):
            left, right = [words(re.sub(r"n['’]t\b", ' not', v['text'], flags=re.I)) for v in (a, b)]
            negated = lambda tokens: 'not' in tokens or 'never' in tokens
            x, y = [[t for t in tokens if t not in ('not', 'never')] for tokens in (left, right)]
            differences = [i for i, (u, v) in enumerate(zip(x, y)) if u != v]
            polarity = negated(left) != negated(right) and not differences
            antonym = negated(left) == negated(right) and len(differences) == 1 and differences[0] >= 2 and any(x[differences[0]] in pair and y[differences[0]] in pair for pair in antonyms)
            if len(x) >= 3 and len(x) == len(y) and x[:2] == y[:2] and (polarity or antonym):
                emit('mirrored-sentences', b, 'cut')
        run = []
        def flush():
            if len(run) >= 4 and len({' '.join(s['tokens']) for s in run}) > 1:
                emit('fragment-run', {'start': run[0]['start'], 'end': run[-1]['end']}, 'check')
            # A comparative verdict followed by two reduced comparative phrases
            # is distinct from an ordinary three-step status sequence.
            if len(run) == 3 and not any(re.search(r'[\d\x01]', s['text']) for s in run) and re.fullmatch(r'(?:this|that|it) (?:is|was) (?:[a-z]+er|better|worse|(?:more|less) [a-z]+)[.!]', run[0]['text'], re.I) and all(re.fullmatch(r'(?:less|fewer) [a-z]+(?: [a-z]+)?[.!]', s['text'], re.I) for s in run[1:]):
                emit('fragment-run', {'start': run[0]['start'], 'end': run[-1]['end']}, 'check')
            run.clear()
        for s in seq:
            label = re.match(r'^([^:]+):', s['text'])
            if len(s['tokens']) <= 4 and not s['text'].endswith('?') and not (label and len(words(label[1])) <= 3):
                run.append(s)
            else:
                flush()
            text = s['text']
            if text.count(':') != 1 or re.search(r'[\d\x01`\[\]{};]', text) or not re.search(r'[.!]$', text):
                continue
            before, after = text.split(':')
            after = after.strip()
            withheld = re.search(r'\b(?:is|are|was|were)$', before.strip()) or re.search(r'\b(?:has|had|have|makes|made|holds|held|offers|offered|reveals|revealed|leaves|left) (?:a|an|one|this|that) (?:[a-z]+ ){0,2}[a-z]+$', before.strip(), re.I)
            punchline = words(after)
            subject = 1 if punchline and punchline[0] in ('the', 'a', 'an') else 0
            predicate = punchline[subject + 1] if len(punchline) > subject + 1 else ''
            clause = punchline and (subject == 1 or punchline[0] in ('it', 'this', 'that', 'we', 'you', 'they', 'he', 'she', 'nothing', 'everything')) and re.fullmatch(r'(?:is|are|was|were|can|will|must|has|had|does|[a-z]+(?:s|ed))', predicate)
            conditional = re.match(r'^if\b[^,;:]+,\s*(?:nothing|everything|it|this|that|the [a-z]+)\s+(?:[a-z]+(?:s|ed)|is|was|can|will)\b', after, re.I) and not re.search(r'\b(?:and|or)\b|[?!]', after, re.I) and len(punchline) <= 16
            # Evaluative rule/advice setups can withhold an imperative, while
            # nominal definitions, command introductions and lists stay protected.
            imperative_reveal = re.fullmatch(r'(?:the|our|this) (?:rule|advice|approach|policy)\b[^:]*\b(?:is|was) (?:simple|clear|obvious)', before.strip(), re.I) and re.match(r'^(?:send|check|read|test|keep|write|verify|review)\b', after, re.I) and 4 <= len(words(before)) <= 12 and 2 <= len(punchline) <= 4 and not re.search(r'[,?!]|\b(?:and|or)\b', after, re.I)
            if imperative_reveal:
                pos = s['start'] + len(before)
                emit('colon-reveal', {'start': pos, 'end': pos + 1}, 'watch')
            if conditional and re.search(r'\b(?:bug|defect|flaw|failure|problem)$', before.strip(), re.I) and 4 <= len(words(before)) <= 12 and withheld:
                pos = s['start'] + len(before)
                emit('colon-reveal', {'start': pos, 'end': pos + 1}, 'watch')
            if clause and ',' not in after and 4 <= len(words(before)) <= 12 and 2 <= len(words(after)) <= 10 and withheld and not re.search(r'^(?:["“]|[-*+]|\x01)', after) and not re.search(r'\b(?:and|or)\b|:|[?!]', after, re.I):
                pos = s['start'] + len(before)
                emit('colon-reveal', {'start': pos, 'end': pos + 1}, 'watch')
        flush()
        if not seq:
            continue
        last = seq[-1]
        text = quoted_prose[last['start']:last['end']].replace('’', "'").replace('‘', "'")
        if not 3 <= len(words(text)) <= 10 or re.search(r'[\d\x01@/]|[?:]$', text):
            continue
        moral = re.match(r"^(?:(?:always|never|remember)\b|the (?:point|lesson|moral)\b|(?:that's|that is|it's|it is|this is) the (?:point|lesson|moral)\b)", text, re.I)
        if moral:
            emit('aphorism-ending', last, 'cut')
            if len(seq) >= 3 and not any(m.pattern == 'fragment-run' and m.position + len(m.match) == last['end'] for m in out) and re.fullmatch(r'(?:fixed|patched|repaired|resolved)[.!]', seq[-2]['text'], re.I):
                consequence = seq[-3]
                tail = consequence['text'].split(',')[-1].lstrip()
                if 1 <= len(words(tail)) <= 4 and not re.search(r'[?:\x01]', tail):
                    emit('fragment-run', {'start': consequence['end'] - len(tail), 'end': last['end']}, 'check')
    return out


def campaign_matches(sources, mask):
    if len(sources) > 200:
        raise ValueError('Campaign exceeds 200 documents; split it into smaller campaign sets.')
    out = {name: [] for name in sources}
    by_document = defaultdict(list)
    records = []
    for name, text in sources.items():
        for p in paragraphs(mask(text)):
            for s in p['sentences']:
                r = dict(s, file=name, key=' '.join(s['tokens']), line=text.count('\n', 0, s['start']) + 1)
                records.append(r)
                by_document[name].append(r)
    def emit(rule, tier, r, related):
        if any(f['pattern'] == rule and f['position'] == r['start'] and len(f['text']) == r['end'] - r['start'] for f in out[r['file']]):
            return
        source = sources[r['file']]
        out[r['file']].append({'pattern': rule, 'tier': tier, 'severity': SEVERITY[tier], 'scope': 'cross',
            'position': r['start'], 'line': source.count('\n', 0, r['start']) + 1,
            'column': r['start'] - source.rfind('\n', 0, r['start']),
            'text': source[r['start']:r['end']], 'suggestion': FIXES[rule],
            'related': sorted([{'documentId': s['file'], 'line': s['line']} for s in related if s is not r], key=lambda s: (s['documentId'], s['line']))})
    by_sentence = defaultdict(list)
    for r in records:
        if len(r['tokens']) >= 6:
            by_sentence[r['key']].append(r)
    repeated = set()
    for key, occurrences in by_sentence.items():
        if len(occurrences) >= 2:
            repeated.add(key)
            for r in occurrences:
                emit('repeated-sentence', 'cut', r, occurrences)
    shingles = defaultdict(list)
    for r in records:
        for i in range(len(r['tokens']) - 7):
            shingles[' '.join(r['tokens'][i:i+8])].append(r)
    shingle_documents = {key: len({s['file'] for s in occurrences}) for key, occurrences in shingles.items()}
    for r in records:
        if r['key'] in repeated:
            continue
        covered, related = set(), {}
        for i in range(len(r['tokens']) - 7):
            key = ' '.join(r['tokens'][i:i+8])
            occurrences = shingles[key]
            if shingle_documents[key] >= 3:
                covered.update(range(i, i+8))
                for s in occurrences:
                    related[id(s)] = s
        for i in sorted(covered):
            if i - 1 not in covered:
                emit('repeated-phrase', 'check', r, related.values())
    for edge in ('opening', 'closing'):
        groups = defaultdict(list)
        for name in sources:
            own = by_document[name]
            if not own:
                continue
            r = own[0] if edge == 'opening' else own[-1]
            normalized = words(re.sub(r'\d+(?:[.-]\d+)*', ' num ', r['text']))
            if len(normalized) < 3:
                continue
            boundary = normalized[:3] if edge == 'opening' else normalized[-3:]
            if any(w not in STOP for w in boundary):
                groups[' '.join(boundary)].append(r)
        for occurrences in groups.values():
            if len({r['file'] for r in occurrences}) >= 3:
                for r in occurrences:
                    emit('shared-skeleton', 'check', r, occurrences)
    for findings in out.values():
        findings.sort(key=lambda f: (f['position'], f['pattern']))
    return out
