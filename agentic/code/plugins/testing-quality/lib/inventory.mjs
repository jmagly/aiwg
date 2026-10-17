import fs from 'node:fs/promises';
import { artifact, digest } from './contracts.mjs';
import { findFiles, readBounded, DEFAULT_EXCLUDES } from './workspace.mjs';

const CONFIG_PATTERNS = ['**/{package.json,package-lock.json,pnpm-lock.yaml,yarn.lock,pyproject.toml,pytest.ini,tox.ini,setup.cfg,go.mod,go.sum,Cargo.toml,Cargo.lock,pom.xml,build.gradle,global.json,*.csproj,vitest.config.*,jest.config.*,tsconfig*.json}'];

function isPythonUnittestRunner(text) {
  if (/\bunittest\.TestCase\b/.test(text)) return true;
  if (/\bunittest\.main\s*\(/.test(text)) return true;
  if (/\bimport\s+unittest\b(?!\.mock)/.test(text)) return true;
  if (/\bfrom\s+unittest\s+import\b/.test(text)) return true;
  return false;
}

function sourceRunner(file, text, platform) {
  if (/\b(?:from\s*|require\s*\(\s*)['"]vitest['"]/.test(text)) return 'vitest';
  if (/\b(?:from\s*|require\s*\(\s*)['"]node:test['"]/.test(text)) return 'node';
  if (/\b(?:from\s*|require\s*\(\s*)['"]@jest\/globals['"]/.test(text)) return 'jest';
  if (file.endsWith('.py')) return isPythonUnittestRunner(text) ? 'unittest' : 'pytest';
  if (file.endsWith('_test.go')) return 'go';
  if (file.endsWith('.rs')) return 'cargo';
  if (file.endsWith('.java')) return 'junit';
  if (file.endsWith('.cs')) return 'dotnet';
  return platform === 'generic' ? 'custom' : 'unknown';
}

function signals(text) {
  const rules = [
    ['conditional-check', /\bif\s*\(|\bcatch\s*(?:\(|\{)/, 'Inspect conditional assertions and swallowed errors in context.'],
    ['weak-oracle', /\.(?:toBeDefined|toBeTruthy)\(|assert\.(?:ok|true)\(true\)/, 'Check that the asserted property would change when the claimed behavior breaks.'],
    ['real-timer', /\bsetTimeout\s*\(|\btime\.sleep\s*\(|\bThread\.Sleep\s*\(/, 'Determine whether this is synchronization risk or an intentional real-time contract.'],
    ['source-text-contract', /\b(?:readFileSync|read_text|readFile)\s*\(/, 'Distinguish source/config presence from execution of the claimed behavior.'],
    ['skip-or-focus', /\b(?:test|it|describe)\.(?:skip|only|todo)\b|@pytest\.mark\.skip|#\[ignore\]/, 'Reconcile optional skips and focused selection with required scope.'],
    ['uncontrolled-input', /\bMath\.random\s*\(|\bDate\.now\s*\(|\brandom\.random\s*\(/, 'Record failing input or control randomness/time where semantically relevant.'],
  ];
  return rules.flatMap(([code, regex, message]) => {
    const match = regex.exec(text);
    if (!match) return [];
    const before = text.slice(0,match.index);
    return [{code,message,authority:'lexical-candidate',verdict:'unreviewed',line:before.split('\n').length,column:match.index-before.lastIndexOf('\n'),excerpt:text.slice(match.index,match.index+240).split('\n')[0]}];
  });
}

export async function inventoryWorkspace(root, protocol) {
  root = await fs.realpath(root);
  const { spec } = protocol;
  const sources = await findFiles(root, spec.source.include, spec.source.exclude, spec.policy.maxFiles);
  const tests = await findFiles(root, spec.tests.include, spec.tests.exclude, spec.policy.maxFiles);
  const configs = [...new Set([
    ...await findFiles(root, CONFIG_PATTERNS, [...DEFAULT_EXCLUDES, ...spec.source.exclude, ...spec.tests.exclude], spec.policy.maxFiles),
    ...(spec.configFiles ?? []),
  ])];
  const paths = [...new Set([...sources, ...tests, ...configs])].sort();
  if (paths.length > spec.policy.maxFiles) throw new Error('Combined source/test scope exceeds maxFiles');
  const testSet = new Set(tests);
  const sourceSet = new Set(sources);
  const configSet = new Set(configs);
  const areas = await Promise.all(spec.areas.map(async area => [area.id, new Set(await findFiles(root, area.include, spec.tests.exclude, spec.policy.maxFiles))]));
  const lanes = await Promise.all(spec.lanes.map(async lane => [lane.id, new Set(await findFiles(root, lane.include, [...spec.tests.exclude, ...lane.exclude], spec.policy.maxFiles))]));
  const files = [], diagnostics = [];
  for (const file of paths) {
    try {
      const { data, hash, size } = await readBounded(root, file, spec.policy.maxFileBytes);
      const role = testSet.has(file) ? 'test' : configSet.has(file) ? 'configuration' : 'source';
      const record = { path: file, hash, size, role, isSource: sourceSet.has(file) };
      if (role === 'test') {
        const text = data.toString('utf8');
        record.areas = areas.filter(([, set]) => set.has(file)).map(([id]) => id);
        record.lanes = lanes.filter(([, set]) => set.has(file)).map(([id]) => id);
        record.runnerHint = sourceRunner(file, text, spec.platform);
        record.signals = signals(text);
        if (record.areas.length !== 1) diagnostics.push({ code: 'AREA_AMBIGUOUS', path: file, message: 'Every candidate test file needs exactly one declared sampling area.' });
        if (!record.lanes.length) diagnostics.push({ code: 'NO_DECLARED_LANE', path: file, message: 'Candidate has no protocol lane; actual runner registration still requires discovery.' });
        const mismatch = record.lanes.filter(id => {
          const runner = spec.lanes.find(l => l.id === id).runner;
          return record.runnerHint !== 'unknown' && runner !== 'custom' && runner !== record.runnerHint;
        });
        if (mismatch.length) diagnostics.push({ code: 'RUNNER_MISMATCH_CANDIDATE', path: file, lanes: mismatch, message: 'Source import/extension hint differs from declared runner; inspect before running.' });
      }
      files.push(record);
    } catch (error) {
      diagnostics.push({ code: 'FILE_UNREADABLE', path: file, message: error.message });
    }
  }
  if (!tests.length) diagnostics.push({ code: 'EMPTY_TEST_SCOPE', message: 'No candidate test files found; empty inventory cannot prove conformance.' });
  if (!sources.length) diagnostics.push({ code: 'EMPTY_SOURCE_SCOPE', message: 'No source files found; define the system under test explicitly.' });
  const snapshot = { root, protocolHash: digest(protocol), files: files.map(({ path, hash, role, isSource }) => ({ path, hash, role, isSource })) };
  return artifact('TestInventory', {
    root, protocolHash: digest(protocol), snapshotHash: digest(snapshot),
    complete: diagnostics.length === 0, authority: 'source-file-candidates',
    counts: { sourceFiles: files.filter(f => f.isSource).length, testFiles: files.filter(f => f.role === 'test').length, configurationFiles: files.filter(f => configSet.has(f.path)).length, testCases: null },
    files, diagnostics,
  }, { name: protocol.metadata.name });
}

/** Reproducible area sample. Its unit is explicit: source files are not cases. */
export function sampleFrame(records, { seed, size = 20, unit = 'test-file', populationHash }) {
  if (!seed || typeof seed !== 'string') throw new Error('A retained sampling seed is required');
  if (!Number.isInteger(size) || size < 1 || size > 10000) throw new Error('Sample size must be an integer from 1 to 10000');
  if (!['test-file', 'registered-case'].includes(unit)) throw new Error('Unknown sampling unit');
  const seen = new Set(), groups = new Map();
  for (const record of records) {
    if (!record.id || !record.area) throw new Error('Every sampling record requires id and area');
    if (seen.has(record.id)) throw new Error(`Duplicate sampling id: ${record.id}`);
    seen.add(record.id);
    if (!groups.has(record.area)) groups.set(record.area, []);
    groups.get(record.area).push(record);
  }
  if (!records.length) throw new Error('Cannot sample an empty frame');
  const areas = [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([area, items]) => ({
    area, population: items.length, sampled: Math.min(size, items.length), census: items.length <= size,
    records: items.map(record => ({ ...record, rank: digest(`${seed}\0${record.id}`) })).sort((a,b)=>a.rank.localeCompare(b.rank) || a.id.localeCompare(b.id)).slice(0,size),
  }));
  return artifact('TestSample', { seed, size, unit, populationHash: populationHash ?? digest([...records].sort((a,b)=>a.id.localeCompare(b.id))), method: 'sha256(seed NUL id), ascending, without replacement per area', areas });
}
