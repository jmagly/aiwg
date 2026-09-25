import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Dispatcher logic behind decision-evaluate.mjs. The runtime module is injected
 * so tests can drive the same code path against the source tree; the CLI passes
 * the packaged dist build.
 *
 * Returns the process exit code: 0 on a composed result, 1 on an error or
 * cancelled result, 2 on a usage or egress-configuration refusal.
 */
export async function runDecisionEvaluate({ argv, env, runtime, stdout, stderr }) {
  const requestIndex = argv.indexOf('--request');
  if (requestIndex < 0 || !argv[requestIndex + 1]) {
    stderr.write('Usage: decision-evaluate --request <dispatcher-request.json>\n');
    return 2;
  }
  if (env.AIWG_DECISION_ENABLED !== '1') {
    stderr.write('Decision evaluation is disabled. Set AIWG_DECISION_ENABLED=1 to opt in.\n');
    return 2;
  }

  const requestPath = path.resolve(argv[requestIndex + 1]);
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

  // Host transport configuration only. Region is a declared deployment attribute.
  const jevOptions = config.adapterOptions?.jev ?? {};
  const adapters = { jev: new runtime.JevDecisionAdapter({
    ...(jevOptions.endpoint ? { endpoint: jevOptions.endpoint } : {}),
    ...(jevOptions.allowedOrigins ? { allowedOrigins: jevOptions.allowedOrigins } : {}),
    ...(jevOptions.region ? { region: jevOptions.region } : {}),
  }) };
  for (const [id, file] of Object.entries(config.adapterModules ?? {})) {
    const module = await import(pathToFileURL(path.resolve(base, file)).href);
    adapters[id] = module.default ?? (await module.createAdapter?.());
    if (!adapters[id]) throw new Error(`Adapter module '${file}' did not export an adapter`);
  }

  // Projection policy is host configuration loaded from a trusted path, never from input.
  const policies = config.projectionPolicyPath ? [await loadJson(config.projectionPolicyPath)].flat() : [];
  for (const policy of policies) runtime.validateProjectionPolicy(policy);

  // Refuse network-capable adapters without a projection policy before any credential or transport use.
  if (!policies.length) {
    const used = new Set(Object.values(binding.spec?.evaluations ?? {})
      .flatMap(evaluation => (evaluation.targets ?? []).map(target => target.adapter)));
    for (const id of [...used].sort()) {
      const capabilities = adapters[id] ? await adapters[id].capabilities() : undefined;
      if (capabilities && capabilities.egress?.mode !== 'none') {
        stderr.write(`Decision evaluation refused: adapter '${id}' can send state over the network and no `
          + 'projectionPolicyPath is configured.\n');
        return 2;
      }
    }
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
    const value = env[envName];
    if (!value) throw new Error(`Credential environment variable '${envName}' is unavailable`);
    return new TextEncoder().encode(value);
  };

  // Fail closed before evaluation. Messages name the logical reference and the
  // environment-variable name only, never the key value or any decoded bytes.
  const failReceiptKey = (category, message) => {
    stderr.write(`${JSON.stringify({ error: category, message })}\n`);
    return null;
  };
  const resolveReceiptIntegrityKey = () => {
    if (typeof receiptKeyRef !== 'string' || !receiptKeyRef) {
      return failReceiptKey('receipt-integrity-key-missing', 'receiptDirectory requires receiptIntegrityKeyRef, a logical reference mapped in credentials');
    }
    const envName = credentials[receiptKeyRef];
    if (typeof envName !== 'string' || !envName) {
      return failReceiptKey('receipt-integrity-key-missing', `No runtime credential mapping for receipt integrity key reference '${receiptKeyRef}'`);
    }
    const value = env[envName];
    if (!value) return failReceiptKey('receipt-integrity-key-missing', `Receipt integrity key environment variable '${envName}' is unavailable`);
    const encoding = config.receiptIntegrityKeyEncoding ?? 'hex';
    const pattern = encoding === 'hex' ? /^(?:[0-9a-fA-F]{2})+$/
      : encoding === 'base64' ? /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
        : null;
    if (!pattern) return failReceiptKey('receipt-integrity-key-invalid', "receiptIntegrityKeyEncoding must be 'hex' or 'base64'");
    const trimmed = value.trim();
    if (!pattern.test(trimmed)) return failReceiptKey('receipt-integrity-key-invalid', `Receipt integrity key in '${envName}' is not valid ${encoding}`);
    const key = new Uint8Array(Buffer.from(trimmed, encoding));
    if (key.length < 32) return failReceiptKey('receipt-integrity-key-invalid', `Receipt integrity key in '${envName}' must decode to at least 32 bytes`);
    return key;
  };
  let receiptStore;
  if (config.receiptDirectory) {
    const integrityKey = resolveReceiptIntegrityKey();
    if (!integrityKey) return 2;
    receiptStore = new runtime.FileDecisionReceiptStore(path.resolve(base, config.receiptDirectory), { integrityKey });
  }

  const result = await runtime.evaluateDecisionRuleset({
    ruleset,
    binding,
    definitions,
    input,
    runId: config.runId,
    invocationId: config.invocationId,
    adapters,
    resolveCredential,
    ...(policies.length ? { projection: {
      // Select the policy authorized for this exact target; a mismatch is denied by the evaluator.
      resolve: ({ target }) => structuredClone(policies.find(policy => policy.provider === target.adapter
        && policy.model === target.model) ?? policies[0]),
    } } : {}),
    ...(receiptStore ? { receiptStore } : {}),
  });
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result.spec.status === 'error' || result.spec.status === 'cancelled' ? 1 : 0;
}
