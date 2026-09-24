import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

// Drives the packaged dispatcher end to end (#2639). It imports the compiled
// runtime, so the suite needs `npm run build:cli`; CI builds before tests.
const root = path.resolve(import.meta.dirname, '../..');
const script = path.join(root, 'agentic/code/addons/decision-engine/skills/decision-evaluate/scripts/decision-evaluate.mjs');
const runtime = path.join(root, 'dist/src/decision/index.js');
const built = existsSync(runtime);
const KEY_HEX = 'a1'.repeat(16) + 'b2'.repeat(16);
const KEY_BASE64 = Buffer.from(KEY_HEX, 'hex').toString('base64');
const directories: string[] = [];

interface Run { code: number; stdout: string; stderr: string }

function dispatch(requestPath: string, env: Record<string, string> = {}): Promise<Run> {
  return new Promise(resolve => {
    execFile(process.execPath, [script, '--request', requestPath], {
      cwd: path.dirname(requestPath), timeout: 60_000,
      env: { PATH: process.env.PATH ?? '', AIWG_DECISION_ENABLED: '1', ...env },
    }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }));
  });
}

async function workspace(overrides: Record<string, unknown>): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aiwg-decision-receipts-'));
  directories.push(directory);
  const local = path.join(directory, 'request');
  await cp(path.join(root, 'examples/decision'), local, { recursive: true });
  // Outside the package tree the bare `aiwg/decision` specifier cannot resolve,
  // so point the fixture adapter at the compiled runtime directly.
  const adapter = path.join(local, 'fixture-llm-adapter.mjs');
  await writeFile(adapter, (await readFile(adapter, 'utf8'))
    .replace("from 'aiwg/decision'", `from '${pathToFileURL(runtime).href}'`));
  const request = JSON.parse(await readFile(path.join(local, 'dispatcher-request-llm.json'), 'utf8'));
  const next = { ...request, receiptDirectory: path.join(directory, 'receipts'), ...overrides };
  for (const [key, value] of Object.entries(next)) if (value === undefined) delete next[key];
  await writeFile(path.join(local, 'request.json'), JSON.stringify(next));
  return path.join(local, 'request.json');
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe.skipIf(!built)('decision-evaluate receiptDirectory (#2639)', () => {
  const keyed = { receiptIntegrityKeyRef: 'receipt-key', credentials: { 'receipt-key': 'TEST_DECISION_RECEIPT_KEY' } };

  it('writes an HMAC-integrity receipt and rejects a mismatched replay', async () => {
    const requestPath = await workspace(keyed);
    const first = await dispatch(requestPath, { TEST_DECISION_RECEIPT_KEY: KEY_HEX });
    expect(first.code, first.stderr).toBe(0);
    expect(JSON.parse(first.stdout).spec.status).toBe('completed');

    const request = JSON.parse(await readFile(requestPath, 'utf8'));
    const receipts = (await readdir(request.receiptDirectory)).filter(name => name.endsWith('.json'));
    expect(receipts.length).toBeGreaterThan(0);
    const documents = await Promise.all(receipts.map(name => readFile(path.join(request.receiptDirectory, name), 'utf8')));
    const last = documents.map(text => JSON.parse(text)).sort((a, b) => b.receipt.revision - a.receipt.revision)[0];
    expect(last.receipt).toMatchObject({ schema: 'decision-receipt/v2', invocationId: request.invocationId, state: 'completed' });
    expect(last.mac).toMatch(/^[a-f0-9]{64}$/);

    // Same invocation identity, different request content.
    await writeFile(path.join(path.dirname(requestPath), 'input.json'), JSON.stringify({ message: 'A different case entirely.' }));
    const replay = await dispatch(requestPath, { TEST_DECISION_RECEIPT_KEY: KEY_HEX });
    expect(replay.code).toBe(1);
    expect(JSON.parse(replay.stdout).spec).toMatchObject({ status: 'error', reason: 'replay-mismatch' });

    for (const text of [first.stdout, first.stderr, replay.stdout, replay.stderr, ...documents]) {
      expect(text).not.toContain(KEY_HEX);
      expect(text).not.toContain(KEY_BASE64);
    }
  }, 60_000);

  it('accepts a base64 key when the encoding is declared', async () => {
    const requestPath = await workspace({ ...keyed, receiptIntegrityKeyEncoding: 'base64' });
    const run = await dispatch(requestPath, { TEST_DECISION_RECEIPT_KEY: KEY_BASE64 });
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).not.toContain(KEY_BASE64);
  }, 60_000);

  it.each([
    ['no key reference', {}, {}, 'receipt-integrity-key-missing'],
    ['an unmapped reference', { receiptIntegrityKeyRef: 'receipt-key' }, {}, 'receipt-integrity-key-missing'],
    ['an unset variable', keyed, {}, 'receipt-integrity-key-missing'],
    ['a short key', keyed, { TEST_DECISION_RECEIPT_KEY: 'ab'.repeat(31) }, 'receipt-integrity-key-invalid'],
    ['a malformed hex key', keyed, { TEST_DECISION_RECEIPT_KEY: 'zz'.repeat(32) }, 'receipt-integrity-key-invalid'],
    ['an unknown encoding', { ...keyed, receiptIntegrityKeyEncoding: 'utf8' }, { TEST_DECISION_RECEIPT_KEY: KEY_HEX }, 'receipt-integrity-key-invalid'],
  ])('fails closed before evaluation with %s', async (_label, overrides, env, category) => {
    const requestPath = await workspace(overrides);
    const run = await dispatch(requestPath, env as Record<string, string>);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(JSON.parse(run.stderr.trim())).toMatchObject({ error: category });
    const secret = (env as Record<string, string>).TEST_DECISION_RECEIPT_KEY;
    if (secret) expect(run.stderr).not.toContain(secret);
    const request = JSON.parse(await readFile(requestPath, 'utf8'));
    expect(existsSync(request.receiptDirectory)).toBe(false);
  }, 60_000);
});
