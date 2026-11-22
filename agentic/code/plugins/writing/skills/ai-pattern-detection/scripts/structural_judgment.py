"""Advisory structural judgments through the existing aiwg decision ask CLI."""
import json
import math
import os
import re
import subprocess
from pathlib import Path

RULES = json.loads((Path(__file__).resolve().parents[1] /
                    'references/structural-judgment.json').read_text(encoding='utf-8'))


def ask(payload):
    """The decision CLI owns opt-in, credentials, sampling, threshold and fallback."""
    if os.environ.get('AIWG_DECISION_ENABLED') == '0':
        return None
    try:
        completed = subprocess.run(
            ['aiwg', 'decision', 'ask', '--yes-no', '--json', '--question', payload['question'],
             '--context-stdin', '--threshold', str(payload['threshold'])],
            input=payload['context'], text=True, capture_output=True, timeout=20, check=True)
        return json.loads(completed.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        return None


def assisted_matches(prose, deterministic, candidates, match_type, judgment=None, source=None):
    if os.environ.get('AIWG_DECISION_ENABLED') == '0':
        return []
    out = []
    for candidate in candidates(prose):
        rule_id = candidate['ruleId']
        if any(m.pattern == rule_id and m.position <= candidate['start'] and
               m.position + len(m.match) >= candidate['end'] for m in deterministic):
            continue
        rule = RULES[rule_id]
        headings = re.findall(r'^ {0,3}#{1,6}\s+([^\n]+)', (source or prose)[:candidate['start']], re.M)
        section = headings[-1][:200] if headings else ''
        try:
            answer = (judgment or ask)(dict(question=rule['question'], mode={'kind': 'yes-no'}, threshold=0.8,
                context=json.dumps(dict(pattern=rule_id, excerpt=candidate['excerpt'], paragraph=candidate['paragraph'], section=section))))
            confidence = answer.get('confidence') if isinstance(answer, dict) else None
            if not answer or answer.get('status') != 'answered' or answer.get('answer') is not True or type(confidence) not in (int, float) or not math.isfinite(confidence) or not 0.8 <= confidence <= 1:
                continue
            start, end = candidate['start'], candidate['end']
            out.append(match_type(rule_id, prose[start:end], start,
                {'cut': 'critical', 'check': 'warning', 'watch': 'info'}[rule['tier']], confidence))
        except Exception:
            # Unavailable or malformed judgment cannot remove deterministic findings.
            continue
    return out
