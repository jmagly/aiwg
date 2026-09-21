#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createForgePrAdapter } from './pr-evidence-forge.mjs';
import { collectPrEvidence, assessPrEvidence } from './pr-evidence-receipt.mjs';

const usage = 'Usage: pr-evidence-receipt-cli.mjs --provider github|gitea --api-url URL --repo owner/name --number N --base-context FILE [--config FILE] [--proposed-action ACTION]';

export async function runPrEvidenceCli(argv, { fetchImpl = fetch, stdout = process.stdout } = {}) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help') { stdout.write(`${usage}\n`); return; }
    if (!['--provider', '--api-url', '--repo', '--number', '--base-context', '--config', '--proposed-action'].includes(key)
      || !argv[index + 1]) throw new Error(usage);
    options[key.slice(2)] = argv[++index];
  }
  if (!options.provider || !options['api-url'] || !options.repo || !options.number || !options['base-context']) {
    throw new Error(usage);
  }
  const canonicalBase = JSON.parse(readFileSync(options['base-context'], 'utf8'));
  const projectConfig = options.config ? JSON.parse(readFileSync(options.config, 'utf8')) : {};
  const number = Number(options.number);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('PR number must be a positive integer');
  const adapter = createForgePrAdapter({ provider: options.provider, apiBaseUrl: options['api-url'],
    canonicalBase, token: process.env.AIWG_FORGE_TOKEN, fetchImpl });
  const snapshot = await collectPrEvidence(adapter, { repository: options.repo, number });
  const receipt = assessPrEvidence(snapshot, projectConfig.security?.threatAssessment,
    { proposedAction: options['proposed-action'] ?? 'read-only-triage' });
  stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runPrEvidenceCli(process.argv.slice(2)).catch(error => {
    console.error(`pr-evidence-receipt: ${error.message}`);
    process.exitCode = 1;
  });
}
