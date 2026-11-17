/** Observe Cursor's exact account model selectors through its bounded read-only list command. */
import type { WorkerInstallation } from '../config/worker-parallelism.js';
import { tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { buildWorkerObservation, classifyDiscoveryError, discoveryDigest, redactModelDiscoveryText,
  runModelDiscoveryCommand, type ModelDiscoveryCommandRunner, type ModelDiscoveryOptions,
  type ProviderModelDiscovery } from './model-discovery.js';

function diagnostic(value: string): string {
  // Redact bearer values before assignment redaction consumes the scheme.
  return redactModelDiscoveryText(value.replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]'));
}

export async function discoverCursorListModels(
  command = 'cursor-agent',
  runner: ModelDiscoveryCommandRunner = runModelDiscoveryCommand,
  options: { runtimeVersion?: string; accountBinding?: string; cliId?: string; modelLimits?: WorkerInstallation['modelLimits']; now?: () => Date } = {},
): Promise<ProviderModelDiscovery> {
  const observedAt = (options.now?.() ?? new Date()).toISOString();
  const base: ProviderModelDiscovery = { provider: 'cursor', source: 'native', observedAt,
    accountScope: 'local-account', ...(options.accountBinding ? { accountBinding: options.accountBinding } : {}), models: [] };
  try {
    let version = options.runtimeVersion;
    if (!version) {
      const probe = await runner(command, ['--version'], { cwd: tmpdir(), timeoutMs: 5000 });
      // Cursor emits a plain date-version banner. Retain only that known shape.
      if (probe.exitCode === 0) version = /^(\d+\.\d+\.\d+-[\w.-]+)$/.exec(probe.stdout.trim())?.[1]
        .replace(/^(\d+)\.(\d+)\.(\d+)/, (_, major, minor, patch) => [major, minor, patch].map(Number).join('.'));
    }
    if (version) base.runtimeVersion = version;
    const result = await runner(command, ['--list-models'], { cwd: tmpdir(), timeoutMs: 15_000 });
    if (result.exitCode !== 0) {
      const error = diagnostic(result.stderr.trim() || result.stdout.trim())
        || `Cursor --list-models exited ${result.exitCode}`;
      return { ...base, errorKind: /not logged in|log in|sign in/i.test(error) ? 'authentication' : classifyDiscoveryError(error), error };
    }
    const diagnostics: string[] = [];
    const seen = new Set<string>();
    for (const [index, raw] of result.stdout.split(/\r?\n/).entries()) {
      const line = stripVTControlCharacters(raw).replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim();
      if (!line || /^Available models$/i.test(line) || /^Tip: use --model <id>/.test(line)) continue;
      const match = /^([a-z0-9][a-z0-9._-]*) - (\S.*)$/i.exec(line);
      if (!match || /[\x00-\x1f\x7f]/.test(line)) {
        diagnostics.push(`Cursor --list-models line ${index + 1}: malformed model row`);
        continue;
      }
      const [, id, label] = match;
      if (seen.has(id)) { diagnostics.push(`Cursor --list-models line ${index + 1}: duplicate model selector`); continue; }
      seen.add(id);
      const displayName = label.replace(/(?:\s+\([^()]*\))+$/, '').trim();
      const automatic = /^(?:auto|default)$/i.test(id);
      // Effort belongs to the exact selector; never invent bracket overrides or
      // a default effort for a name that does not report a variant.
      const effort = /-extra-high(?:-fast)?$/.test(id) ? 'xhigh'
        : /-(minimal|none|low|medium|high|xhigh|max)(?:-fast)?$/.exec(id)?.[1];
      const declared = Object.hasOwn(options.modelLimits ?? {}, id) ? options.modelLimits![id] : undefined;
      const displayContext = /(?:^|\s)1M(?:\s|$)/.test(displayName) ? 1_000_000 : undefined;
      const worker = buildWorkerObservation({ cliId: options.cliId ?? 'cursor', source: `${command} --list-models`,
        pointer: `/lines/${index + 1}`, runtimeVersion: version ?? 'unknown', accountScope: 'local-account',
        accountBinding: options.accountBinding, observedAt, contentDigest: discoveryDigest(line) }, {
        modelId: id, family: 'unknown', visibility: 'listed', lifecycle: 'active',
        availability: automatic ? 'unavailable' : 'accessible',
        contextTokens: declared?.contextTokens ?? displayContext, maxOutputTokens: declared?.maxOutputTokens,
        efforts: !automatic && effort ? [{ id: effort, selfDelegates: null }] : [],
        provenanceFields: ['/apiModelId:listed-selector', '/llmProvider:cursor-gateway', '/displayName', '/efforts:selector-suffix',
          ...(!declared && displayContext ? ['/contextTokens:display-name-1M'] : [])],
      });
      if (declared) {
        // The native list does not attest operator limits.
        worker.provenance[0].fields = worker.provenance[0].fields.filter(field =>
          field !== '/contextTokens' && (declared.maxOutputTokens === undefined || field !== '/maxOutputTokens'));
        const source = `/parallelism/clis/${options.cliId ?? 'cursor'}/modelLimits`;
        worker.provenance.push({ fields: ['/contextTokens', ...(declared.maxOutputTokens === undefined ? [] : ['/maxOutputTokens'])],
          source, kind: 'operator', observedAt, digest: discoveryDigest(JSON.stringify({ id, ...declared })), confidence: 'reported' });
        worker.evidenceDigest = discoveryDigest(JSON.stringify({ native: worker.evidenceDigest, source, id, ...declared }));
      }
      // The list identifies the Cursor gateway selector, not an attested
      // upstream API model, vendor, family or data policy.
      base.models.push({ id, apiModelId: id, llmProvider: 'cursor', displayName,
        isDefault: /\([^()]*\bdefault\b[^()]*\)/i.test(label), hidden: false,
        reasoningEfforts: worker.efforts.map(entry => entry.id), worker });
    }
    return { ...base, ...(diagnostics.length || !base.models.length ? { errorKind: 'invalid-output' as const,
      error: diagnostics.join('; ') || 'Cursor returned no parseable model rows.' } : {}) };
  } catch (cause) {
    const error = diagnostic(cause instanceof Error ? cause.message : 'Cursor discovery command failed');
    return { ...base, models: [], errorKind: classifyDiscoveryError(error), error };
  }
}

/** Bind refresh to the configured Cursor executable and account label when unambiguous. */
export async function discoverProjectCursorModels(options: ModelDiscoveryOptions): Promise<ProviderModelDiscovery> {
  const clis = Object.entries(options.parallelism?.clis ?? {}).filter(([id, cli]) =>
    cli.enabled !== false && !cli.localModels && (cli.adapter ?? `providers:${id}`) === 'providers:cursor');
  const [cliId, cli] = clis.length === 1 ? clis[0] : [];
  return discoverCursorListModels(cli?.executable, options.runner, { cliId, accountBinding: cli?.accountScope, modelLimits: cli?.modelLimits, now: options.now });
}
