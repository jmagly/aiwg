/**
 * Basic tests for MultiLoopGiteaReporter
 *
 * Run with: node tools/ralph-external/multi-loop-gitea-reporter.test.mjs
 */

import { MultiLoopGiteaReporter } from './multi-loop-gitea-reporter.mjs';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

let TEST_DIR;

function cleanup() {
  if (TEST_DIR && existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

function setup() {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'aiwg-reporter-owner-'));
}

afterEach(() => { cleanup(); TEST_DIR = undefined; });

// Test: Initialization
test('MultiLoopGiteaReporter initializes correctly', () => {
  setup();
  const reporter = new MultiLoopGiteaReporter({
    projectRoot: TEST_DIR,
    owner: 'test-owner',
    repo: 'test-repo',
  });

  assert.strictEqual(reporter.projectRoot, TEST_DIR);
  assert.strictEqual(reporter.tracker.owner, 'test-owner');
  assert.strictEqual(reporter.tracker.repo, 'test-repo');
  assert.strictEqual(reporter.issueNumbers.size, 0);
});

// Test: formatLoopComment - progress
test('formatLoopComment() formats progress comment', () => {
  setup();
  const reporter = new MultiLoopGiteaReporter({
    projectRoot: TEST_DIR,
    owner: 'test-owner',
    repo: 'test-repo',
  });

  const comment = reporter.formatLoopComment('test-loop-001', {
    type: 'progress',
    iteration: 3,
    maxIterations: 10,
    status: 'running',
    analysis: {
      learnings: 'Fixed bugs in auth module',
      artifactsModified: ['src/auth.ts', 'test/auth.test.ts'],
      nextApproach: 'Add integration tests',
    },
  });

  assert.ok(comment.includes('test-loop-001'));
  assert.ok(comment.includes('Iteration 3/10'));
  assert.ok(comment.includes('running'));
  assert.ok(comment.includes('Fixed bugs in auth module'));
  assert.ok(comment.includes('src/auth.ts'));
  assert.ok(comment.includes('Add integration tests'));
});

// Test: formatLoopComment - completion
test('formatLoopComment() formats completion comment', () => {
  setup();
  const reporter = new MultiLoopGiteaReporter({
    projectRoot: TEST_DIR,
    owner: 'test-owner',
    repo: 'test-repo',
  });

  const comment = reporter.formatLoopComment('test-loop-002', {
    type: 'completion',
    success: true,
    iterations: 5,
    reason: 'All tests passing',
  });

  assert.ok(comment.includes('test-loop-002'));
  assert.ok(comment.includes('Loop Completed'));
  assert.ok(comment.includes('SUCCESS'));
  assert.ok(comment.includes('All tests passing'));
});

// Test: formatLoopComment - crash
test('formatLoopComment() formats crash comment', () => {
  setup();
  const reporter = new MultiLoopGiteaReporter({
    projectRoot: TEST_DIR,
    owner: 'test-owner',
    repo: 'test-repo',
  });

  const comment = reporter.formatLoopComment('test-loop-003', {
    type: 'crash',
    error: 'Timeout exceeded',
    stack: 'Error: Timeout\n  at process...',
  });

  assert.ok(comment.includes('test-loop-003'));
  assert.ok(comment.includes('Loop Crashed'));
  assert.ok(comment.includes('Timeout exceeded'));
  assert.ok(comment.includes('Stack Trace'));
});

// Test: getAllLoopsStatus
test('getAllLoopsStatus() reads loop states', () => {
  setup();
  const reporter = new MultiLoopGiteaReporter({
    projectRoot: TEST_DIR,
    owner: 'test-owner',
    repo: 'test-repo',
  });

  // Create mock loop states
  const loopIds = ['test-loop-004', 'test-loop-005'];
  for (const [i, loopId] of loopIds.entries()) {
    const loopDir = join(TEST_DIR, '.aiwg', 'ralph', 'loops', loopId);
    mkdirSync(loopDir, { recursive: true });
    writeFileSync(
      join(loopDir, 'state.json'),
      JSON.stringify({
        loopId,
        status: 'running',
        currentIteration: i + 1,
        maxIterations: 10,
        objective: `Test objective ${i + 1}`,
        startTime: new Date().toISOString(),
        iterations: [],
      })
    );
  }

  const loops = reporter.getAllLoopsStatus();

  assert.strictEqual(loops.length, 2);
  assert.strictEqual(loops[0].loopId, 'test-loop-004');
  assert.strictEqual(loops[0].iteration, 1);
  assert.strictEqual(loops[1].loopId, 'test-loop-005');
  assert.strictEqual(loops[1].iteration, 2);
});

// Test: generateAllLoopsSummary
test('generateAllLoopsSummary() generates summary', () => {
  setup();
  const reporter = new MultiLoopGiteaReporter({
    projectRoot: TEST_DIR,
    owner: 'test-owner',
    repo: 'test-repo',
  });

  // Create mock loop states
  const loopIds = ['test-loop-006', 'test-loop-007'];
  for (const [i, loopId] of loopIds.entries()) {
    const loopDir = join(TEST_DIR, '.aiwg', 'ralph', 'loops', loopId);
    mkdirSync(loopDir, { recursive: true });
    writeFileSync(
      join(loopDir, 'state.json'),
      JSON.stringify({
        loopId,
        status: i === 0 ? 'running' : 'paused',
        currentIteration: i + 2,
        maxIterations: 10,
        objective: `Test objective ${i + 1}`,
        startTime: new Date().toISOString(),
        iterations: [],
      })
    );
  }

  const summary = reporter.generateAllLoopsSummary();

  assert.ok(summary.markdown);
  assert.ok(summary.markdown.includes('Multi-Loop Summary'));
  assert.ok(summary.markdown.includes('test-loop-006'));
  assert.ok(summary.markdown.includes('test-loop-007'));
  assert.strictEqual(summary.totalActive, 1);
  assert.strictEqual(summary.totalPaused, 1);
  assert.strictEqual(summary.loops.length, 2);
});

// Test: formatRecentActivity
test('formatRecentActivity() formats activity log', () => {
  setup();
  const reporter = new MultiLoopGiteaReporter({
    projectRoot: TEST_DIR,
    owner: 'test-owner',
    repo: 'test-repo',
  });

  const loops = [
    {
      loopId: 'test-loop-008',
      iterations: [
        {
          number: 1,
          status: 'completed',
          timestamp: new Date().toISOString(),
        },
      ],
    },
    {
      loopId: 'test-loop-009',
      iterations: [],
    },
  ];

  const activity = reporter.formatRecentActivity(loops);

  assert.ok(activity.includes('test-loop-008'));
  assert.ok(activity.includes('Iteration 1'));
  assert.ok(activity.includes('completed'));
});

// Test: setIssueNumber and getIssueNumber
test('setIssueNumber() and getIssueNumber() manage issue mapping', () => {
  setup();
  const reporter = new MultiLoopGiteaReporter({
    projectRoot: TEST_DIR,
    owner: 'test-owner',
    repo: 'test-repo',
  });

  const loopId = 'test-loop-010';
  const issueNumber = 42;

  // Get before set
  assert.strictEqual(reporter.getIssueNumber(loopId), null);

  // Set
  reporter.setIssueNumber(loopId, issueNumber);

  // Get after set
  assert.strictEqual(reporter.getIssueNumber(loopId), issueNumber);
});

for (const [status, explicitIssue, expectedIssue] of [['paused', undefined, 42], ['running', 99, 99]]) {
  test(`postLoopProgress sends the loop-specific payload for ${status}`, t => {
    setup();
    const reporter = new MultiLoopGiteaReporter({ projectRoot: TEST_DIR, owner: 'test-owner', repo: 'test-repo' });
    reporter.setIssueNumber('loop-alpha', 42);
    const calls = [];
    t.mock.method(reporter.tracker, 'apiCall', (method, endpoint, data) => {
      calls.push({ method, endpoint, data });
      return { id: 123 };
    });
    const progress = { iteration: 2, maxIterations: 10, status,
      analysis: { learnings: 'Fixed parser', artifactsModified: ['src/parser.mjs'], nextApproach: 'Verify edges' } };
    assert.equal(reporter.postLoopProgress('loop-alpha', progress, explicitIssue), expectedIssue);
    const expectedBody = `### Loop: \`loop-alpha\`

**Iteration 2/10**

**Status**: ${status}

**Learnings**:
Fixed parser


**Modified Files**:
- \`src/parser.mjs\`


**Next Approach**:
Verify edges

`;
    assert.deepEqual(calls, [{ method: 'POST', endpoint: `/repos/test-owner/test-repo/issues/${expectedIssue}/comments`, data: { body: expectedBody } }]);
    assert.equal(reporter.getIssueNumber('loop-alpha'), 42);
  });
}

test('postLoopProgress rejects a missing issue mapping before a request', t => {
  setup();
  const reporter = new MultiLoopGiteaReporter({ projectRoot: TEST_DIR, owner: 'test-owner', repo: 'test-repo' });
  const api = t.mock.method(reporter.tracker, 'apiCall', () => { throw new Error('unexpected request'); });
  assert.throws(() => reporter.postLoopProgress('unmapped', { iteration: 1, maxIterations: 10, status: 'running' }),
    { message: 'No issue number for loop unmapped. Call createLoopIssue first.' });
  assert.equal(api.mock.callCount(), 0);
});

test('availability delegates without performing a tracker request', t => {
  setup();
  const reporter = new MultiLoopGiteaReporter({ projectRoot: TEST_DIR, owner: 'test-owner', repo: 'test-repo' });
  let available = false;
  const check = t.mock.method(reporter.tracker, 'isAvailable', () => available);
  assert.equal(reporter.isAvailable(), false);
  available = true;
  assert.equal(reporter.isAvailable(), true);
  assert.equal(check.mock.callCount(), 2);
});

test('issue creation records the returned issue and preserves objective fields', t => {
  setup();
  const reporter = new MultiLoopGiteaReporter({ projectRoot: TEST_DIR, owner: 'test-owner', repo: 'test-repo' });
  const calls = [];
  t.mock.method(reporter.tracker, 'apiCall', (...args) => { calls.push(args); return { number: 42 }; });
  assert.equal(reporter.createLoopIssue('loop-alpha', {
    loopId: 'loop-alpha', objective: 'Repair parser', completionCriteria: 'All checks pass', maxIterations: 10,
  }), 42);
  assert.equal(reporter.getIssueNumber('loop-alpha'), 42);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['POST', '/repos/test-owner/test-repo/issues']);
  assert.equal(calls[0][2].title, '[Ralph] Repair parser...');
  assert.match(calls[0][2].body, /\*\*Loop ID\*\*: `loop-alpha`/);
  assert.match(calls[0][2].body, /### Completion Criteria\nAll checks pass/);
});

for (const success of [true, false]) {
  test(`completion posts and closes the mapped issue: success=${success}`, t => {
    setup();
    const reporter = new MultiLoopGiteaReporter({ projectRoot: TEST_DIR, owner: 'test-owner', repo: 'test-repo' });
    reporter.setIssueNumber('loop-alpha', 42);
    const calls = [];
    t.mock.method(reporter.tracker, 'apiCall', (...args) => { calls.push(args); return {}; });
    reporter.postLoopCompletion('loop-alpha', { success, iterations: 3, reason: 'Finished check' });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].slice(0, 2), ['POST', '/repos/test-owner/test-repo/issues/42/comments']);
    assert.match(calls[0][2].body, /### Loop: `loop-alpha`/);
    assert.ok(calls[0][2].body.includes(`**Final Status**: ${success ? 'SUCCESS' : 'FAILED'}`));
    assert.match(calls[0][2].body, /\*\*Iterations\*\*: 3\n\*\*Reason\*\*: Finished check/);
    assert.deepEqual(calls[1], ['PATCH', '/repos/test-owner/test-repo/issues/42', { state: 'closed' }]);
    assert.equal(reporter.getIssueNumber('loop-alpha'), null);
  });
}

test('completion failure retains the issue mapping', t => {
  setup();
  const reporter = new MultiLoopGiteaReporter({ projectRoot: TEST_DIR, owner: 'test-owner', repo: 'test-repo' });
  reporter.setIssueNumber('loop-alpha', 42);
  const api = t.mock.method(reporter.tracker, 'apiCall', () => { throw new Error('synthetic failure'); });
  assert.throws(() => reporter.postLoopCompletion('loop-alpha', { success: false, iterations: 1, reason: 'Stopped' }), { message: 'synthetic failure' });
  assert.equal(api.mock.callCount(), 1);
  assert.equal(reporter.getIssueNumber('loop-alpha'), 42);
});

test('unmapped completion and crash do not issue requests', t => {
  setup();
  const reporter = new MultiLoopGiteaReporter({ projectRoot: TEST_DIR, owner: 'test-owner', repo: 'test-repo' });
  const api = t.mock.method(reporter.tracker, 'apiCall', () => { throw new Error('unexpected request'); });
  reporter.postLoopCompletion('unmapped', { success: true });
  reporter.postLoopCrash('unmapped', new Error('Synthetic crash'));
  assert.equal(api.mock.callCount(), 0);
});

test('crash notification uses an explicit issue override without closing it', t => {
  setup();
  const reporter = new MultiLoopGiteaReporter({ projectRoot: TEST_DIR, owner: 'test-owner', repo: 'test-repo' });
  reporter.setIssueNumber('loop-alpha', 42);
  const calls = [];
  t.mock.method(reporter.tracker, 'apiCall', (...args) => { calls.push(args); return {}; });
  const error = new Error('Synthetic crash');
  error.stack = 'synthetic stack';
  reporter.postLoopCrash('loop-alpha', error, 99);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['POST', '/repos/test-owner/test-repo/issues/99/comments']);
  assert.match(calls[0][2].body, /### Loop: `loop-alpha`/);
  assert.match(calls[0][2].body, /\*\*Error\*\*: Synthetic crash/);
  assert.match(calls[0][2].body, /```\nsynthetic stack\n```/);
  assert.equal(reporter.getIssueNumber('loop-alpha'), 42);
});

for (const issueNumber of [undefined, 42]) {
  test(`empty summary ${issueNumber ? 'comments on existing issue' : 'creates an issue'}`, t => {
    setup();
    const reporter = new MultiLoopGiteaReporter({ projectRoot: TEST_DIR, owner: 'test-owner', repo: 'test-repo' });
    const calls = [];
    t.mock.method(reporter.tracker, 'apiCall', (...args) => { calls.push(args); return { number: 99 }; });
    const result = reporter.postAllLoopsSummary(issueNumber);
    assert.equal(result.issueNumber, issueNumber ?? 99);
    assert.deepEqual(result.summary.loops, []);
    assert.equal(result.summary.totalIterations, 0);
    assert.equal(result.summary.avgProgress, 0);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].slice(0, 2), ['POST', `/repos/test-owner/test-repo/issues${issueNumber ? '/42/comments' : ''}`]);
    assert.match(calls[0][2].body, /\*No active loops\*/);
    assert.match(calls[0][2].body, /\*No recent activity\*/);
    if (!issueNumber) assert.match(calls[0][2].title, /^\[Ralph Multi-Loop\] Summary - \d{4}-\d{2}-\d{2}$/);
  });
}
