#!/usr/bin/env python3
"""
Legacy Pattern Scanner - Reviews regex phrase patterns; does not detect authorship.

Usage:
    python pattern_scanner.py <input_file>
    python pattern_scanner.py --text "Your text here"

Output:
    JSON report with pattern matches, frequency analysis, and deprecated heuristic
    authenticity_score and grade. Neither is authorship evidence or a publication gate.
    This legacy scanner does not implement contextual diagnostics or exceptions.
"""

import re
import json
import sys
from pathlib import Path
from collections import Counter
from typing import NamedTuple

CATALOGUE = json.loads((Path(__file__).resolve().parents[1] /
                        'references/current-patterns.json').read_text(encoding='utf-8'))
FIXES = {rule['id']: rule['fix'] for rule in CATALOGUE['rules']}
FIXES.update({'antithesis-pair': 'Keep the fact and drop the mirrored half.',
              'lexical-cluster': 'Replace vague markers with the specific action or fact.'})

# Legacy high-priority phrase patterns; matches do not identify authorship
CRITICAL_PATTERNS = [
    # Corporate/Marketing Speak
    r"\bplays?\s+a\s+(vital|crucial|key|essential)\s+role",
    r"\bseamlessly\s+(integrat|connect|work)",
    r"\bcutting[- ]edge",
    r"\bstate[- ]of[- ]the[- ]art",
    r"\b(transformative|revolutionary|groundbreaking)\b",
    r"\bnext[- ]generation\b",
    r"\bcomprehensive\s+(platform|solution|approach)",
    r"\binnovative\s+(methodology|approach|solution)",
    r"\brobust\s+and\s+scalable",
    r"\bbest[- ]in[- ]class",
    r"\bindustry[- ]leading",
    r"\bgame[- ]changing",
    r"\bparadigm\s+shift",
    r"\bsynerg(y|istic)",

    # Vague Intensifiers
    r"\bdramatically\s+(improv|enhanc|reduc|increas)",
    r"\bsignificantly\s+(improv|enhanc|reduc|increas)",
    r"\bsubstantially\s+(improv|enhanc|reduc|increas)",
    r"\bgreatly\s+(improv|enhanc|reduc|increas)",
    r"\bvastly\s+superior",
    r"\bhighly\s+effective",
    r"\bextremely\s+valuable",

    # Academic Phrases
    r"\bit\s+is\s+worth\s+noting\s+that",
    r"\bit\s+is\s+important\s+to\s+note",
    r"\bit\s+should\s+be\s+mentioned",
    r"\bunderscores?\s+the\s+importance",
    r"\bhighlights?\s+the\s+significance",
    r"\bdemonstrates?\s+the\s+value",
    r"\bserves?\s+as\s+a\s+testament",

    # Formulaic Transitions (at sentence start)
    r"(?:^|\. )Moreover,",
    r"(?:^|\. )Furthermore,",
    r"(?:^|\. )Additionally,",
    r"(?:^|\. )In\s+addition,",
    r"(?:^|\. )Consequently,",
    r"(?:^|\. )Nevertheless,",
    r"(?:^|\. )In\s+conclusion,",
    r"(?:^|\. )To\s+summarize,",

    # Performative Language
    r"\baims?\s+to\s+provide",
    r"\bseeks?\s+to\s+deliver",
    r"\bstrives?\s+to\s+achieve",
    r"\bendeavors?\s+to\s+create",
    r"\bdesigned\s+to\s+enhance",
    r"\bpoised\s+to\s+transform",

    # Overused Metaphors
    r"\bat\s+the\s+heart\s+of",
    r"\bforms?\s+the\s+backbone",
    r"\bserves?\s+as\s+the\s+foundation",
    r"\bacts?\s+as\s+a\s+cornerstone",
]

# Contextual patterns - check frequency
CONTEXTUAL_PATTERNS = [
    r"\bmanifest(s|ed|ing|ation)?\b",
    r"\butiliz(e|es|ed|ing|ation)\b",
    r"\bfacilit(ate|ates|ated|ating)\b",
    r"\brobust\b",
    r"\bscalable\b",
    r"\bcomprehensive\b",
    r"\binnovative\b",
    r"\bdynamic\b",
    r"\bvibrant\b",
    r"\bthriving\b",
]

# Structural patterns
STRUCTURAL_PATTERNS = {
    "three_item_list": CATALOGUE['triadPattern'],
    "hedge_words": r"\b(may|might|could|can)\s+(help|serve|facilitate|enhance)\b",
}


class PatternMatch(NamedTuple):
    pattern: str
    match: str
    position: int
    severity: str


def mask_prose(text: str) -> str:
    """Protect Markdown and quotations while retaining code-point offsets."""
    chars = list(text)

    def hide(start, end):
        for pos in range(start, end):
            if chars[pos] not in '\r\n':
                chars[pos] = '\x01'

    lines = list(re.finditer(r'[^\n]+(?:\n|$)|\n', text))
    front = bool(lines and re.fullmatch(r'\ufeff?---\s*', lines[0].group()))
    fence = None
    comment = False
    indented = False
    for index, line in enumerate(lines):
        raw = line.group()
        marker = re.match(r' {0,3}(`{3,}|~{3,})(.*)', raw)
        if front:
            hide(line.start(), line.end())
            if index > 0 and re.fullmatch(r'(?:---|\.\.\.)\s*', raw):
                front = False
            continue
        if fence:
            hide(line.start(), line.end())
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence) and not marker[2].strip():
                fence = None
            continue
        if marker:
            fence = marker[1]
            hide(line.start(), line.end())
            continue
        if comment:
            end = raw.find('-->')
            hide(line.start(), line.start() + (len(raw) if end < 0 else end + 3))
            comment = end < 0
            if comment:
                continue
        for match in re.finditer(r'<!--[\s\S]*?(?:-->|$)', raw):
            hide(line.start() + match.start(), line.start() + match.end())
            if not match.group().endswith('-->'):
                comment = True
        setext = index + 1 < len(lines) and re.fullmatch(r' {0,3}(?:=+|-+)\s*', lines[index + 1].group())
        if re.match(r' {0,3}(?:#{1,6}(?:\s|$)|>|\|)', raw) or setext or re.fullmatch(r' {0,3}(?:=+|-+)\s*', raw):
            hide(line.start(), line.end())
            continue
        if re.match(r'(?: {4}|\t)', raw) and (indented or index == 0 or not lines[index - 1].group().strip()):
            hide(line.start(), line.end())
            indented = True
            continue
        if raw.strip():
            indented = False
        if re.match(r'\s*(?:[-*+] |\d+[.)] )', raw):
            hide(line.start(), line.end())
    for pattern in [r'(`+)(?!`)(?:[^`]|(?!\1)`)*?\1(?!`)',
                    r'!\[[^\]\n]*\](?:\([^\n]*?\)|\[[^\]\n]*\])',
                    r'(?:!?\[[^\]\n]*\])?\((?:https?://)[^\s)]*\)|https?://[^\s<>]+',
                    r'“[^”]*”|"[^"\n]+"|«[^»]*»']:
        for match in re.finditer(pattern, text):
            hide(match.start(), match.end())
    return ''.join(chars)


def grounded_comparison(text: str, start: int, end: int) -> bool:
    """Require grounding near this comparison, not anywhere in its sentence."""
    words = lambda s: re.findall(r"[a-z0-9]+(?:['.-][a-z0-9]+)*", s, re.I)
    for cue in re.finditer(r'\b(?:because|while|correction|earlier|previously|misconception|you said)\b', text, re.I):
        gap = text[end:cue.start()] if cue.start() >= end else text[cue.end():start] if cue.end() <= start else ''
        if not re.search(r'[;:]', gap) and len(words(gap)) <= 4:
            return True
    divider = re.search(r'\brather\s+than\b|\bbut\b|,\s+not\b|^,$', text[start:end], re.I)
    if not divider:
        return False
    pivot = start + divider.start()
    left = words(re.split(r'[;:]', text[:pivot])[-1])[-6:]
    right = words(re.split(r'[;:]', text[pivot + len(divider.group()):])[0])[:6]
    return any(re.search(r'\d', w) for w in left) and any(re.search(r'\d', w) for w in right)


def current_matches(text: str):
    """Local patterns only; sentence-sequence and campaign checks await #4140."""
    text = text.replace('’', "'").replace('‘', "'")
    severity = {'cut': 'critical', 'check': 'warning', 'watch': 'info'}
    paragraphs = list(re.finditer(r'\S[^\n]*(?:\n(?!\s*\n)[^\n]+)*', text))
    lexical = []
    for paragraph in paragraphs:
        hits = []
        for group in CATALOGUE['lexicon']['sets']:
            pattern = r'\b(?:' + '|'.join(re.escape(w) for w in group['words']) + r')\b'
            hits.extend((paragraph.start() + m.start(), m.group(), group['tier'])
                        for m in re.finditer(pattern, paragraph.group(), re.I))
        if hits:
            hits.sort()
            lexical.append((hits[0], len(hits), 'check' if any(h[2] == 'check' for h in hits) else 'watch'))
    total = sum(count for _, count, _ in lexical)
    for (start, word, _), count, tier in lexical:
        if count >= CATALOGUE['lexicon']['paragraphMinHits'] or total >= CATALOGUE['lexicon']['fileMinHits']:
            yield PatternMatch('lexical-cluster', word, start, severity[tier])
    tokens = lambda s: re.findall(r"[a-z]+(?:['-][a-z]+)*", s.lower())
    for sentence in re.finditer(r'[^.!?\n\x01]+(?:[.!?]+|(?=[\n\x01]|$))', text):
        body = sentence.group()
        contrast = re.search(CATALOGUE['rules'][0]['pattern'], body, re.I)
        for rule in CATALOGUE['rules']:
            if rule['id'] == 'negate-then-assert' and contrast:
                continue
            for match in re.finditer(rule['pattern'], body, re.I | re.M):
                if rule['id'] in ('contrast-not-but', 'contrast-x-not-y', 'rather-than', 'negate-then-assert') and grounded_comparison(body, match.start(), match.end()):
                    continue
                trim = len(match.group()) - len(match.group().lstrip())
                yield PatternMatch(rule['id'], match.group().lstrip(), sentence.start() + match.start() + trim, severity[rule['tier']])
        for comma in re.finditer(',', body):
            if grounded_comparison(body, comma.start(), comma.end()):
                continue
            left, right = tokens(body[:comma.start()])[-3:], tokens(body[comma.end():])[:2]
            if len(left) < 2 or len(right) < 2:
                continue
            if any((a in left and b in right) or (b in left and a in right) for a, b in CATALOGUE['antonyms']):
                trim = len(body) - len(body.lstrip())
                yield PatternMatch('antithesis-pair', body.lstrip(), sentence.start() + trim, 'critical')
                break


def scan_text(text: str) -> dict:
    """Scan text for AI patterns and return analysis report."""

    source = text
    text = mask_prose(text)
    word_count = len(re.findall(r'\b\w+\b', text))
    matches = list(current_matches(text))

    # Check critical patterns
    for pattern in CRITICAL_PATTERNS:
        for match in re.finditer(pattern, text, re.IGNORECASE | re.MULTILINE):
            matches.append(PatternMatch(
                pattern=pattern,
                match=match.group(),
                position=match.start(),
                severity="critical"
            ))

    # Check contextual patterns with frequency
    contextual_counts = Counter()
    for pattern in CONTEXTUAL_PATTERNS:
        found = re.findall(pattern, text, re.IGNORECASE)
        if found:
            contextual_counts[pattern] = len(found)
            # Flag if frequency too high (> 1 per 500 words)
            if len(found) / max(word_count, 1) > 0.002:
                for match in re.finditer(pattern, text, re.IGNORECASE):
                    matches.append(PatternMatch(
                        pattern=pattern,
                        match=match.group(),
                        position=match.start(),
                        severity="warning"
                    ))

    # Check structural patterns
    structural_issues = {}
    for name, pattern in STRUCTURAL_PATTERNS.items():
        found = re.findall(pattern, text, re.IGNORECASE)
        count = len(found)
        if count > 0:
            structural_issues[name] = count
            # Flag if overused
            threshold = 0 if name == "three_item_list" else 5
            if count > threshold:
                for match in re.finditer(pattern, text, re.IGNORECASE):
                    matches.append(PatternMatch(
                        pattern=name,
                        match=match.group() if len(match.group()) < 50 else match.group()[:50] + "...",
                        position=match.start(),
                        severity="info"
                    ))

    # Calculate deprecated compatibility heuristic (not an authorship or quality measure)
    critical_count = sum(1 for m in matches if m.severity == "critical")
    warning_count = sum(1 for m in matches if m.severity == "warning")
    info_count = sum(1 for m in matches if m.severity == "info")

    # Base score of 100, deduct for issues
    score = 100
    score -= (critical_count * 10 + warning_count * 3 + info_count) * 100 / max(word_count, 1)
    score = max(0, min(100, score))

    return {
        "word_count": word_count,
        "authenticity_score": score,
        "legacy_score_notice": {
            "deprecated": True,
            "fields": ["authenticity_score", "grade"],
            "meaning": "Legacy regex editorial heuristic; not authorship evidence or a publication gate",
            "contextual_diagnostics": False
        },
        "summary": {
            "critical": critical_count,
            "warning": warning_count,
            "info": info_count,
            "total": len(matches)
        },
        "matches": [
            {
                "text": source[m.position:m.position + len(m.match)],
                "pattern": m.pattern,
                "severity": m.severity,
                "tier": {"critical": "cut", "warning": "check", "info": "watch"}[m.severity],
                "position": m.position,
                "line": source.count('\n', 0, m.position) + 1,
                "column": m.position - source.rfind('\n', 0, m.position),
                "suggestion": FIXES.get(m.pattern, 'Review the wording in context; retain deliberate usage.')
            }
            for m in sorted(matches, key=lambda x: x.position)
        ],
        "contextual_frequencies": dict(contextual_counts),
        "structural_issues": structural_issues,
        "grade": _score_to_grade(score)
    }


def _score_to_grade(score: int) -> str:
    """Convert legacy heuristic to a compatibility band, not a quality certification."""
    if score >= 90:
        return "A"
    elif score >= 80:
        return "B"
    elif score >= 70:
        return "C"
    elif score >= 60:
        return "D"
    else:
        return "F"


def main():
    """CLI entry point."""
    if len(sys.argv) < 2 or sys.argv[1] in ('--help', '-h'):
        print(__doc__)
        print("Options:")
        print("  <file>           Path to file to scan")
        print("  --text 'text'    Inline text to scan")
        print("  --help, -h       Show this help message")
        sys.exit(0)

    if sys.argv[1] == "--text":
        text = " ".join(sys.argv[2:])
    else:
        path = Path(sys.argv[1])
        if not path.exists():
            print(f"Error: File not found: {path}")
            sys.exit(1)
        with path.open(encoding='utf-8', newline='') as stream:
            text = stream.read()

    result = scan_text(text)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
