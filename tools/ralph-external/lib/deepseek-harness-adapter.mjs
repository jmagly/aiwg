import { resolve, join } from 'node:path';
import { ProviderAdapter, registerProvider } from './provider-adapter.mjs';
import { assertSupportedDshVersion } from '../../providers/deepseek-harness-transport.mjs';
import { classifyWorkerHealthFailure, healthEventMatchesBinding } from './worker-health.mjs';

export class DeepSeekHarnessAdapter extends ProviderAdapter {
  // The headless surface supplies plain final/exit only. Cordis logs remain
  // unavailable until their locator, ownership and grammar are qualified.
  observeHealthEvent() { return null; }
  getBinary() { return process.env.AIWG_DSH_BIN || 'dsh'; }
  getName() { return 'deepseek-harness'; }
  getCapabilities() {
    return { streamJson: false, sessionResume: true, budgetControl: false,
      systemPrompt: false, agentMode: true, mcpConfig: true, maxTurns: false,
      rpcAbort: false };
  }
  async isAvailable() {
    if (!await super.isAvailable()) return false;
    try { assertSupportedDshVersion(await this.getVersion()); return true; } catch { return false; }
  }
  buildSessionArgs(options) {
    const args = ['--profile', 'headless'];
    const projectPatch = process.env.AIWG_DSH_PROJECT_PATCH || '.dsh/aiwg.cordis.patch.yml';
    args.push('--patch', resolve(projectPatch));
    if (process.env.AIWG_DSH_ROUTE_PATCH) args.push('--patch', resolve(process.env.AIWG_DSH_ROUTE_PATCH));
    if (options.budget) this.warnUnsupported('budgetControl', 'Budget control');
    if (options.maxTurns) this.warnUnsupported('maxTurns', 'Max turns');
    if (options.systemPrompt) this.warnUnsupported('systemPrompt', 'Appended system prompts');
    args.push(options.prompt);
    return args;
  }
  buildAnalysisArgs(options) { return this.buildSessionArgs(options); }
  mapModel(model) { return model; }
  getEnvOverrides() { return { DSH_PERMISSION_MODE: 'workspace-write', DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1' }; }
  parseOutput(stdout) {
    const text = stdout.trim();
    return text ? { events: [{ type: 'assistant_final', text }], settled: true, text } : null;
  }
}

registerProvider('deepseek-harness', () => new DeepSeekHarnessAdapter());
registerProvider('dsh', () => new DeepSeekHarnessAdapter());

/**
 * `dsh` (DeepSeek Harness) version-bound direct-worker profile
 * (roctinam/aiwg#2909). Evidence, grades and the exact commands run are
 * captured in docs/providers/deepseek-harness-direct.md. Summary:
 *
 *   dsh --profile headless --patch <patchPath> --json -   (brief on stdin, EOF)
 *
 * `--profile headless --help` (H, dsh 0.2.0-rc.2) lists no `--model`,
 * `--effort` or `--sandbox` flag; the task positional is `-` to read stdin
 * ("`-` reads stdin"). A no-model probe (no-login throwaway `DSH_HOME`,
 * `echo task | dsh --profile headless --json -`) proves `-` really reads
 * stdin to EOF and reaches the credential check (`MISSING_CREDENTIAL`
 * before any network call) rather than failing argv parsing — confirming
 * stdin arity per the LESSONS probe requirement.
 *
 * Model/effort/sandbox/approval are configured only through
 * `--profile headless --dump-config-schema`/`--dump-default-config`
 * (R-grade, read 2026-10-11): the `agent-default-model` plugin entry takes
 * `{ provider, model, reasoningEffort }` (schema `config9`, `required:
 * ["provider","model"]`; `reasoningEffort` enum observed on the bundled
 * `deepseek-official` provider config is `off|low|high|max`); the
 * `sandbox-policy` plugin entry takes `{ mode }` (`read-only|workspace-write|
 * danger-full-access`); the `approval` plugin entry takes `{ policy }`
 * (`ask|never`). This overlay shape comes only from the schema/default-config
 * dumps, never from a run that actually exercised a tool call, so it is
 * UNVERIFIED, not confirmed enforcement:
 *
 *   - Reaching `MISSING_CREDENTIAL` on the no-model probe below proves only
 *     that the `--patch` file is read and PARSED before any model call. It
 *     proves neither that `sandbox-policy.mode` actually confines file/exec
 *     access, nor what `approval.policy: "never"` actually permits, because
 *     no probe can exercise a tool call without a real model response.
 *   - The patch declares a matching named permission preset and explicit
 *     defaultPreset for every accepted sandbox/approval pairing (#4313).
 *     Plugin activation does not establish sandbox enforcement.
 *
 * Because of this, `model`/`effort`/`sandbox`/`approval` stay `unqualified`
 * in the registry below, matching grok-build/cursor/opencode's convention
 * for controls evidenced only by help, source or no-model probes.
 *
 * Execution-time patch delivery uses buildWorkerArtifacts, a pure declaration.
 * Resolution emits an artifact placeholder; only the launcher writes the patch
 * into its owned private run directory with exclusive no-follow creation and
 * cleanup. No preview edits account defaults or writes a patch file.
 *
 * `DEEPSEEK_API_KEY` is the credential env var the no-model probe's
 * `MISSING_CREDENTIAL` error names (`llm-deepseek: no API key for
 * provider route "deepseek-official"; ... export DEEPSEEK_API_KEY`); it is
 * the default route credential. The opt-in direct-shell-openrouter profile
 * instead allowlists OPENROUTER_API_KEY (names only, values never rendered).
 *
 * KNOWN GAP (isolation): `getEnvOverrides()` is called with no invocation
 * context (`session-launcher.mjs` ~847: `providerAdapter.getEnvOverrides()`),
 * so a per-run `DSH_HOME` cannot be synthesized here without either sharing
 * one `DSH_HOME` across concurrent runs (an isolation/crossover risk per
 * T-OG-17) or editing shared launcher code. This profile therefore leaves
 * `DSH_HOME` unset (the operator's real home); the needed shared change is
 * passing invocation context (e.g. `runDir`) into `getEnvOverrides()`.
 *
 * `--json` event grammar (R-grade; read from the installed
 * `@deepseek-ai/dsh-headless` package's own `json-stream-*.js` and
 * `index.js`, 2026-10-11; confirmed live via the no-model probe's exact
 * `session`/`status`/`final` lines): exactly one `{"type":"session",...}`
 * first; `{"type":"status","phase":"turn_start"|"step_start"|"step_end"|
 * "turn_end","turn":N,...}` (a `turn_end` carries `"reason":{"kind":...}`;
 * any other `phase` is rejected as unknown); `{"type":"text"|"thinking",
 * "text":...}` for assistant content; `{"type":"tool_call",...}`/
 * `{"type":"tool_result","status":"completed"|"error",...}`; exactly one
 * terminal `{"type":"final","text":...}` last, and nothing after it.
 * `index.js`'s own `run()` sets the process exit code with
 * `io.exit(outcome.reason?.kind === "completed" ? 0 : 1)` — only
 * `"completed"` is success; `final.text` is the last non-empty assistant
 * text seen since this task's `turn/start`, independent of success (an
 * error path can still carry partial text), so this profile never treats
 * exit code or non-empty `final.text` alone as success. A `turn_start`
 * RESETS the completion flag (a later, unfinished turn after an earlier
 * completed one must not inherit that earlier success), so only the LAST
 * turn's `turn_end.reason.kind === "completed"` counts, with no top-level
 * `{"type":"error",...}` line and no `tool_result` with `status:"error"`
 * anywhere.
 */
export const DEEPSEEK_HARNESS_SUPPORTED_VERSIONS = Object.freeze(['0.2.0-rc.2', '0.2.2-rc.1']);
export const DEEPSEEK_HARNESS_DIRECT_EFFORT_VALUES = Object.freeze(['off', 'low', 'high', 'max']);
export const DEEPSEEK_HARNESS_DIRECT_SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write']);
/** Non-prompting execution only: `ask` (the only alternative the CLI's own
 * `APPROVAL_POLICIES` enum offers) can block on a prompt headless has no
 * channel to answer. */
export const DEEPSEEK_HARNESS_DIRECT_APPROVAL_POLICIES = Object.freeze(['never']);
/** Brief transport for the direct profile: piped stdin (`-`), never argv. */
export const DEEPSEEK_HARNESS_DIRECT_STDIN = 'brief-text';
const AUTO_SELECTION_VALUES = Object.freeze(['auto', 'default']);
/** Conservative identifier charset for YAML-embedded values: letters,
 * digits, `.`, `_`, `-`, `/`, `:`, first character alphanumeric. Rejects
 * YAML-significant and quoting characters (quotes, anchors/tags, newlines,
 * whitespace) outright, in addition to the `JSON.stringify` quoting
 * applied when the value is written into the patch. */
const DEEPSEEK_HARNESS_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._\-/:]*$/;

function requireOptionSafeString(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error(`DeepSeek Harness worker requires ${label}`);
  if (value.startsWith('-') || /[\s\u0000-\u001f]/.test(value)) {
    throw new Error(`DeepSeek Harness worker ${label} cannot look like an option: ${JSON.stringify(value)}`);
  }
  return value;
}

function normalizeDeepSeekHarnessModel(model) {
  const value = requireOptionSafeString(model, 'an explicit model');
  if (AUTO_SELECTION_VALUES.includes(value.toLowerCase())) {
    throw new Error(`DeepSeek Harness worker requires an exact model, not an auto-selected value: ${JSON.stringify(value)}`);
  }
  if (!DEEPSEEK_HARNESS_IDENTIFIER.test(value)) {
    throw new Error(`DeepSeek Harness worker model must use a conservative identifier charset: ${JSON.stringify(value)}`);
  }
  return value;
}

function normalizeDeepSeekHarnessEffort(effort) {
  if (typeof effort !== 'string' || !DEEPSEEK_HARNESS_DIRECT_EFFORT_VALUES.includes(effort)) {
    throw new Error('DeepSeek Harness worker requires an explicit qualified reasoning effort (never a CLI default)');
  }
  return effort;
}

function normalizeDeepSeekHarnessSandbox(sandbox) {
  if (!DEEPSEEK_HARNESS_DIRECT_SANDBOX_MODES.includes(sandbox)) {
    throw new Error(`DeepSeek Harness worker sandbox is not a qualified direct mode: ${String(sandbox)}`);
  }
  return sandbox;
}

function normalizeDeepSeekHarnessApproval(approval) {
  if (!DEEPSEEK_HARNESS_DIRECT_APPROVAL_POLICIES.includes(approval)) {
    throw new Error(`DeepSeek Harness worker approval is not a qualified direct policy: ${String(approval)}`);
  }
  return approval;
}

function normalizeDeepSeekHarnessProvider(provider = 'deepseek-official') {
  if (provider === 'deepseek') return 'deepseek-official';
  if (!['deepseek-official', 'openrouter'].includes(provider)) {
    throw new Error('DeepSeek Harness worker requires a supported inference provider');
  }
  return provider;
}

/** Pure: the `--patch` overlay YAML text for one invocation's model,
 * effort, sandbox and approval. Performs no I/O — see the module-level
 * execution-time artifact contract. Exported so tests and the docs' manual smoke
 * command can write this text themselves. Every value is validated against
 * a conservative charset/enum AND `JSON.stringify`-quoted in the emitted
 * YAML (defense in depth): neither alone is trusted. The patch never
 * carries the brief or a credential.
 * @param {{ model: unknown, effort: unknown, sandbox: unknown, approval: unknown, inferenceProvider?: unknown }} selection
 * @returns {string}
 */
export function buildDeepSeekHarnessPatch({ model, effort, sandbox, approval, inferenceProvider }) {
  const safeModel = normalizeDeepSeekHarnessModel(model);
  const safeEffort = normalizeDeepSeekHarnessEffort(effort);
  const safeSandbox = normalizeDeepSeekHarnessSandbox(sandbox);
  const safeApproval = normalizeDeepSeekHarnessApproval(approval);
  const provider = normalizeDeepSeekHarnessProvider(inferenceProvider);
  const preset = `headless-${safeSandbox}`;
  return [
    ...(provider === 'openrouter' ? [
      '- id: llm-pi-ai', '  config:', '    providers:', '      openrouter:',
      '        apiKeyEnv: OPENROUTER_API_KEY',
    ] : []),
    '- id: agent-default-model',
    '  config:',
    `    provider: ${JSON.stringify(provider)}`,
    `    model: ${JSON.stringify(safeModel)}`,
    `    reasoningEffort: ${JSON.stringify(safeEffort)}`,
    '- id: sandbox-policy',
    '  config:',
    `    mode: ${JSON.stringify(safeSandbox)}`,
    '- id: approval',
    '  config:',
    `    policy: ${JSON.stringify(safeApproval)}`,
    '- id: permission',
    '  config:',
    `    defaultPreset: ${JSON.stringify(preset)}`,
    '    presets:',
    `      ${preset}:`,
    `        sandbox: ${JSON.stringify(safeSandbox)}`,
    `        approval: ${JSON.stringify(safeApproval)}`,
    '',
  ].join('\n');
}

/** Pure placeholder: the launcher substitutes its private, per-run path. */
export function deepSeekHarnessPatchPath(_invocation) {
  return '${artifact:dsh-patch}';
}

/** Strict scan of one `--json` stdout capture against the grammar documented
 * above. Throws on any malformed line, a `session` event that is not
 * first/is duplicated, an unknown `status` phase, an unknown event type, a
 * top-level `error` event, a `tool_result` with `status:"error"`, a
 * non-object/non-string `final.text`, or `final` not being the last line.
 * A `turn_start` resets the completion flag, so an unfinished later turn
 * after an earlier completed one is rejected. Returns `{ text, completed }`
 * where `completed` reflects only the LAST observed `turn_end`.
 */
export function parseDeepSeekHarnessTerminal(output, maxOutputBytes = 10 * 1024 * 1024) {
  if (typeof output !== 'string' && !(output instanceof Uint8Array)) throw new Error('DeepSeek Harness output must be bytes or text');
  const bytes = typeof output === 'string' ? Buffer.from(output) : output;
  if (bytes.byteLength > maxOutputBytes) throw new Error('DeepSeek Harness stream exceeds byte bound');
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const KNOWN_PHASES = ['turn_start', 'step_start', 'step_end', 'turn_end'];
  let sawSession = false, completed = false, finalText = null, finalSeen = false;
  const lines = text.split('\n').filter(line => line.trim());
  for (let i = 0; i < lines.length; i += 1) {
    if (finalSeen) throw new Error('DeepSeek Harness event after final terminal');
    let event;
    try { event = JSON.parse(lines[i]); } catch { throw new Error('Malformed DeepSeek Harness event'); }
    if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') {
      throw new Error('Malformed DeepSeek Harness event');
    }
    if (event.type === 'error') throw new Error(`DeepSeek Harness error event: ${String(event.message)}`);
    if (event.type === 'session') {
      if (i !== 0 || sawSession) throw new Error('DeepSeek Harness session event must be exactly one, first');
      sawSession = true;
      continue;
    }
    if (!sawSession) throw new Error('DeepSeek Harness session event must be exactly one, first');
    if (event.type === 'status') {
      if (!KNOWN_PHASES.includes(event.phase)) throw new Error(`Unknown DeepSeek Harness status phase: ${String(event.phase)}`);
      if (event.phase === 'turn_start') completed = false;
      if (event.phase === 'turn_end') completed = event.reason?.kind === 'completed';
      continue;
    }
    if (event.type === 'tool_result') {
      if (event.status === 'error') throw new Error('DeepSeek Harness tool_result error');
      continue;
    }
    if (['text', 'thinking', 'tool_call'].includes(event.type)) continue;
    if (event.type === 'final') {
      if (typeof event.text !== 'string') throw new Error('Malformed DeepSeek Harness final');
      finalText = event.text;
      finalSeen = true;
      continue;
    }
    throw new Error(`Unknown DeepSeek Harness event type: ${event.type}`);
  }
  if (!sawSession) throw new Error('Missing DeepSeek Harness session event');
  if (!finalSeen) throw new Error('Missing DeepSeek Harness final event');
  if (!completed) throw new Error('DeepSeek Harness run did not complete');
  if (typeof finalText !== 'string' || !finalText.trim()) throw new Error('Missing DeepSeek Harness final text');
  return { text: finalText, completed };
}

/** Direct worker profile: strict terminal validation layered over the
 * legacy `DeepSeekHarnessAdapter`'s lenient `parseOutput`/`buildSessionArgs`,
 * which stay untouched for the legacy Ralph loop (mirrors
 * `claude-adapter.mjs`'s `ClaudeDirectAdapter` precedent).
 */
export class DeepSeekHarnessDirectAdapter extends DeepSeekHarnessAdapter {
  // #2909 fix round 1 (item 2, mirrors #2995's FactoryDirectAdapter): production
  // resolves the installed adapter by `adapter.id` (`deepseek-harness-direct`)
  // and `src/models/worker-installation.mjs`'s `inspectWorkerInstallation`
  // requires `adapter.id === instance.getName()`. `getBinary()` (the real
  // `dsh` executable) and the `provider: 'deepseek-harness'` literals inside
  // `observeHealthEvent` are untouched -- only this identity label changes.
  getName() { return 'deepseek-harness-direct'; }

  observeHealthEvent(event, source, binding) {
    if (source.kind !== 'stdout' || !event || typeof event !== 'object') return null;
    if (!healthEventMatchesBinding({ sessionId: event.sessionId }, binding)) return null;
    if (event.type === 'session' && typeof event.sessionId === 'string') return { kind: 'setup', sessionId: event.sessionId };
    if (event.type === 'status') {
      if (event.phase === 'turn_start') return { kind: 'accepted', key: event.turn };
      if (event.phase === 'step_start' || event.phase === 'step_end') return { kind: 'progress', key: `${event.turn}:${event.step}` };
      if (event.phase === 'turn_end') {
        if (event.reason?.kind === 'completed') return { kind: 'terminal', success: true, key: `turn_end:${event.turn}` };
        return { ...classifyWorkerHealthFailure({ type: 'error', message: event.reason?.error?.message ?? event.reason?.kind }, { source, provider: 'deepseek-harness' }), fatal: true };
      }
      return null;
    }
    if (event.type === 'text' || event.type === 'thinking') return { kind: 'activity' };
    if (event.type === 'tool_call') return { kind: 'progress', key: event.callId };
    if (event.type === 'tool_result') {
      if (event.status === 'error') return { kind: 'error', reasonCode: 'tool-failed' };
      return { kind: 'progress', key: event.callId };
    }
    if (event.type === 'error') {
      return { ...classifyWorkerHealthFailure({ type: 'error', message: event.message }, { source, provider: 'deepseek-harness' }), fatal: true };
    }
    return null;
  }

  /** Driver-owned argv. PURE: performs no I/O (#2909 fix round 1, item 1 —
   * `resolveWorkerInvocation` calls this during resolution/preview as well
   * as dispatch, and installed preparation/revalidation calls it again, so
   * a write here would fire on every preview and let concurrent finals
   * sharing a directory overwrite each other's controls). No brief text on
   * argv (stdin only, via `-`); no invented `--model`/`--effort`/`--sandbox`
   * flags (none exist). Model/effort/sandbox/approval are validated here
   * (via {@link buildDeepSeekHarnessPatch}, result discarded) so argv is
   * never rendered for a control this profile cannot actually enforce, and
   * the launcher writes the declared patch at execution time. */
  buildWorkerArgs(invocation, _profile, permissions = {}) {
    const model = invocation?.selected?.model;
    const effort = invocation?.selected?.effort?.value;
    const sandbox = permissions.sandbox ?? 'workspace-write';
    const approval = permissions.approval ?? 'never';
    const inferenceProvider = normalizeDeepSeekHarnessProvider(invocation?.selected?.inferenceProvider);
    const key = inferenceProvider === 'openrouter' ? 'OPENROUTER_API_KEY' : 'DEEPSEEK_API_KEY';
    if (_profile && !_profile.envAllowlist?.includes(key)) {
      throw new Error('DeepSeek Harness worker inference provider does not match the selected profile');
    }
    buildDeepSeekHarnessPatch({ model, effort, sandbox, approval, inferenceProvider });
    const cwd = invocation?.cwd;
    if (typeof cwd !== 'string' || !cwd.startsWith('/') || cwd.includes('\0')) throw new Error('DeepSeek Harness worker requires an absolute workspace');
    const brief = invocation?.brief;
    // Resolution supplies brief text; installed rechecks carry only its path.
    // Neither form contributes prompt bytes to argv.
    if (brief !== undefined ? typeof brief !== 'string' || !brief || brief.includes('\0')
      : typeof invocation?.briefPath !== 'string' || !invocation.briefPath.startsWith('/') || invocation.briefPath.includes('\0')) {
      throw new Error('DeepSeek Harness worker requires a non-empty brief or an absolute brief path');
    }
    const patchPath = deepSeekHarnessPatchPath(invocation);
    return ['--profile', 'headless', '--patch', patchPath, '--json', '-'];
  }

  /** Pure execution-time artifact declaration; workspace-relative locations
   * are intentionally unsupported by the shared launcher. */
  buildWorkerArtifacts(invocation) {
    const permissions = invocation.permissions ?? {};
    return [{ name: 'dsh-patch', location: 'run-directory', content: buildDeepSeekHarnessPatch({
      model: invocation.selected.model, inferenceProvider: invocation.selected.inferenceProvider, effort: invocation.selected.effort.value,
      sandbox: permissions.sandbox ?? 'workspace-write', approval: permissions.approval ?? 'never',
    }) }];
  }

  /** No evidenced stdin abort channel; stdin carries the brief to EOF. */
  getAbortInput() { return null; }

  /** Candidate extractor consumed by the installed driver's extraction
   * hook: `null` for anything not an affirmative, completed success. */
  parseOutput(stdout) {
    try { return { text: parseDeepSeekHarnessTerminal(stdout).text }; } catch { return null; }
  }

  /** Authoritative final-claim gate (session-launcher.mjs's `finalValid`/
   * `extractFinal`). Re-validates strictly, then hands only the model's own
   * final text to the shared strict `workerClaims` parser, mirroring
   * `ClaudeDirectAdapter`/`OpenClawAdapter`. */
  async parseWorkerFinal(output, options = {}) {
    if (options.format === 'mcp') return super.parseWorkerFinal(output, options);
    const text = typeof output === 'string' ? output : Buffer.from(output).toString('utf8');
    const terminal = parseDeepSeekHarnessTerminal(text);
    return super.parseWorkerFinal(terminal.text, { ...options, format: 'json' });
  }
}

/** Installed-module interface version (mirrors codex-adapter.mjs/
 * openclaw-adapter.mjs). */
export const interfaceVersion = 1;

/** Installed-module registration: the direct class loads under its own id,
 * never the legacy `deepseek-harness`/`dsh` ids (loading it must not
 * overwrite the legacy Ralph-loop registration in-process). */
export function register(factory) {
  factory('deepseek-harness-direct', () => new DeepSeekHarnessDirectAdapter());
}

export default DeepSeekHarnessAdapter;
