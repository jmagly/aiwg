import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from '../../helpers/temp-dir.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import {
  ALLOWLIST_RELATIVE_PATH,
  buildReExportIndex,
  findInteractiveMarkers,
  findUnboundedCalls as rawFindUnboundedCalls,
  TEST_PROCESS_TIMEOUT_MS,
  toPosixPath,
  validateAllowList,
} from '../../../tools/testing/check-sync-child-process-timeouts.mjs';

const gateScript = fileURLToPath(new URL('../../../tools/testing/check-sync-child-process-timeouts.mjs', import.meta.url));

// These original fixtures exercise timeout validation independently of kill policy.
function findUnboundedCalls(file, source, ...rest) {
  return rawFindUnboundedCalls(file === 'fixture.ts' ? 'tools/testing/fixture.ts' : file, source.replace(/timeout\s*:/g, "killSignal: 'SIGKILL', timeout:"), ...rest);
}

describe('synchronous child-process timeout gate', () => {
  it('flags each synchronous API when its options omit a timeout', () => {
    const source = `
      execSync('git status', { encoding: 'utf8' });
      execFileSync('git', ['status']);
      spawnSync('git', ['status'], { stdio: 'pipe' });
    `;

    expect(findUnboundedCalls('fixture.ts', source).map(({ api }) => api)).toEqual([
      'execSync',
      'execFileSync',
      'spawnSync',
    ]);
  });

  it('accepts explicit timeouts on all synchronous APIs', () => {
    const source = `
      execSync('git status', { timeout: ${TEST_PROCESS_TIMEOUT_MS} });
      execFileSync('git', ['status'], { timeout: ${TEST_PROCESS_TIMEOUT_MS} });
      spawnSync('git', ['status'], { timeout: ${TEST_PROCESS_TIMEOUT_MS} });
    `;

    expect(findUnboundedCalls('fixture.ts', source)).toEqual([]);
  });

  it('does not flag calls that go through the bounded helper (#3062)', () => {
    const source = `
      boundedExecSync('git status', 'quick', { encoding: 'utf8' });
      boundedExecFileSync('git', ['status'], 'quick');
      boundedSpawnSync('git', ['status'], 'network', { stdio: 'pipe' });
    `;

    expect(findUnboundedCalls('fixture.ts', source)).toEqual([]);
  });
});

describe('findUnboundedCalls — resolves bindings, not just spelling (#3062 finding 3)', () => {
  it('flags an aliased named import (the actual reported miss: execSync as nodeExecSync)', () => {
    const source = `
      import { execSync as nodeExecSync } from 'child_process';
      nodeExecSync('git status');
    `;
    expect(findUnboundedCalls('fixture.ts', source).map(({ api }) => api)).toEqual(['execSync']);
  });

  it('does not flag the aliased import once it has a provably positive timeout', () => {
    const source = `
      import { execSync as nodeExecSync } from 'child_process';
      nodeExecSync('git status', { timeout: 30_000 });
    `;
    expect(findUnboundedCalls('fixture.ts', source)).toEqual([]);
  });

  it('flags a default/namespace import used through a reassigned local', () => {
    const source = `
      import cp from 'node:child_process';
      const run = cp.execSync;
      run('git status');
    `;
    expect(findUnboundedCalls('fixture.ts', source).map(({ api }) => api)).toEqual(['execSync']);
  });

  it('flags require() destructuring with a rename', () => {
    const source = `
      const { spawnSync: sp } = require('child_process');
      sp('git', ['status']);
    `;
    expect(findUnboundedCalls('fixture.ts', source).map(({ api }) => api)).toEqual(['spawnSync']);
  });

  it('flags a simple same-file reassignment of the raw identifier', () => {
    const source = `
      import { execFileSync } from 'node:child_process';
      const run = execFileSync;
      run('git', ['status']);
    `;
    expect(findUnboundedCalls('fixture.ts', source).map(({ api }) => api)).toEqual(['execFileSync']);
  });

  it('flags static computed property access (cp["spawnSync"])', () => {
    const source = `
      import cp from 'node:child_process';
      cp['spawnSync']('git', ['status']);
    `;
    expect(findUnboundedCalls('fixture.ts', source).map(({ api }) => api)).toEqual(['spawnSync']);
  });

  it('flags a reassignment via computed element access (const run = cp[\'execSync\']) (#3062 B/C finding 8)', () => {
    const source = `
      import cp from 'node:child_process';
      const run = cp['execSync'];
      run('git status');
    `;
    expect(findUnboundedCalls('fixture.ts', source).map(({ api }) => api)).toEqual(['execSync']);
  });

  it('flags namespace destructuring with a rename (const { execSync: x } = cp) (#3062 B/C finding 8)', () => {
    const source = `
      import * as cp from 'node:child_process';
      const { execSync: x } = cp;
      x('git status');
    `;
    expect(findUnboundedCalls('fixture.ts', source).map(({ api }) => api)).toEqual(['execSync']);
  });

  it('flags namespace destructuring without a rename (const { spawnSync } = cp)', () => {
    const source = `
      import cp from 'node:child_process';
      const { spawnSync } = cp;
      spawnSync('git', ['status']);
    `;
    expect(findUnboundedCalls('fixture.ts', source).map(({ api }) => api)).toEqual(['spawnSync']);
  });
});

describe('findUnboundedCalls / buildReExportIndex — resolves a re-export from another local module (#3062 B/C finding 8)', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function writeFiles(entries) {
    dir = mkdtempSync(join(tmpdir(), 'aiwg-sync-spawn-reexport-'));
    const paths = {};
    for (const [name, content] of Object.entries(entries)) {
      const filePath = join(dir, name);
      writeFileSync(filePath, content);
      paths[name] = filePath;
    }
    return paths;
  }

  it('flags a call through a binding re-exported (and renamed) from node:child_process by a sibling file', () => {
    const paths = writeFiles({
      'raw.ts': "export { execSync as runSync } from 'node:child_process';\n",
      'caller.ts': "import { runSync } from './raw.ts';\nrunSync('git status');\n",
    });
    const reExportIndex = buildReExportIndex([paths['raw.ts'], paths['caller.ts']]);
    const findings = findUnboundedCalls('caller.ts', readFileSync(paths['caller.ts'], 'utf8'), {
      absoluteFile: paths['caller.ts'],
      reExportIndex,
    });
    expect(findings.map(({ api }) => api)).toEqual(['execSync']);
  });

  it('flags a call through a two-hop re-export chain', () => {
    const paths = writeFiles({
      'raw.ts': "export { execSync as runSync } from 'node:child_process';\n",
      'middle.ts': "export { runSync as go } from './raw.ts';\n",
      'caller.ts': "import { go } from './middle.ts';\ngo('git status');\n",
    });
    const reExportIndex = buildReExportIndex([paths['raw.ts'], paths['middle.ts'], paths['caller.ts']]);
    const findings = findUnboundedCalls('caller.ts', readFileSync(paths['caller.ts'], 'utf8'), {
      absoluteFile: paths['caller.ts'],
      reExportIndex,
    });
    expect(findings.map(({ api }) => api)).toEqual(['execSync']);
  });

  it('does not flag an import of an unrelated re-exported name', () => {
    const paths = writeFiles({
      'raw.ts': "export { execSync as runSync } from 'node:child_process';\nexport function helper() {}\n",
      'caller.ts': "import { helper } from './raw.ts';\nhelper();\n",
    });
    const reExportIndex = buildReExportIndex([paths['raw.ts'], paths['caller.ts']]);
    const findings = findUnboundedCalls('caller.ts', readFileSync(paths['caller.ts'], 'utf8'), {
      absoluteFile: paths['caller.ts'],
      reExportIndex,
    });
    expect(findings).toEqual([]);
  });

  it('without crossFile context (e.g. a bare unit-test call), a re-export is simply invisible, not mis-flagged', () => {
    const source = "import { runSync } from './raw.ts';\nrunSync('git status');";
    expect(findUnboundedCalls('fixture.ts', source)).toEqual([]);
  });
});

describe('findUnboundedCalls — requires a provably positive timeout (#3062 finding 4)', () => {
  it('flags timeout: 0', () => {
    const source = "execSync('git status', { timeout: 0 });";
    expect(findUnboundedCalls('fixture.ts', source)).toHaveLength(1);
  });

  it('flags timeout: undefined', () => {
    const source = "execSync('git status', { timeout: undefined });";
    expect(findUnboundedCalls('fixture.ts', source)).toHaveLength(1);
  });

  it('flags a negative numeric literal timeout', () => {
    const source = "execSync('git status', { timeout: -1 });";
    expect(findUnboundedCalls('fixture.ts', source)).toHaveLength(1);
  });

  it('accepts a simple positive constant arithmetic expression', () => {
    const source = "execSync('git status', { timeout: 30 * 1000 });";
    expect(findUnboundedCalls('fixture.ts', source)).toEqual([]);
  });

  it('flags a positive timeout literal followed by a spread that could override it', () => {
    const source = "execSync('git status', { timeout: 1000, ...options });";
    expect(findUnboundedCalls('fixture.ts', source)).toHaveLength(1);
  });

  it('accepts a positive timeout literal that comes after a spread (spread cannot override it)', () => {
    const source = "execSync('git status', { ...options, timeout: 1000 });";
    expect(findUnboundedCalls('fixture.ts', source)).toEqual([]);
  });

  it('still flags a forwarded, unresolved options object (unchanged — not a regression)', () => {
    const source = "execSync('git status', options);";
    expect(findUnboundedCalls('fixture.ts', source)).toHaveLength(1);
  });

  it('flags an identifier-valued timeout that does not resolve to a same-file const literal (#3062 B/C finding 8)', () => {
    // Tightened rule: "any expression not provably bad" used to be
    // accepted, which let a caller-controlled, unvalidated value (an
    // options property, a function parameter) through unchecked. A plain
    // identifier must now actually resolve to a same-file `const` numeric
    // literal; a parameter like `warmTimeoutMs` with no such declaration
    // does not, so this must go through the bounded helper instead.
    const source = "execSync('git status', { timeout: warmTimeoutMs });";
    expect(findUnboundedCalls('fixture.ts', source)).toHaveLength(1);
  });

  it('accepts an identifier timeout that resolves to a same-file const positive literal', () => {
    const source = "const DEFAULT_TIMEOUT_MS = 30_000;\nexecSync('git status', { timeout: DEFAULT_TIMEOUT_MS });";
    expect(findUnboundedCalls('fixture.ts', source)).toEqual([]);
  });

  it('flags an identifier timeout resolving to a same-file const that is not positive', () => {
    const source = "const DEFAULT_TIMEOUT_MS = 0;\nexecSync('git status', { timeout: DEFAULT_TIMEOUT_MS });";
    expect(findUnboundedCalls('fixture.ts', source)).toHaveLength(1);
  });

  it('flags an identifier timeout resolving to a let (reassignable, so not provable)', () => {
    const source = "let defaultTimeoutMs = 30_000;\nexecSync('git status', { timeout: defaultTimeoutMs });";
    expect(findUnboundedCalls('fixture.ts', source)).toHaveLength(1);
  });

  it('flags a property-access timeout (e.g. options.timeout) even when options looks validated elsewhere', () => {
    const source = "const options = { timeout: 30000 };\nexecSync('git status', { timeout: options.timeout });";
    expect(findUnboundedCalls('fixture.ts', source)).toHaveLength(1);
  });

  it('flags a shorthand `{ timeout }` property referencing an unresolvable variable (#3062 B/C finding 8)', () => {
    // Regression: object shorthand (`{ cwd, timeout }`) is a
    // ShorthandPropertyAssignment, not a PropertyAssignment — resolved the
    // same way as a property-assignment value, so an unresolvable
    // shorthand is rejected under the tightened rule just like
    // `{ timeout: warmTimeoutMs }` is.
    const source = 'execSync(cmd, { encoding: "utf-8", cwd, timeout });';
    expect(findUnboundedCalls('fixture.ts', source)).toHaveLength(1);
  });

  it('accepts a shorthand `{ timeout }` property referencing a same-file const positive literal', () => {
    const source = 'const timeout = 30_000;\nexecSync(cmd, { encoding: "utf-8", killSignal: "SIGKILL", timeout });';
    expect(findUnboundedCalls('fixture.ts', source)).toEqual([]);
  });

  it('accepts a call to the gate-trusted positiveTimeoutMs helper, regardless of its argument', () => {
    const source = [
      "import { positiveTimeoutMs } from '../../src/process/bounded-child-process.mjs';",
      "execSync('git status', { timeout: positiveTimeoutMs(userSuppliedValue, 30_000) });",
    ].join('\n');
    expect(findUnboundedCalls('fixture.ts', source)).toEqual([]);
  });

  it('accepts a renamed positiveTimeoutMs helper binding', () => {
    const source = [
      "import { positiveTimeoutMs as clampTimeout } from '../../src/process/bounded-child-process.mjs';",
      "execSync('git status', { timeout: clampTimeout(userSuppliedValue, 30_000) });",
    ].join('\n');
    expect(findUnboundedCalls('fixture.ts', source)).toEqual([]);
  });

  it('accepts positiveTimeoutMs through the verified implementation resolver', () => {
    const source = [
      "import { importImpl } from '../../tools/_resolve-impl.mjs';",
      "const { positiveTimeoutMs } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');",
      "execSync('git status', { timeout: positiveTimeoutMs(userSuppliedValue, 30_000) });",
    ].join('\n');
    expect(findUnboundedCalls('fixture.ts', source)).toEqual([]);
  });

  it('does not accept a call to an untrusted function as a timeout value', () => {
    const source = "execSync('git status', { timeout: computeTimeout(userSuppliedValue) });";
    expect(findUnboundedCalls('fixture.ts', source)).toHaveLength(1);
  });

  it('flags a duplicate quoted/computed timeout key that overrides an earlier literal (#3062 B/C finding 8)', () => {
    // Object literals let a later key of the same name win; a computed
    // ['timeout'] key is the same key as a plain `timeout:` property, so
    // it must be recognized, not skipped as an opaque computed name.
    const source = "execSync('git status', { timeout: 1000, ['timeout']: 0 });";
    expect(findUnboundedCalls('fixture.ts', source)).toHaveLength(1);
  });

  it('accepts a duplicate quoted/computed timeout key when the later one is itself positive', () => {
    const source = 'execSync(\'git status\', { timeout: 0, ["timeout"]: 30_000 });';
    expect(findUnboundedCalls('fixture.ts', source)).toEqual([]);
  });
});

describe('findInteractiveMarkers (#3062)', () => {
  it('finds a `// sync-spawn: interactive <anchor>` marker and lower-cases the anchor', () => {
    const source = [
      'function f() {',
      '  // sync-spawn: interactive Editor-Launch — opens $EDITOR',
      '  execSync(cmd, { stdio: "inherit" });',
      '}',
    ].join('\n');

    expect(findInteractiveMarkers('fixture.ts', source)).toEqual([
      { file: 'fixture.ts', line: 2, anchor: 'editor-launch' },
    ]);
  });

  it('ignores lines that are not sync-spawn markers', () => {
    const source = '// a normal comment\nexecSync(cmd);\n';
    expect(findInteractiveMarkers('fixture.ts', source)).toEqual([]);
  });

  it('ignores marker-shaped text inside a string literal — only real comment tokens count (#3062 finding 16)', () => {
    const source = [
      'function f() {',
      '  const s = "// sync-spawn: interactive not-a-real-marker";',
      '  execSync(cmd, { stdio: "inherit" });',
      '}',
    ].join('\n');

    expect(findInteractiveMarkers('fixture.ts', source)).toEqual([]);
  });

  it('ignores marker-shaped text inside a template literal', () => {
    const source = [
      'function f() {',
      '  const s = `// sync-spawn: interactive not-a-real-marker`;',
      '  execSync(cmd, { stdio: "inherit" });',
      '}',
    ].join('\n');

    expect(findInteractiveMarkers('fixture.ts', source)).toEqual([]);
  });

  it('still finds a marker after an interpolated template literal earlier in the same file', () => {
    // Regression, reproduced against the real src/config/cli.ts: an
    // earlier implementation collected comments with a standalone
    // `ts.createScanner` pass, blind to syntax. A bare scanner has no
    // parser context, so it cannot re-scan a template literal's `${...}`
    // substitutions the way the parser does; mis-tokenizing one desyncs
    // every subsequent token position, silently dropping every later
    // comment — including that file's real `editor-launch` allow-list
    // marker, hundreds of lines after the template literal below (itself
    // adapted from the real source: a string built from two interpolated
    // templates, one nested inside a ternary).
    const source = [
      'process.stderr.write(',
      "  `Note: '${raw}' is a deprecated alias for '${aliased}'; writing '${aliased}'.\\n`",
      '  + (notes[key] ? `      ${notes[key]}\\n` : ""),',
      ');',
      'function f() {',
      '  // sync-spawn: interactive editor-launch',
      '  execSync(cmd, { stdio: "inherit" });',
      '}',
    ].join('\n');

    expect(findInteractiveMarkers('fixture.ts', source)).toEqual([
      { file: 'fixture.ts', line: 6, anchor: 'editor-launch' },
    ]);
  });
});

describe('toPosixPath — Windows allow-list key normalization (#3062 finding 15)', () => {
  it('normalizes a Windows-style (backslash) relative path to POSIX separators', () => {
    // path.win32.relative() always returns backslash separators,
    // regardless of the OS this test actually runs on — exercising the
    // Windows case without requiring a Windows runner.
    const windowsStyle = path.win32.relative('C:\\repo', 'C:\\repo\\src\\cli\\handlers\\session.ts');
    expect(windowsStyle).toBe('src\\cli\\handlers\\session.ts');
    expect(toPosixPath(windowsStyle)).toBe('src/cli/handlers/session.ts');
  });

  it('leaves an already-POSIX relative path unchanged', () => {
    expect(toPosixPath('src/cli/handlers/session.ts')).toBe('src/cli/handlers/session.ts');
  });
});

describe('validateAllowList (#3062)', () => {
  it('passes when every entry has kind "interactive" and exactly one attached marker', () => {
    const allowList = { entries: [{ file: 'src/a.ts', anchor: 'foo', kind: 'interactive' }] };
    const attachedMarkerCountByKey = new Map([['src/a.ts::foo', 1]]);
    expect(validateAllowList(allowList, attachedMarkerCountByKey)).toEqual([]);
  });

  it('fails a stale entry — listed but no marker attached to a call', () => {
    const allowList = { entries: [{ file: 'src/a.ts', anchor: 'gone', kind: 'interactive' }] };
    const problems = validateAllowList(allowList, new Map());
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('stale');
  });

  it('fails an entry whose kind is not "interactive"', () => {
    const allowList = { entries: [{ file: 'src/a.ts', anchor: 'foo', kind: 'long-running' }] };
    const attachedMarkerCountByKey = new Map([['src/a.ts::foo', 1]]);
    const problems = validateAllowList(allowList, attachedMarkerCountByKey);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('unsupported kind');
  });

  it('fails a duplicate allow-list entry for the same file+anchor (#3062 finding 16)', () => {
    const allowList = {
      entries: [
        { file: 'src/a.ts', anchor: 'foo', kind: 'interactive' },
        { file: 'src/a.ts', anchor: 'foo', kind: 'interactive' },
      ],
    };
    const attachedMarkerCountByKey = new Map([['src/a.ts::foo', 1]]);
    const problems = validateAllowList(allowList, attachedMarkerCountByKey);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('duplicate');
  });

  it('fails an ambiguous entry — the anchor is attached to more than one call (#3062 finding 16)', () => {
    const allowList = { entries: [{ file: 'src/a.ts', anchor: 'foo', kind: 'interactive' }] };
    const attachedMarkerCountByKey = new Map([['src/a.ts::foo', 2]]);
    const problems = validateAllowList(allowList, attachedMarkerCountByKey);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('ambiguous');
  });
});

describe('CLI — product-code report vs enforce mode (#3062)', () => {
  let fixtureRoot;

  afterEach(() => {
    if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
    fixtureRoot = undefined;
  });

  function writeFixture({ allowListEntries = [] } = {}) {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'aiwg-sync-spawn-gate-'));
    mkdirSync(join(fixtureRoot, 'src'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'tools', 'testing'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'bin'), { recursive: true });

    // One bounded (helper) call, one allow-listed interactive call, one plain violation.
    writeFileSync(
      join(fixtureRoot, 'src', 'example.ts'),
      [
        "import { boundedSpawnSync } from '../process/bounded-child-process.mjs';",
        'function ok() {',
        "  boundedSpawnSync('git', ['status'], 'quick');",
        '}',
        'function interactive() {',
        '  // sync-spawn: interactive editor-launch — opens $EDITOR',
        "  execSync('vi config.yaml', { stdio: 'inherit' });",
        '}',
        'function violation() {',
        "  spawnSync('git', ['status']);",
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(fixtureRoot, 'tools', 'testing', 'sync-spawn-allowlist.json'),
      JSON.stringify({ entries: allowListEntries }, null, 2),
    );
    return fixtureRoot;
  }

  it('report mode (default) never fails, even with product-code violations present', () => {
    const root = writeFixture({
      allowListEntries: [{ file: 'src/example.ts', anchor: 'editor-launch', kind: 'interactive', reason: 'test' }],
    });

    const result = spawnSync(process.execPath, [gateScript, '--root', root], { encoding: 'utf8', timeout: 30_000 });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('src: 1 unbounded (1 allow-listed interactive)');
  });

  it('--enforce-product fails when a non-allow-listed violation is present', () => {
    const root = writeFixture({
      allowListEntries: [{ file: 'src/example.ts', anchor: 'editor-launch', kind: 'interactive', reason: 'test' }],
    });

    const result = spawnSync(process.execPath, [gateScript, '--root', root, '--enforce-product'], { encoding: 'utf8', timeout: 30_000 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("spawnSync has no positive timeout with SIGKILL, does not go through the bounded helper, and is not on the allow-list");
  });

  it('fails (even in report mode) on a stale allow-list entry', () => {
    const root = writeFixture({
      allowListEntries: [{ file: 'src/example.ts', anchor: 'editor-launch', kind: 'interactive', reason: 'test' }, { file: 'src/example.ts', anchor: 'nonexistent', kind: 'interactive', reason: 'stale' }],
    });

    const result = spawnSync(process.execPath, [gateScript, '--root', root], { encoding: 'utf8', timeout: 30_000 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(ALLOWLIST_RELATIVE_PATH);
    expect(result.stderr).toContain('stale');
  });

  it('fails (even in report mode) on an allow-list entry with an unsupported kind', () => {
    const root = writeFixture({
      allowListEntries: [{ file: 'src/example.ts', anchor: 'editor-launch', kind: 'destructive', reason: 'bad kind' }],
    });

    const result = spawnSync(process.execPath, [gateScript, '--root', root], { encoding: 'utf8', timeout: 30_000 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unsupported kind');
  });

  it('fails (even in report mode) on a duplicate allow-list entry (#3062 finding 16)', () => {
    const root = writeFixture({
      allowListEntries: [
        { file: 'src/example.ts', anchor: 'editor-launch', kind: 'interactive', reason: 'test' },
        { file: 'src/example.ts', anchor: 'editor-launch', kind: 'interactive', reason: 'duplicate' },
      ],
    });

    const result = spawnSync(process.execPath, [gateScript, '--root', root], { encoding: 'utf8', timeout: 30_000 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('duplicate');
  });

  it('fails (even in report mode) on an ambiguous anchor attached to two different calls (#3062 finding 16)', () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'aiwg-sync-spawn-gate-'));
    mkdirSync(join(fixtureRoot, 'src'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'tools', 'testing'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'bin'), { recursive: true });

    // Same anchor text reused on two distinct calls — the registry entry
    // cannot tell which one it is meant to exempt.
    writeFileSync(
      join(fixtureRoot, 'src', 'example.ts'),
      [
        'function first() {',
        '  // sync-spawn: interactive editor-launch — opens $EDITOR',
        "  execSync('vi config.yaml', { stdio: 'inherit' });",
        '}',
        'function second() {',
        '  // sync-spawn: interactive editor-launch — opens $EDITOR',
        "  execSync('vi other.yaml', { stdio: 'inherit' });",
        '}',
        '',
      ].join('\n'),
    );
    writeFileSync(
      join(fixtureRoot, 'tools', 'testing', 'sync-spawn-allowlist.json'),
      JSON.stringify({
        entries: [{ file: 'src/example.ts', anchor: 'editor-launch', kind: 'interactive', reason: 'test' }],
      }, null, 2),
    );

    const result = spawnSync(process.execPath, [gateScript, '--root', fixtureRoot], { encoding: 'utf8', timeout: 30_000 });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ambiguous');
  });
  it('reports, without failing, an unbounded call in a benchmark source that checked-in evidence pins', async () => {
    const { loadEvidencePinnedBenchmarkSources, BENCHMARK_CLAIMS_RELATIVE_PATH } = await import('../../../tools/testing/check-sync-child-process-timeouts.mjs');
    const fsMod = await import('node:fs');
    const pathMod = await import('node:path');
    const osMod = await import('node:os');
    const root = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'aiwg-gate-pinned-'));
    try {
      fsMod.mkdirSync(pathMod.dirname(pathMod.join(root, BENCHMARK_CLAIMS_RELATIVE_PATH)), { recursive: true });
      fsMod.writeFileSync(pathMod.join(root, BENCHMARK_CLAIMS_RELATIVE_PATH), JSON.stringify({
        claims: [{ id: 'c', sourceFiles: ['tools/benchmarks/pinned.ts', 'src/not-a-benchmark.ts', 'tools/cli/also-not.mjs'] }],
      }));
      // Only files under tools/benchmarks/ that a claim lists are exempt.
      expect([...loadEvidencePinnedBenchmarkSources(root)]).toEqual(['tools/benchmarks/pinned.ts']);
      fsMod.rmSync(pathMod.join(root, BENCHMARK_CLAIMS_RELATIVE_PATH));
      expect(loadEvidencePinnedBenchmarkSources(root).size).toBe(0);
    } finally {
      fsMod.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('product timeout hardening (#3078)', () => {
  it.each([
    "{ timeout: 1000, 'timeout': 0, killSignal: 'SIGKILL' }",
    "{ timeout: 1000, [key]: 0, killSignal: 'SIGKILL' }",
    "{ timeout: 1000, ['time' + 'out']: 0, killSignal: 'SIGKILL' }",
    "{ timeout: 1000, killSignal: 'SIGKILL', ['kill' + 'Signal']: 'SIGTERM' }",
    "{ timeout: 1000 }",
    "{ timeout: 1000, killSignal: 'SIGTERM' }",
  ])('rejects an overridable or soft bound: %s', options => {
    expect(rawFindUnboundedCalls('fixture.ts', `spawnSync('child', [], ${options});`)).toHaveLength(1);
  });
  it.each([
    'const ms = 1000; function run() { const ms = options.timeout; CALL }',
    'const ms = 1000; function run(ms) { CALL }',
    'const ms = 0; function other() { const ms = 1000; } CALL',
  ])('resolves the actual timeout binding: %s', source => {
    expect(rawFindUnboundedCalls('fixture.ts', source.replace('CALL', "spawnSync('child', [], {timeout: ms, killSignal: 'SIGKILL'});"))).toHaveLength(1);
  });
  it.each([
    'const { positiveTimeoutMs } = unrelated();',
    "import { positiveTimeoutMs } from './unrelated.mjs';",
    "const { positiveTimeoutMs } = await importImpl(import.meta.url, 'process/bounded-child-process.mjs');",
    "import { positiveTimeoutMs } from '../../src/process/bounded-child-process.mjs'; function run(positiveTimeoutMs) { CALL }",
  ])('rejects unverified helper bindings: %s', declaration => {
    const call = "spawnSync('child', [], {timeout: positiveTimeoutMs(input, 1000), killSignal: 'SIGKILL'});";
    expect(rawFindUnboundedCalls('fixture.ts', declaration.includes('CALL') ? declaration.replace('CALL', call) : declaration + call)).toHaveLength(1);
  });
  it('accepts a hard bound and rejects a nonfinite bound', () => {
    expect(rawFindUnboundedCalls('fixture.ts', "spawnSync('child', [], {timeout: 1000, killSignal: 'SIGKILL'});")).toHaveLength(0);
    expect(rawFindUnboundedCalls('fixture.ts', "spawnSync('child', [], {timeout: 1e999, killSignal: 'SIGKILL'});")).toHaveLength(1);
  });
});
