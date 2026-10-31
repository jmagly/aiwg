import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const publishWorkflow = readFileSync(
  path.join(ROOT, '.github/workflows/npm-publish.yml'),
  'utf8',
);
const socketWorkflow = readFileSync(
  path.join(ROOT, '.github/workflows/socket-post-publish.yml'),
  'utf8',
);
const socketRunbook = readFileSync(
  path.join(ROOT, 'docs/contributing/socket-post-publish-audit.md'),
  'utf8',
);
const visibilityStep = socketWorkflow.split('      - name: Wait for published npm versions\n')[1]
  ?.split('\n      - name:')[0] ?? '';
const visibilityScript = visibilityStep.split('        run: |\n')[1]
  ?.replace(/^ {10}/gm, '') ?? '';
const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runVisibility(scenario, minutes = '1') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'socket-npm-visibility-'));
  tempDirs.push(dir);
  writeFileSync(path.join(dir, 'clock'), '0\n');
  writeFileSync(path.join(dir, 'calls'), '');
  writeFileSync(path.join(dir, 'output'), '');
  writeFileSync(path.join(dir, 'summary'), '');
  // Replace registry calls and time with deterministic shell functions: no network or timers.
  const stubs = `
date() { cat "$evidence_dir/clock"; }
sleep() { echo $(( $(date) + $1 )) > "$evidence_dir/clock"; }
timeout() {
  echo "$1" >> "$evidence_dir/request-bounds"
  if [ "$TEST_SCENARIO" = stalled ]; then
    sleep "$1"
    return 124
  fi
  if [ "$TEST_SCENARIO" = slow-missing ]; then sleep 11; fi
  shift
  "$@"
}
npm() {
  printf '%s\\n' "$*" >> "$evidence_dir/calls"
  if [ "$2" = "@aiwg/cockpit@$VERSION" ]; then
    case "$TEST_SCENARIO" in
      missing|slow-missing) return 1 ;;
      delayed) if [ "$(date)" -lt 30 ]; then return 1; fi ;;
      wrong-version) echo 0.0.0; return 0 ;;
    esac
  fi
  echo "$VERSION"
}
`;
  const version = '2026.10.6';
  const commit = '1234567890abcdef1234567890abcdef12345678';
  execFileSync('/bin/sh', ['-c', stubs + visibilityScript], {
    env: {
      PATH: process.env.PATH,
      TEST_SCENARIO: scenario,
      NPM_VISIBILITY_WAIT_MINUTES: minutes,
      VERSION: version,
      COMMIT: commit,
      RELEASE_REF: `refs/tags/v${version}`,
      evidence_dir: dir,
      GITHUB_OUTPUT: path.join(dir, 'output'),
      GITHUB_STEP_SUMMARY: path.join(dir, 'summary'),
    },
    timeout: 5000,
    stdio: 'pipe',
  });
  return {
    read: (name) => readFileSync(path.join(dir, name), 'utf8'),
    command: `gh workflow run socket-post-publish.yml --repo jmagly/aiwg --ref main -f version=${version} -f tag=v${version} -f commit=${commit}`,
  };
}

test('npm publication invokes the release-tag Socket workflow', () => {
  assert.match(
    publishWorkflow,
    /publish-to-npmjs-org:[\s\S]*?outputs:\s*\n\s*version: \$\{\{ steps\.version\.outputs\.version \}\}\s*\n\s*commit: \$\{\{ steps\.release_source\.outputs\.commit \}\}/,
  );
  assert.match(
    publishWorkflow,
    /socket-post-publish:[\s\S]*?needs: publish-to-npmjs-org[\s\S]*?uses: \.\/\.github\/workflows\/socket-post-publish\.yml/,
  );
  assert.match(
    publishWorkflow,
    /version: \$\{\{ needs\.publish-to-npmjs-org\.outputs\.version \}\}/,
  );
  assert.match(
    publishWorkflow,
    /id: release_source[\s\S]*?echo "commit=\$\(git rev-parse HEAD\)" >> "\$GITHUB_OUTPUT"/,
  );
  assert.match(
    publishWorkflow,
    /commit: \$\{\{ needs\.publish-to-npmjs-org\.outputs\.commit \}\}/,
  );
  assert.doesNotMatch(publishWorkflow, /commit: \$\{\{ github\.sha \}\}/);
  assert.match(
    publishWorkflow,
    /SOCKET_API_TOKEN: \$\{\{ secrets\.SOCKET_API_TOKEN \}\}/,
  );
});

test('Socket uses exact call inputs instead of default-branch workflow_run', () => {
  assert.match(socketWorkflow, /workflow_call:/);
  assert.doesNotMatch(socketWorkflow, /workflow_run:/);
  assert.match(socketWorkflow, /workflow_dispatch:/);
  assert.match(socketWorkflow, /ref: \$\{\{ inputs\.tag \|\| github\.ref \}\}/);
  assert.match(
    socketWorkflow,
    /if \[ "\$RELEASE_REF" != "refs\/tags\/v\$\{VERSION\}" \]; then/,
  );
  assert.match(
    socketWorkflow,
    /TAG_COMMIT="\$\(git -c safe\.directory="\$GITHUB_WORKSPACE" rev-parse "\$\{RELEASE_REF\}\^\{commit\}"\)"/,
  );
  assert.match(
    socketWorkflow,
    /if \[ "\$TAG_COMMIT" != "\$EXPECTED_COMMIT" \]; then/,
  );
  assert.match(
    socketWorkflow,
    /if \[ "\$ACTUAL_COMMIT" != "\$TAG_COMMIT" \]; then/,
  );
});

test('Socket scanner evidence remains fail closed', () => {
  assert.match(socketWorkflow, /continue-on-error: true/);
  assert.match(socketWorkflow, /if: always\(\)/);
  assert.match(socketWorkflow, /Stage: release-binding/);
  assert.match(socketWorkflow, /Stage: dependency-inventory/);
  assert.match(socketWorkflow, /Stage: socket-audit/);
  assert.match(socketWorkflow, /path: \$\{\{ runner\.temp \}\}\/socket-post-publish\//);
  assert.match(
    socketWorkflow,
    /if \[ "\$AUDIT_OUTCOME" != "success" \]; then[\s\S]*?exit 1/,
  );
});

test('Socket recovery supplies the immutable tag and peeled commit', () => {
  assert.match(socketRunbook, /--ref main/);
  assert.match(socketRunbook, /-f version="\$VERSION"/);
  assert.match(socketRunbook, /-f tag="\$TAG"/);
  assert.match(socketRunbook, /-f commit="\$COMMIT"/);
  assert.match(socketRunbook, /COMMIT="\$\(git rev-parse "\$\{TAG\}\^\{commit\}"\)"/);
});

test('Socket audit paces across quota windows with a job timeout that covers the wait', () => {
  assert.match(
    socketWorkflow,
    /SOCKET_PACE_QUOTA_MINUTES: \$\{\{ vars\.SOCKET_PACE_QUOTA_MINUTES \|\| '120' \}\}/,
  );
  const timeout = Number(socketWorkflow.match(/^\s*timeout-minutes: (\d+)$/m)?.[1]);
  assert.equal(timeout, 90 + 120 + 30, 'job timeout must cover maximum npm wait, Socket pacing, and scan overhead');
  assert.match(socketRunbook, /SOCKET_PACE_QUOTA_MINUTES/);
  assert.match(socketRunbook, /240 minutes/);
});

test('npm visibility wait is bounded, configurable, and precedes inventory installation', () => {
  assert.match(visibilityStep, /id: npm_visibility/);
  assert.match(visibilityStep, /shell: sh/);
  assert.match(visibilityStep, /NPM_VISIBILITY_WAIT_MINUTES: \$\{\{ vars\.SOCKET_NPM_VISIBILITY_WAIT_MINUTES \|\| '45' \}\}/);
  assert.match(visibilityScript, /\[1-9\]\|\[1-8\]\[0-9\]\|90/);
  assert.match(visibilityScript, /DEADLINE=\$\(\( \$\(date \+%s\) \+ NPM_VISIBILITY_WAIT_MINUTES \* 60 \)\)/);
  assert.match(visibilityScript, /for PACKAGE in aiwg @aiwg\/cli @aiwg\/cockpit/);
  assert.match(visibilityScript, /timeout "\$REMAINING" npm view "\$PACKAGE@\$VERSION" version/);
  assert.match(visibilityScript, /--fetch-retries=0 --fetch-timeout=30000/);
  assert.ok(socketWorkflow.indexOf('name: Wait for published npm versions') < socketWorkflow.indexOf('name: Build published dependency inventory'));
  for (const name of ['Build published dependency inventory', 'Query Socket and evaluate baseline']) {
    const step = socketWorkflow.split(`      - name: ${name}\n`)[1]?.split('\n      - name:')[0] ?? '';
    assert.match(step, /if: steps\.npm_visibility\.outputs\.available == 'true'/);
  }
  for (const [, script] of socketWorkflow.matchAll(/^        run: \|\n((?:^ {10}.*\n|^\n)*)/gm)) {
    assert.doesNotMatch(script, /\$\{\{/);
  }
  assert.match(socketRunbook, /SOCKET_NPM_VISIBILITY_WAIT_MINUTES/);
  assert.match(socketRunbook, /default `45`/);
  assert.match(socketRunbook, /`1` to `90`/);
});

test('npm visibility accepts all four exact versions immediately or after a retry', () => {
  for (const scenario of ['ready', 'delayed']) {
    const result = runVisibility(scenario);
    assert.equal(result.read('output'), 'available=true\n');
    assert.equal(result.read('summary'), '');
    assert.equal(Number(result.read('clock')), scenario === 'ready' ? 0 : 30);
    for (const pkg of ['aiwg', '@aiwg/cli', '@aiwg/cockpit', '@aiwg/flue']) {
      assert.ok(result.read('calls').includes(`view ${pkg}@2026.10.6 version`));
    }
  }
  for (const minutes of ['45', '90']) {
    assert.equal(runVisibility('ready', minutes).read('output'), 'available=true\n');
  }
});

test('npm visibility timeout records unavailable evidence and exact recovery command', () => {
  for (const scenario of ['missing', 'wrong-version', 'stalled', 'slow-missing']) {
    const result = runVisibility(scenario);
    assert.equal(result.read('output'), 'available=false\n');
    assert.equal(Number(result.read('clock')), 60, 'requests and sleeps must stay within the deadline');
    const summary = result.read('summary');
    assert.match(summary, /Status: unavailable: npm-review-pending/);
    assert.match(summary, /Stage: npm-visibility/);
    assert.ok(summary.includes(result.command));
    assert.equal(result.read('workflow-status.md'), summary);
    assert.ok(result.read('request-bounds').trim().split('\n').every((bound) => Number(bound) > 0 && Number(bound) <= 60));
  }
  assert.match(socketRunbook, /unavailable: npm-review-pending/);
});

test('npm visibility rejects invalid or excessive wait configuration', () => {
  for (const minutes of ['0', '91', '-1', '1.5', 'abc', '01']) {
    assert.throws(() => runVisibility('ready', minutes), (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stderr.toString(), /must be an integer from 1 to 90/);
      return true;
    });
  }
});

test('Socket audit installs the release source runtime dependencies before running the audit script', () => {
  const install = socketWorkflow.indexOf('name: Install audit script runtime dependencies');
  const query = socketWorkflow.indexOf('name: Query Socket and evaluate baseline');
  assert.ok(install > 0 && install < query, 'dependency install must precede the Socket query step');
  assert.match(socketWorkflow, /run: npm ci --omit=dev --ignore-scripts --no-audit --no-fund/);
  // Every bare package the audit script imports must be a production dependency.
  const script = readFileSync(path.join(ROOT, 'tools/release/socket-post-publish-audit.mjs'), 'utf8');
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const bare = [...script.matchAll(/^import .* from '([^'.][^']*)'/gm)].map(m => m[1]).filter(name => !name.startsWith('node:'));
  for (const name of bare) assert.ok(pkg.dependencies?.[name.split('/')[0]], `${name} must be a production dependency`);
});
