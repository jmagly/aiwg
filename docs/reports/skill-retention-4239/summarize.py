"""Derive descriptive paired uncertainty and audit the frozen offline rerun."""
from collections import Counter
from copy import deepcopy
from hashlib import sha256
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
METRICS = ('strict', 'functional', 'execution')
STRATA = ('old-only', 'new-only', 'mixed')
TIMINGS = ('refinementMs', 'routingMs', 'executionMs')


def load(name):
    return json.loads((ROOT / name).read_text())


def digest(file):
    return 'sha256:' + sha256(file.read_bytes()).hexdigest()


def score(query, metric):
    return int(query['execution']['status'] == 'passed' if metric == 'execution' else query[metric])


def paired(deltas, excluded=0):
    n = len(deltas)
    result = dict(count=n, nonComparable=excluded, wins=deltas.count(1),
                  losses=deltas.count(-1), ties=deltas.count(0), meanDelta=None,
                  interval=None, method='exact empirical paired bootstrap percentile 95%',
                  interpretation='descriptive task reweighting only; no population inference')
    if not n:
        return result
    # Integer convolution enumerates n**n equally likely ordered resamples.
    frequencies = Counter(deltas)
    distribution = {0: 1}
    for _ in range(n):
        updated = Counter()
        for total, weight in distribution.items():
            for delta, count in frequencies.items():
                updated[total + delta] += weight * count
        distribution = updated
    denominator = n ** n
    assert sum(distribution.values()) == denominator
    bounds = []
    for numerator in (1, 39):
        cumulative = 0
        for total, weight in sorted(distribution.items()):
            cumulative += weight
            if cumulative * 40 >= numerator * denominator:
                bounds.append(total / n)
                break
    result.update(meanDelta=sum(deltas) / n, interval=bounds)
    return result


def compare(before, after, stratum, metric):
    original = {query['id']: query for query in before['queries'] if query['stratum'] == stratum}
    candidate = {query['id']: query for query in after['queries'] if query['stratum'] == stratum}
    assert original.keys() == candidate.keys()
    comparable = [key for key in original if not original[key].get('error') and not candidate[key].get('error')]
    return paired([score(candidate[key], metric) - score(original[key], metric) for key in comparable],
                  len(original) - len(comparable))


def main():
    # Known small distributions check percentile boundaries, ties and exclusions.
    assert paired([-1, -1, -1, 0])['interval'] == [-1, -0.25]
    assert paired([-1, -1, 0, 0])['interval'] == [-1, 0]
    assert paired([0, 0, 0, 0])['interval'] == [0, 0]
    assert paired([], 2)['interval'] is None
    snapshot, manifest = load('snapshot.json'), load('snapshot-manifest.json')
    report, repeat = load('results.json'), load('repeat-results.json')
    assert digest(ROOT / 'snapshot.json') == manifest['snapshot']['digest']
    assert digest(ROOT / 'preregistration.md') == manifest['preregistration']['digest']
    assert report['snapshotHash'] == repeat['snapshotHash'] == manifest['harnessParsedSnapshotHash'].split(':')[1]
    originals = [{key: skill[key] for key in ('id', 'name', 'description', 'bodyHash')} for skill in snapshot['skills']]
    assert report['originals'] == originals
    by_id = {skill['id']: skill for skill in snapshot['skills']}
    for skill in snapshot['skills']:
        assert sha256(skill['body'].encode()).hexdigest() == skill['bodyHash']
    mismatches = []
    clean = []
    for item in (report, repeat):
        copy = deepcopy(item)
        for run in copy['runs']:
            for field in TIMINGS:
                del run['cost'][field]
        clean.append(copy)
    if clean[0] != clean[1]:
        mismatches.append('report differs after removing only declared timing fields')
    assert not mismatches, mismatches
    lookup = {(run['stream'], run['arm'], run['step']): run for run in report['runs']}
    for pair in report['pairs']:
        before = lookup[pair['stream'], 'unchanged', pair['step']]
        after = lookup[pair['stream'], pair['arm'], pair['step']]
        previous = next(query for query in before['queries'] if query['id'] == pair['task'])
        current = next(query for query in after['queries'] if query['id'] == pair['task'])
        assert pair['stratum'] == previous['stratum'] == current['stratum']
        assert pair['comparable'] == (not previous.get('error') and not current.get('error'))
        for metric in METRICS:
            assert pair[metric + 'Delta'] == score(current, metric) - score(previous, metric)
    checkpoints, retention, costs, failures = [], [], [], []
    for run in report['runs']:
        stream, arm, step = (run[key] for key in ('stream', 'arm', 'step'))
        assert run['controls'] == report['controls']
        sequence = snapshot['protocol']['streams'][stream]
        available = {skill['id'] for skill in snapshot['skills'] if skill['cohort'] == 'old'} | set(sequence[:step])
        assert {original['id'] for original in run['originals']} == available
        assert all(original in originals for original in run['originals'])
        assert {query['id'] for query in run['queries']} == {
            task['id'] for task in snapshot['tasks'] if set(task['required']) <= available}
        assert all(run['cost'][key] == 0 for key in ('refinementCalls', 'retries', 'embeddings', 'modelTokens', 'usd'))
        for refinement in run['refinements']:
            source = by_id[refinement['id']]
            supported = {line[3:] for line in source['body'].splitlines() if line.startswith('// ')}
            # Joining/permutation changes no clause support in this vocabulary.
            clauses = source['bodyOnly'] if arm == 'body-only' else source['refined']
            assert set(clauses) <= supported
            normalized = lambda text: Counter(clause.strip() for clause in text.split('.') if clause.strip())
            assert normalized(refinement['description']) == normalized(' '.join(clauses))
            prior = {skill['id'] for skill in snapshot['skills'] if skill['cohort'] == 'old'}
            prior |= set(sequence[:sequence.index(refinement['id'])])
            expected_basis = [original for original in originals if original['id'] in prior]
            assert refinement['basis'] == ([] if arm == 'body-only' else expected_basis)
            assert refinement['bodyHash'] == source['bodyHash']
        if arm == 'current-discover':
            assert run['queries'] == lookup[stream, 'unchanged', step]['queries']
        for stratum in STRATA:
            if arm != 'unchanged':
                checkpoints.append(dict(stream=stream, arm=arm, step=step, stratum=stratum,
                    metrics={metric: compare(lookup[stream, 'unchanged', step], run, stratum, metric) for metric in METRICS}))
        retention.append(dict(stream=stream, arm=arm, step=step,
            metrics={metric: compare(lookup[stream, arm, 0], run, 'old-only', metric) for metric in METRICS}))
        for query in run['queries']:
            if query.get('error') or query['execution']['status'] != 'passed':
                failures.append(dict(stream=stream, arm=arm, step=step, query=query))
    for stream in snapshot['protocol']['streams']:
        for arm in dict.fromkeys(run['arm'] for run in report['runs']):
            selected = [run for run in report['runs'] if run['stream'] == stream and run['arm'] == arm]
            costs.append(dict(stream=stream, arm=arm,
                incrementalTotals={key: sum(run['cost'][key] for run in selected) for key in selected[0]['cost']},
                queryObservations=sum(len(run['queries']) for run in selected)))
    assert len(report['runs']) == 40 and len(report['pairs']) == 231
    assert sum(len(run['queries']) for run in report['runs']) == 308
    summary = dict(version=1, rawReport=dict(path='results.json', digest=digest(ROOT / 'results.json')),
        repeatReport=dict(path='repeat-results.json', digest=digest(ROOT / 'repeat-results.json')),
        audit=dict(checkpoints=len(report['runs']), queries=308, pairs=len(report['pairs']),
            partialRuns=sum(run['status'] == 'partial' for run in report['runs']),
            nonComparablePairs=sum(not pair['comparable'] for pair in report['pairs']),
            executionFailures=len(failures), repeatOutcomeMismatches=mismatches,
            finalMetricDistributionsIdenticalAcrossStreams=True),
        finalCheckpointPairs=[pair for pair in checkpoints if pair['step'] == 4],
        checkpointPairs=checkpoints, oldOnlyRetentionVersusInitial=retention,
        costs=costs, failures=failures,
        uncertaintyLimitations=['Repeated checkpoints and streams are dependent.',
            'Four tasks per final stratum; percentile intervals can be degenerate.',
            'No empirical distribution here estimates production-catalog uncertainty.'])
    # Check the statement printed in the audit, rather than assuming stream parity.
    for arm in ('unchanged', 'body-only', 'neighbour-aware', 'current-discover'):
        assert lookup['natural-random', arm, 4]['strata'] == lookup['confusable', arm, 4]['strata']
    (ROOT / 'paired-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps(summary['audit']))


if __name__ == '__main__':
    main()
