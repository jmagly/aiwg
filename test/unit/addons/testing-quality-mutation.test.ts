import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { rewritePublishedMarkdown } from '../../../tools/plugin/plugin-links.mjs';

const root = process.cwd();
const addonRoot = path.join(root, 'agentic/code/addons/testing-quality');
const pluginRoot = path.join(root, 'agentic/code/plugins/testing-quality');
const scriptRelative = 'skills/mutation-test/scripts/native_extension_preflight.py';
const helperRelative = 'skills/mutation-test/scripts/aiwg_mutation_native_probe.py';
const fixture = path.join(
  root,
  'test/fixtures/testing-quality/native-extension/test_native_extension.py',
);
const crashLog = path.join(
  root,
  'test/fixtures/testing-quality/native-extension/mutmut-stats-crash.log',
);

function runPreflight(...args: string[]) {
  return spawnSync(
    'python3',
    [path.join(addonRoot, scriptRelative), ...args, '--format', 'json'],
    { timeout: 60_000, cwd: root, encoding: 'utf8' },
  );
}

describe('testing-quality mutation native-extension preflight', () => {
  it('returns a clear diagnostic for an isolated native-extension import', () => {
    const result = runPreflight('--import-file', fixture);

    expect(result.signal).toBeNull();
    expect(result.status).toBe(2);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('blocked');
    expect(report.classification).toBe('harness_native_extension_reload_risk');
    expect(report.execution_mode).toBe('subprocess-isolated-native-extension-preflight');
    expect(report.native_extensions).toEqual(expect.arrayContaining([
      expect.objectContaining({ module: '_sqlite3' }),
    ]));
    expect(report.fallback.allowed).toBe(false);
    expect(report.fallback.missing_bounds).toEqual([
      '--mutation-target',
      '--estimated-mutants',
      '--runtime-budget-seconds',
      '--max-children',
    ]);
    expect(report.evidence.mutant_outcomes_recorded).toBe(false);
  });

  it('allows only an explicitly targeted fallback that fits the runtime budget', () => {
    const result = runPreflight(
      '--import-file', fixture,
      '--mutation-target', 'package/numerical_contracts.py',
      '--estimated-mutants', '4',
      '--max-children', '4',
      '--runtime-budget-seconds', '60',
    );

    expect(result.status).toBe(2);
    const report = JSON.parse(result.stdout);
    expect(report.fallback.allowed).toBe(true);
    expect(report.fallback.mutate_only_covered_lines).toBe(false);
    expect(report.fallback.within_budget).toBe(true);
    expect(report.fallback.mutation_targets).toEqual(['package/numerical_contracts.py']);
  });

  it('rejects an explicitly bounded fallback when its estimated runtime exceeds budget', () => {
    const result = runPreflight(
      '--import-file', fixture,
      '--mutation-target', 'package/numerical_contracts.py',
      '--estimated-mutants', '1000000000',
      '--max-children', '1',
      '--runtime-budget-seconds', '0.001',
    );

    expect(result.status).toBe(2);
    const report = JSON.parse(result.stdout);
    expect(report.fallback.missing_bounds).toEqual([]);
    expect(report.fallback.mutation_targets).toEqual(['package/numerical_contracts.py']);
    expect(report.fallback.estimated_runtime_seconds).toBeGreaterThan(report.fallback.runtime_budget_seconds);
    expect(report.fallback.within_budget).toBe(false);
    expect(report.fallback.allowed).toBe(false);
  });

  it('classifies stats-phase native reload crashes as harness failures', () => {
    const result = runPreflight('--classify-mutmut-log', crashLog);

    expect(result.status).toBe(2);
    const report = JSON.parse(result.stdout);
    expect(report.classification).toBe('harness_tool_failure_native_extension_reload');
    expect(report.mutmut_log.counts_as_mutant_outcome).toBe(false);
    expect(report.evidence.harness_or_tool_failure).toBe(true);
    expect(report.evidence.project_test_failure).toBe(false);
  });

  it('keeps canonical and plugin executable support files byte-identical', async () => {
    for (const relative of [scriptRelative, helperRelative]) {
      expect(await readFile(path.join(pluginRoot, relative), 'utf8')).toBe(
        await readFile(path.join(addonRoot, relative), 'utf8'),
      );
    }
  });

  it('keeps addon, plugin mirror, and published testing-quality docs synchronized', async () => {
    const normalizePlugin = (content: string) => content
      .replaceAll('${CLAUDE_PLUGIN_ROOT}', 'agentic/code/addons/testing-quality')
      .replace(/[ \t]+$/gm, '');
    for (const relative of [
      'README.md',
      'docs/overview.md',
      'docs/quickstart.md',
      'skills/mutation-test/SKILL.md',
    ]) {
      expect(normalizePlugin(await readFile(path.join(pluginRoot, relative), 'utf8'))).toBe(
        normalizePlugin(rewritePublishedMarkdown(
          await readFile(path.join(addonRoot, relative), 'utf8'),
          path.join(pluginRoot, relative), pluginRoot, root,
        )),
      );
    }
    for (const relative of ['overview.md', 'quickstart.md']) {
      expect(await readFile(path.join(root, 'docs/addons/testing-quality', relative), 'utf8')).toBe(
        await readFile(path.join(addonRoot, 'docs', relative), 'utf8'),
      );
    }
  });
});
