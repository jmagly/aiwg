#!/usr/bin/env node
// Inject bounded capability discovery at prompt time; errors always fail open.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { Worker } = require('node:worker_threads');

const configured = Number(process.env.AIWG_PROMPT_DISCOVERY_TIMEOUT_MS || 1500);
const budget = Number.isFinite(configured) && configured > 0 ? Math.min(configured, 10000) : 1500;
const deadline = Date.now() + budget;
let worker;
const finish = () => {
  if (worker) void worker.terminate();
  process.exit(0);
};
// Covers stdin, runtime lookup, imports, index loading, ranking and output.
setTimeout(finish, budget);
process.stdout.on('error', finish);

function runtimeModule() {
  const roots = process.env.AIWG_ROOT ? [process.env.AIWG_ROOT] : [];
  if (!roots.length) {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      if (!dir) continue;
      try { roots.push(path.dirname(path.dirname(fs.realpathSync(path.join(dir, 'aiwg'))))); }
      catch { /* This PATH entry has no AIWG executable. */ }
    }
  }
  for (const root of roots) {
    const modulePath = path.join(root, 'dist/src/artifacts/query-engine-discover.js');
    if (fs.existsSync(modulePath)) return pathToFileURL(modulePath).href;
  }
  return null;
}

function shouldDiscover(prompt) {
  if (!prompt || /^\/[a-z][\w:-]*(?:[ \t]+[^\n]*)?$/i.test(prompt)) return false;
  const words = prompt.split(/\s+/);
  // Short action requests still qualify; bare acknowledgements/options do not.
  const imperative = /\b(add|apply|audit|build|check|create|debug|delete|deploy|describe|disable|document|enable|explain|fetch|find|fix|generate|help|implement|inspect|install|list|look|make|read|refactor|remove|rename|repair|research|review|run|search|set|show|summarize|test|trace|update|use|validate|verify|write)\b/i;
  return words.length >= 4 || imperative.test(prompt);
}

function contextFor(envelope) {
  const clean = (value, max) => typeof value === 'string'
    ? value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[*_]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '';
  const prefix = 'AIWG candidates:\n';
  const next = '\nNext: aiwg show <type> <name> -> fetch required rule bodies (--rules --with-rule-bodies; --body) -> apply.';
  const candidates = (Array.isArray(envelope?.results) ? envelope.results : [])
    .filter(r => typeof r?.score === 'number' && Number.isFinite(r.score) && r.score >= 0.20
      && /^[a-z][a-z-]{0,19}$/.test(r.type) && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,69}$/.test(r.name))
    .sort((a, b) => b.score - a.score).slice(0, 3);
  // Share the remaining space so long names cannot push total context past 599.
  const labels = candidates.map(r => `${r.type} ${r.name} (${r.score.toFixed(2).slice(0, 6)}): `);
  const available = 599 - prefix.length - next.length - labels.join('\n').length;
  const perCapability = Math.min(100, Math.max(0, Math.floor(available / (candidates.length || 1))));
  const rows = candidates.map((r, i) => labels[i] + clean(r.capability, perCapability));
  if (!rows.length) return '';
  return prefix + rows.join('\n') + next;
}

async function main() {
  if (/^(0|false|off)$/i.test(process.env.AIWG_PROMPT_DISCOVERY || '') || process.stdin.isTTY) return finish();
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1024 * 1024) return finish();
    chunks.push(chunk);
  }
  const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (event.hook_event_name && event.hook_event_name !== 'UserPromptSubmit') return finish();
  const prompt = typeof event.prompt === 'string' ? event.prompt.trim() : '';
  if (!shouldDiscover(prompt)) return finish();
  const moduleUrl = runtimeModule();
  if (!moduleUrl || Date.now() >= deadline) return finish();
  // The installed discovery API prints a JSON envelope. Capture it inside the
  // isolated worker; no CLI bootstrap and no stdout/stderr leaks to the harness.
  worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    console.log = value => {
      if (typeof value === 'string') {
        try { parentPort.postMessage(JSON.parse(value)); } catch {}
      }
    };
    (async () => {
      const { discoverCapability } = await import(workerData.moduleUrl);
      await discoverCapability(workerData.cwd, {
        phrase: workerData.prompt, limit: 3, json: true, jsonPretty: false, promptContext: true,
        resourceSource: 'local', offline: true
      });
    })().catch(() => process.exit(0));
  `, {
    eval: true, stdout: true, stderr: true,
    workerData: { moduleUrl, prompt, cwd: process.cwd() },
  });
  worker.on('message', envelope => {
    if (Date.now() >= deadline) return finish();
    const context = contextFor(envelope);
    if (context) process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
    }) + '\n', finish);
    else finish();
  });
  worker.on('error', finish);
  worker.on('exit', finish);
}

main().catch(finish);
