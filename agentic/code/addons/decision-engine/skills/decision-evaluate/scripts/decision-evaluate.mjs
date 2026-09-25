#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveDecisionRuntime } from './runtime-root.mjs';

const args = process.argv.slice(2);
const requestIndex = args.indexOf('--request');
if (requestIndex < 0 || !args[requestIndex + 1]) {
  console.error('Usage: decision-evaluate --request <dispatcher-request.json>');
  process.exit(2);
}
if (process.env.AIWG_DECISION_ENABLED !== '1') {
  console.error('Decision evaluation is disabled. Set AIWG_DECISION_ENABLED=1 to opt in.');
  process.exit(2);
}

let runtimePath;
try { runtimePath = resolveDecisionRuntime(import.meta.url); }
catch (error) { console.error(error.message); process.exit(2); }
const runtime = await import(pathToFileURL(runtimePath).href);
const requestPath = path.resolve(args[requestIndex + 1]);
const config = runtime.parseDecisionJson(await readFile(requestPath, 'utf8'));
const base = path.dirname(requestPath);
const loadJson = async file => runtime.parseDecisionJson(await readFile(path.resolve(base, file), 'utf8'));

const ruleset = await loadJson(config.rulesetPath);
const binding = await loadJson(config.bindingPath);
const input = await loadJson(config.inputPath);
const definitions = {};
for (const file of config.definitionPaths ?? []) {
  const definition = await loadJson(file);
  definitions[definition.metadata.id] = definition;
}

const adapters = { jev: new runtime.JevDecisionAdapter() };
for (const [id, file] of Object.entries(config.adapterModules ?? {})) {
  const module = await import(pathToFileURL(path.resolve(base, file)).href);
  adapters[id] = module.default ?? (await module.createAdapter?.());
  if (!adapters[id]) throw new Error(`Adapter module '${file}' did not export an adapter`);
}

const credentials = config.credentials ?? {};
// The receipt integrity key is local HMAC material. Its logical reference is
// reserved so no binding can route it to a remote backend as a credential.
const receiptKeyRef = config.receiptIntegrityKeyRef;
const resolveCredential = async logicalRef => {
  if (receiptKeyRef !== undefined && logicalRef === receiptKeyRef) {
    throw new Error(`Logical reference '${logicalRef}' is reserved for the receipt integrity key`);
  }
  const envName = credentials[logicalRef];
  if (typeof envName !== 'string' || !envName) throw new Error(`No runtime credential mapping for '${logicalRef}'`);
  const value = process.env[envName];
  if (!value) throw new Error(`Credential environment variable '${envName}' is unavailable`);
  return new TextEncoder().encode(value);
};

// Fail closed before evaluation. Messages name the logical reference and the
// environment-variable name only, never the key value or any decoded bytes.
const failReceiptKey = (category, message) => {
  process.stderr.write(`${JSON.stringify({ error: category, message })}\n`);
  process.exit(2);
};
const resolveReceiptIntegrityKey = () => {
  if (typeof receiptKeyRef !== 'string' || !receiptKeyRef) {
    failReceiptKey('receipt-integrity-key-missing', 'receiptDirectory requires receiptIntegrityKeyRef, a logical reference mapped in credentials');
  }
  const envName = credentials[receiptKeyRef];
  if (typeof envName !== 'string' || !envName) {
    failReceiptKey('receipt-integrity-key-missing', `No runtime credential mapping for receipt integrity key reference '${receiptKeyRef}'`);
  }
  const value = process.env[envName];
  if (!value) failReceiptKey('receipt-integrity-key-missing', `Receipt integrity key environment variable '${envName}' is unavailable`);
  const encoding = config.receiptIntegrityKeyEncoding ?? 'hex';
  const pattern = encoding === 'hex' ? /^(?:[0-9a-fA-F]{2})+$/
    : encoding === 'base64' ? /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
      : null;
  if (!pattern) failReceiptKey('receipt-integrity-key-invalid', "receiptIntegrityKeyEncoding must be 'hex' or 'base64'");
  const trimmed = value.trim();
  if (!pattern.test(trimmed)) failReceiptKey('receipt-integrity-key-invalid', `Receipt integrity key in '${envName}' is not valid ${encoding}`);
  const key = new Uint8Array(Buffer.from(trimmed, encoding));
  if (key.length < 32) failReceiptKey('receipt-integrity-key-invalid', `Receipt integrity key in '${envName}' must decode to at least 32 bytes`);
  return key;
};
const receiptStore = config.receiptDirectory
  ? new runtime.FileDecisionReceiptStore(path.resolve(base, config.receiptDirectory), { integrityKey: resolveReceiptIntegrityKey() })
  : undefined;

const result = await runtime.evaluateDecisionRuleset({
  ruleset,
  binding,
  definitions,
  input,
  runId: config.runId,
  invocationId: config.invocationId,
  adapters,
  resolveCredential,
  ...(receiptStore ? { receiptStore } : {}),
});
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
process.exit(result.spec.status === 'error' || result.spec.status === 'cancelled' ? 1 : 0);
