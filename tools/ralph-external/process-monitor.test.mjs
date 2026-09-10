/**
 * Basic tests for ProcessMonitor
 *
 * Run with: node tools/ralph-external/process-monitor.test.mjs
 */

import { ProcessMonitor } from './process-monitor.mjs';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import assert from 'node:assert/strict';
import { test, beforeEach, afterEach, mock } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

let TEST_DIR;

function cleanup() {
  if (TEST_DIR && existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

function setup() {
  TEST_DIR = mkdtempSync(join(tmpdir(), 'aiwg-process-monitor-'));
}

beforeEach(() => {
  mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1700000000000 });
});
afterEach(() => {
  mock.timers.reset();
  cleanup();
  TEST_DIR = undefined;
});

function mockProcessStats(t, implementation) {
  const stub = t.mock.method(childProcess, 'execFileSync', implementation);
  syncBuiltinESMExports();
  t.after(() => {
    stub.mock.restore();
    syncBuiltinESMExports();
  });
  return stub;
}

// Test: Initialization
test('ProcessMonitor initializes correctly', () => {
  setup();
  const monitor = new ProcessMonitor({
    projectRoot: TEST_DIR,
    heartbeatIntervalMs: 1000,
    staleThresholdMs: 2000,
  });

  assert.strictEqual(monitor.projectRoot, TEST_DIR);
  assert.strictEqual(monitor.heartbeatIntervalMs, 1000);
  assert.strictEqual(monitor.staleThresholdMs, 2000);
  assert.strictEqual(monitor.monitoredLoops.size, 0);
});

// Test: isProcessAlive
test('isProcessAlive() detects running process', t => {
  setup();
  const monitor = new ProcessMonitor({ projectRoot: TEST_DIR });

  // Current process should be alive
  assert.strictEqual(monitor.isProcessAlive(process.pid), true);

  // Invalid PIDs
  assert.strictEqual(monitor.isProcessAlive(0), false);
  assert.strictEqual(monitor.isProcessAlive(-1), false);
  assert.strictEqual(monitor.isProcessAlive(null), false);

  // Exercise OS outcomes without assuming any numeric PID is unused.
  const calls = [];
  let code = 'ESRCH';
  t.mock.method(process, 'kill', (pid, signal) => {
    calls.push([pid, signal]);
    throw Object.assign(new Error('controlled process result'), { code });
  });
  assert.strictEqual(monitor.isProcessAlive(123), false);
  code = 'EPERM';
  assert.strictEqual(monitor.isProcessAlive(123), true);
  code = 'EINVAL';
  assert.strictEqual(monitor.isProcessAlive(123), false);
  assert.deepEqual(calls, [[123, 0], [123, 0], [123, 0]]);
});

// Test: parseUptime
test('parseUptime() parses elapsed time correctly', () => {
  setup();
  const monitor = new ProcessMonitor({ projectRoot: TEST_DIR });

  // Seconds only
  assert.strictEqual(monitor.parseUptime('5'), 5);

  // mm:ss
  assert.strictEqual(monitor.parseUptime('1:30'), 90);
  assert.strictEqual(monitor.parseUptime('5:00'), 300);

  // hh:mm:ss
  assert.strictEqual(monitor.parseUptime('1:00:00'), 3600);
  assert.strictEqual(monitor.parseUptime('2:30:45'), 9045);

  // dd-hh:mm:ss
  assert.strictEqual(monitor.parseUptime('1-00:00:00'), 86400);
  assert.strictEqual(monitor.parseUptime('2-12:30:45'), 217845);
});

// Test: parseStatus
test('parseStatus() parses process status correctly', () => {
  setup();
  const monitor = new ProcessMonitor({ projectRoot: TEST_DIR });

  assert.strictEqual(monitor.parseStatus('R'), 'running');
  assert.strictEqual(monitor.parseStatus('S'), 'sleeping');
  assert.strictEqual(monitor.parseStatus('Z'), 'zombie');
  assert.strictEqual(monitor.parseStatus('T'), 'stopped');
  assert.strictEqual(monitor.parseStatus('X'), 'dead');
  assert.strictEqual(monitor.parseStatus('?'), 'unknown');
});

// Test: recordHeartbeat
test('recordHeartbeat() creates heartbeat file', () => {
  setup();
  const monitor = new ProcessMonitor({ projectRoot: TEST_DIR });

  const loopId = 'test-loop-001';
  monitor.recordHeartbeat(loopId, {
    iteration: 5,
    status: 'running',
  });

  const heartbeatFile = join(TEST_DIR, '.aiwg', 'ralph', 'heartbeats', `${loopId}.json`);
  assert.ok(existsSync(heartbeatFile));

  const heartbeat = monitor.getLastHeartbeat(loopId);
  assert.strictEqual(heartbeat.loopId, loopId);
  assert.strictEqual(heartbeat.iteration, 5);
  assert.strictEqual(heartbeat.status, 'running');
  assert.ok(heartbeat.timestamp > 0);
});

// Test: getLastHeartbeat
test('getLastHeartbeat() retrieves heartbeat', () => {
  setup();
  const monitor = new ProcessMonitor({ projectRoot: TEST_DIR });

  const loopId = 'test-loop-002';

  // No heartbeat yet
  assert.strictEqual(monitor.getLastHeartbeat(loopId), null);

  // Record heartbeat
  monitor.recordHeartbeat(loopId, { iteration: 3 });

  // Retrieve heartbeat
  const heartbeat = monitor.getLastHeartbeat(loopId);
  assert.ok(heartbeat);
  assert.strictEqual(heartbeat.loopId, loopId);
  assert.strictEqual(heartbeat.iteration, 3);
});

// Test: isStale
test('isStale() detects stale heartbeats', () => {
  setup();
  const monitor = new ProcessMonitor({
    projectRoot: TEST_DIR,
    staleThresholdMs: 100, // 100ms threshold
  });

  const loopId = 'test-loop-003';

  // No heartbeat = stale
  assert.strictEqual(monitor.isStale(loopId), true);

  // Fresh heartbeat
  monitor.recordHeartbeat(loopId);
  assert.strictEqual(monitor.isStale(loopId), false);

  // Test with custom threshold overrides
  assert.strictEqual(monitor.isStale(loopId, -1), true); // negative threshold = always stale
  assert.strictEqual(monitor.isStale(loopId, 10000), false); // 10s threshold = not stale
});

// Test: startMonitoring
test('startMonitoring() initializes monitoring', () => {
  setup();
  const monitor = new ProcessMonitor({ projectRoot: TEST_DIR });

  // Create mock loop state
  const loopId = 'test-loop-004';
  const loopStateDir = join(TEST_DIR, '.aiwg', 'ralph', 'loops', loopId);
  mkdirSync(loopStateDir, { recursive: true });
  writeFileSync(
    join(loopStateDir, 'state.json'),
    JSON.stringify({ currentPid: process.pid, status: 'running' })
  );

  monitor.startMonitoring([loopId]);

  assert.strictEqual(monitor.monitoredLoops.size, 1);
  assert.ok(monitor.monitoredLoops.has(loopId));

  const monitored = monitor.monitoredLoops.get(loopId);
  assert.strictEqual(monitored.pid, process.pid);

  monitor.stopAll();
});

// Test: stopMonitoring
test('stopMonitoring() removes loop from monitoring', () => {
  setup();
  const monitor = new ProcessMonitor({ projectRoot: TEST_DIR });

  const loopId = 'test-loop-005';
  const loopStateDir = join(TEST_DIR, '.aiwg', 'ralph', 'loops', loopId);
  mkdirSync(loopStateDir, { recursive: true });
  writeFileSync(
    join(loopStateDir, 'state.json'),
    JSON.stringify({ currentPid: process.pid, status: 'running' })
  );

  monitor.startMonitoring([loopId]);
  assert.strictEqual(monitor.monitoredLoops.size, 1);

  monitor.stopMonitoring(loopId);
  assert.strictEqual(monitor.monitoredLoops.size, 0);
});

// Test: getMonitoredLoops
test('getMonitoredLoops() returns monitored loop IDs', () => {
  setup();
  const monitor = new ProcessMonitor({ projectRoot: TEST_DIR });

  const loopIds = ['test-loop-006', 'test-loop-007'];

  for (const loopId of loopIds) {
    const loopStateDir = join(TEST_DIR, '.aiwg', 'ralph', 'loops', loopId);
    mkdirSync(loopStateDir, { recursive: true });
    writeFileSync(
      join(loopStateDir, 'state.json'),
      JSON.stringify({ currentPid: process.pid, status: 'running' })
    );
  }

  monitor.startMonitoring(loopIds);

  const monitored = monitor.getMonitoredLoops();
  assert.strictEqual(monitored.length, 2);
  assert.ok(monitored.includes('test-loop-006'));
  assert.ok(monitored.includes('test-loop-007'));

  monitor.stopAll();
});

// Test: getProcessHealth for current process
test('getProcessHealth() returns metrics for current process', () => {
  setup();
  const monitor = new ProcessMonitor({ projectRoot: TEST_DIR });

  const loopId = 'test-loop-008';
  monitor.monitoredLoops.set(loopId, { pid: process.pid });

  const health = monitor.getProcessHealth(loopId);

  assert.ok(health);
  assert.strictEqual(health.pid, process.pid);
  assert.ok(health.cpu >= 0);
  assert.ok(health.memory >= 0);
  assert.ok(health.uptime >= 0);
  assert.ok(['running', 'sleeping', 'unknown'].includes(health.status));
});

// Test: getProcessHealth for non-existent process
test('getProcessHealth() returns dead status for non-existent process', t => {
  setup();
  const monitor = new ProcessMonitor({ projectRoot: TEST_DIR });

  const loopId = 'test-loop-009';
  monitor.monitoredLoops.set(loopId, { pid: 123 });
  t.mock.method(monitor, 'isProcessAlive', pid => {
    assert.equal(pid, 123);
    return false;
  });

  const health = monitor.getProcessHealth(loopId);

  assert.ok(health);
  assert.strictEqual(health.pid, 123);
  assert.strictEqual(health.status, 'dead');
  assert.strictEqual(health.cpu, 0);
  assert.strictEqual(health.memory, 0);
  assert.strictEqual(health.uptime, 0);
});

// Test: stopAll
test('stopAll() stops all monitoring', () => {
  setup();
  const monitor = new ProcessMonitor({ projectRoot: TEST_DIR });

  const loopIds = ['test-loop-010', 'test-loop-011'];

  for (const loopId of loopIds) {
    const loopStateDir = join(TEST_DIR, '.aiwg', 'ralph', 'loops', loopId);
    mkdirSync(loopStateDir, { recursive: true });
    writeFileSync(
      join(loopStateDir, 'state.json'),
      JSON.stringify({ currentPid: process.pid, status: 'running' })
    );
  }

  monitor.startMonitoring(loopIds);
  assert.strictEqual(monitor.monitoredLoops.size, 2);

  monitor.stopAll();
  assert.strictEqual(monitor.monitoredLoops.size, 0);
  assert.strictEqual(monitor.heartbeatTimer, null);
});

for (const [name, record] of [
  ['missing timestamp', {}],
  ['nonnumeric timestamp', { timestamp: 'invalid' }],
  ['numeric string timestamp', { timestamp: '1700000000000' }],
  ['null timestamp', { timestamp: null }],
  ['array record', []],
  ['primitive record', 1700000000000],
]) {
  test(`malformed heartbeat is stale and emits its original data: ${name}`, () => {
    setup();
    const monitor = new ProcessMonitor({ projectRoot: TEST_DIR });
    const loopId = 'test-loop-malformed';
    writeFileSync(join(monitor.heartbeatDir, `${loopId}.json`), JSON.stringify(record));
    monitor.monitoredLoops.set(loopId, { pid: 123 });
    monitor.isProcessAlive = () => true;
    const events = [];
    monitor.on('stale', event => events.push(event));
    assert.equal(monitor.isStale(loopId), true);
    monitor.checkAllHeartbeats();
    assert.deepEqual(events, [{ loopId, pid: 123, lastHeartbeat: record }]);
  });
}

test('nonfinite timestamps cannot establish freshness', () => {
  setup();
  const monitor = new ProcessMonitor({ projectRoot: TEST_DIR });
  for (const timestamp of [NaN, Infinity, -Infinity]) {
    // JSON cannot retain these numbers; exercise the parsed-record boundary.
    monitor.getLastHeartbeat = () => ({ timestamp });
    assert.equal(monitor.isStale('test-loop-nonfinite'), true);
  }
});

test('freshness uses a strict age boundary and preserves threshold overrides', () => {
  setup();
  const monitor = new ProcessMonitor({ projectRoot: TEST_DIR, staleThresholdMs: 100 });
  monitor.recordHeartbeat('test-loop-boundary');
  assert.equal(monitor.isStale('test-loop-boundary'), false);
  assert.equal(monitor.isStale('test-loop-boundary', -1), true);
  mock.timers.tick(100);
  assert.equal(monitor.isStale('test-loop-boundary'), false);
  mock.timers.tick(1);
  assert.equal(monitor.isStale('test-loop-boundary'), true);
  assert.equal(monitor.isStale('test-loop-boundary', 101), false);
});

test('heartbeat checks distinguish crashes, missing records and fresh live loops', t => {
  setup();
  const monitor = new ProcessMonitor({ projectRoot: TEST_DIR });
  monitor.monitoredLoops.set('crashed', { pid: 123 });
  monitor.monitoredLoops.set('missing', { pid: null });
  monitor.monitoredLoops.set('fresh', { pid: 456 });
  monitor.recordHeartbeat('fresh');
  t.mock.method(monitor, 'isProcessAlive', pid => pid === 456);
  const events = [];
  monitor.on('crash', event => events.push(['crash', event]));
  monitor.on('stale', event => events.push(['stale', event]));
  monitor.checkAllHeartbeats();
  assert.deepEqual(events, [
    ['crash', { loopId: 'crashed', pid: 123, reason: 'process_died' }],
    ['stale', { loopId: 'missing', pid: null, lastHeartbeat: null }],
  ]);
});

test('unreadable JSON heartbeat remains missing and stale', () => {
  setup();
  const monitor = new ProcessMonitor({ projectRoot: TEST_DIR });
  writeFileSync(join(monitor.heartbeatDir, 'broken.json'), '{broken');
  assert.equal(monitor.getLastHeartbeat('broken'), null);
  assert.equal(monitor.isStale('broken'), true);
});

test('monitoring schedules one timer and stopping removes its callbacks', t => {
  setup();
  const monitor = new ProcessMonitor({ projectRoot: TEST_DIR, heartbeatIntervalMs: 100 });
  const stateDir = join(TEST_DIR, '.aiwg', 'ralph', 'loops', 'timer-loop');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'state.json'), JSON.stringify({ currentPid: 123 }));
  const check = t.mock.method(monitor, 'checkAllHeartbeats', () => {});
  monitor.startMonitoring(['timer-loop']);
  const timer = monitor.heartbeatTimer;
  monitor.startMonitoring(['timer-loop']);
  assert.equal(monitor.heartbeatTimer, timer);
  mock.timers.tick(100);
  assert.equal(check.mock.callCount(), 1);
  monitor.stopMonitoring('timer-loop');
  assert.equal(monitor.heartbeatTimer, null);
  mock.timers.tick(100);
  assert.equal(check.mock.callCount(), 1);
});

test('process metrics use exact RSS units and an argument-vector command', t => {
  setup();
  const monitor = new ProcessMonitor({ projectRoot: TEST_DIR });
  monitor.monitoredLoops.set('metrics', { pid: process.pid });
  const calls = [];
  mockProcessStats(t, (...args) => {
    calls.push(args);
    return ' 12.5 65536 1:30 S+\n';
  });
  assert.deepEqual(monitor.getProcessHealth('metrics'), {
    pid: process.pid, cpu: 12.5, memory: 64, uptime: 90, status: 'sleeping',
  });
  assert.deepEqual(calls, [['ps', ['-p', String(process.pid), '-o', '%cpu,rss,etime,stat', '--no-headers'], { encoding: 'utf8' }]]);
});

for (const [name, row, expected] of [
  ['zero metrics', '0 0 00:00 R', { cpu: 0, memory: 0, uptime: 0, status: 'running' }],
  ['fractional MiB', '1.25 1536 2-12:30:45 Z', { cpu: 1.25, memory: 1.5, uptime: 217845, status: 'zombie' }],
  ['empty output', '', null],
  ['missing columns', '1 100', null],
  ['extra columns', '1 100 00:01 R extra', null],
  ['invalid CPU', 'junk 100 00:01 R', null],
  ['CPU suffix', '1junk 100 00:01 R', null],
  ['negative CPU', '-1 100 00:01 R', null],
  ['infinite CPU', 'Infinity 100 00:01 R', null],
  ['invalid RSS', '1 junk 00:01 R', null],
  ['negative RSS', '1 -100 00:01 R', null],
  ['infinite RSS', '1 Infinity 00:01 R', null],
]) {
  test(`process metric row handling: ${name}`, t => {
    setup();
    const monitor = new ProcessMonitor({ projectRoot: TEST_DIR });
    monitor.monitoredLoops.set('metrics', { pid: process.pid });
    const stub = mockProcessStats(t, () => row);
    const result = monitor.getProcessHealth('metrics');
    assert.equal(stub.mock.callCount(), 1);
    assert.deepEqual(result, expected && { pid: process.pid, ...expected });
  });
}

test('unavailable stats return null and unmonitored processes are not queried', t => {
  setup();
  const monitor = new ProcessMonitor({ projectRoot: TEST_DIR });
  const stub = mockProcessStats(t, () => { throw new Error('ps failed'); });
  assert.equal(monitor.getProcessHealth('missing'), null);
  monitor.monitoredLoops.set('no-pid', { pid: null });
  assert.equal(monitor.getProcessHealth('no-pid'), null);
  assert.equal(stub.mock.callCount(), 0);
  monitor.monitoredLoops.set('metrics', { pid: process.pid });
  assert.equal(monitor.getProcessHealth('metrics'), null);
  assert.equal(stub.mock.callCount(), 1);
});
