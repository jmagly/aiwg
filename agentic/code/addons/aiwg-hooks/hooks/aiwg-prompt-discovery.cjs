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
  if (/^\[SYSTEM NOTIFICATION - NOT USER INPUT\]/i.test(prompt)
    || /<(?:task-notification|system-reminder|tool[_-]result)(?=[\s>])/i.test(prompt)) return false;
  const words = prompt.split(/\s+/);
  // Short action requests still qualify; bare acknowledgements/options do not.
  const imperative = /\b(add|apply|audit|build|check|create|debug|delete|deploy|describe|disable|document|enable|explain|fetch|find|fix|generate|help|implement|inspect|install|list|look|make|read|refactor|remove|rename|repair|research|review|run|search|set|show|summarize|test|trace|update|use|validate|verify|write)\b/i;
  return words.length >= 4 || imperative.test(prompt);
}

function contextFor(envelope, prompt) {
  const clean = (value, max) => typeof value === 'string'
    ? value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/[*_]/g, '').replace(/\s+/g, ' ').trim().slice(0, max) : '';
  const prefix = 'AIWG candidates:\n';
  const next = '\nFirst call: aiwg show <type> <name> (best fit) -> rules (--rules --with-rule-bodies; --body) -> apply.'
    + '\nIf none fit, run aiwg discover; never decline without it.';
  const candidates = (Array.isArray(envelope?.results) ? envelope.results : [])
    .filter(r => typeof r?.score === 'number' && Number.isFinite(r.score) && r.score >= 0.20
      && /^[a-z][a-z-]{0,19}$/.test(r.type) && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,69}$/.test(r.name))
    .sort((a, b) => b.score - a.score).slice(0, 3);
  const template = candidates.find(candidate => candidate.templates?.length)?.templates?.[0];
  const templateHint = template && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,69}$/.test(template.name)
    && /^aiwg show template [a-zA-Z0-9][a-zA-Z0-9_.:-]{0,149}$/.test(template.show_command)
    ? `\nTemplate ${template.name}: ${template.show_command}` : '';
  // 0.70 excludes the UAT's unrelated 0.60/0.40 hits; retain today's top 3
  // only when at least one candidate supplies a stronger signal.
  // Muse UAT (2026-11-06): advisory wording was ignored; first-call wording was followed.
  if (!candidates.some(r => r.score >= 0.70)) {
    // Restrict by type only when the request asks for an AIWG component of that type, not when a
    // type word merely appears ("removes every managed Claude hook" is not a hook search).
    const namedType = prompt.match(/\b(?:aiwg|is there an?|are there any|find|list|which|what)\s+(?:aiwg\s+)?(decision-definition|decision-ruleset|decision-binding|gate-pack|skill|agent|command|rule|schema|flow|runbook|template|behavior|hook|workflow)s?\b/i)?.[1].toLowerCase();
    const type = namedType === 'workflow' ? 'flow' : namedType;
    // The request goes through a quoted heredoc so the shell never expands it (#3946).
    // One line: multi-line wording lowered first-call compliance in harness UAT.
    let need = prompt.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/AIWG_REQUEST/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);
    const instruction = () => `Before any other tool call or answer, run: aiwg discover --stdin${type ? ` --type ${type}` : ''} <<'AIWG_REQUEST' with the request on the next line and AIWG_REQUEST on the last line (never put request text in quotes on a command line), then answer from its result. Answering or declining without running it violates the skill-discovery rule. Request: ${need}${templateHint}`;
    while (instruction().length > 599 && need.length) need = need.slice(0, -1);
    return instruction();
  }
  // Leave room for the template drill-in even when candidate names are long.
  while (candidates.length > 1 && prefix.length + next.length + templateHint.length
    + candidates.map(r => `${r.type} ${r.name} (${r.score.toFixed(2).slice(0, 6)}): `).join('\n').length > 599) candidates.pop();
  // Share the remaining space so long names cannot push total context past 599.
  const labels = candidates.map(r => `${r.type} ${r.name} (${r.score.toFixed(2).slice(0, 6)}): `);
  const available = 599 - prefix.length - next.length - templateHint.length - labels.join('\n').length;
  const perCapability = Math.min(100, Math.max(0, Math.floor(available / (candidates.length || 1))));
  const rows = candidates.map((r, i) => labels[i] + clean(r.capability, perCapability));
  if (!rows.length) return '';
  return prefix + rows.join('\n') + templateHint + next;
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
  if ([event.role, event.message?.role].some(role => role && role !== 'user')
    || /^(system|notification|tool[_-]result)$/.test(event.type || '')) return finish();
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
    const context = contextFor(envelope, prompt);
    if (context) process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context },
    }) + '\n', finish);
    else finish();
  });
  worker.on('error', finish);
  worker.on('exit', finish);
}

main().catch(finish);
