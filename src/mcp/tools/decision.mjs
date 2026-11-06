import { z } from 'zod';
import { integer, number } from '../../schema/zod-validation.mjs';
import { mcpError, mcpJson } from '../helpers.mjs';

const STATUS = z.enum(['success', 'abstained', 'denied', 'unavailable', 'error', 'cancelled']);
const ENVELOPE = z.looseObject({ schema: z.string() });
const LIVE_PLAN = z.looseObject({ mode: z.literal('live'), status: z.enum(['ready', 'skipped', 'denied']), reason: z.string(), executes: z.literal(false) });
const PATTERN_SUMMARY = z.looseObject({
  id: z.string(),
  version: z.string(),
  status: z.string(),
  primitive: z.string().optional(),
});
const PATTERN_LIST = z.looseObject({
  schema: z.literal('aiwg-decision-pattern-list/v1'),
  patterns: z.array(PATTERN_SUMMARY),
});
const PATTERN_SHOW = z.looseObject({
  schema: z.literal('aiwg-decision-pattern-show/v1'),
  pack: PATTERN_SUMMARY,
  inputSchema: z.unknown().optional(),
  outputSchema: z.unknown().optional(),
  livePlan: LIVE_PLAN,
});
const COMPACT_EVALUATION = z.looseObject({
  status: STATUS,
  reason: z.string(),
  attempts: number(),
  value: z.unknown().nullable().optional(),
});
const COMPACT_RESULT = z.looseObject({
  status: STATUS,
  rulesetStatus: z.string(),
  reason: z.string(),
  matchedRules: z.array(z.string()),
  evaluations: z.record(z.string(), COMPACT_EVALUATION),
  outcome: z.unknown().nullable().optional(),
});
const EVALUATE = z.looseObject({
  schema: z.literal('aiwg-decision-evaluate/v1'),
  status: STATUS,
  reason: z.string(),
  exitCode: number(),
  compact: COMPACT_RESULT.nullable().optional(),
  result: z.unknown().nullable().optional(),
});
const VALIDATION = z.looseObject({
  schema: z.literal('aiwg-decision-validation/v1'),
  target: z.enum(['request', 'definition', 'ruleset', 'binding']),
  valid: z.boolean(),
  summary: z.looseObject({
    kind: z.string().nullable().optional(),
    apiVersion: z.string().nullable().optional(),
    id: z.string().nullable().optional(),
    version: z.string().nullable().optional(),
  }),
  errors: z.array(z.string()),
});
const CAPABILITIES = z.looseObject({
  schema: z.literal('aiwg-decision-driver-capabilities/v1'),
  enabled: z.boolean(),
  offlineReady: z.boolean(),
  primitives: z.array(z.string()),
  backend: z.looseObject({ configured: z.boolean(), probed: z.boolean(), status: z.literal('not-probed') }),
});
const OFFLINE_RUN = z.looseObject({
  schema: z.literal('aiwg-decision-offline-run/v1'),
  status: STATUS,
  route: z.enum(['accept', 'review', 'deny']),
  reason: z.string(),
  evaluations: z.array(z.looseObject({
    alias: z.string(),
    primitive: z.string(),
    status: z.string(),
    reason: z.string(),
    attempts: number(),
    value: z.unknown().optional(),
  })),
  checks: z.array(z.unknown()),
});
const SYNTHETIC_SETUP = z.looseObject({
  schema: z.literal('aiwg-decision-synthetic-setup/v1'),
  pattern: z.looseObject({ id: z.string(), version: z.string() }),
  files: z.record(z.string(), z.unknown()),
});
const ASK = z.looseObject({
  schema: z.literal('aiwg-decision-ask/v1'),
  status: z.enum(['answered', 'fallback']),
  answer: z.union([z.string(), z.boolean(), number()]).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  probability: z.number().min(0).max(1).optional(),
  fallback: z.enum(['llm']).nullable(),
  reason: z.string(),
  model: z.string().nullable(),
  usage: z.object({
    inputTokens: integer().nonnegative().nullable(),
    outputTokens: integer().nonnegative().nullable(),
  }).nullable(),
  latencyMs: number().check(z.gte(0)).meta({ type: 'number', minimum: 0 }),
});

let driverPromise;

async function driver() {
  driverPromise ??= import('../../decision/driver.js');
  return driverPromise;
}

function options() {
  return { cwd: process.cwd(), env: process.env };
}

function registerJsonTool(server, name, config, handler, output = ENVELOPE) {
  server.registerTool(name, {
    outputSchema: { result: output },
    ...config,
  }, async (args) => {
    try {
      const result = await handler(args);
      return {
        ...mcpJson(result),
        structuredContent: { result },
      };
    } catch (error) {
      return mcpError(`${name}: ${error.message}`);
    }
  });
}

export function registerDecisionToolset(server) {
  registerJsonTool(server, 'decision-capabilities', {
    title: 'Decision runtime capabilities',
    description: 'Show offline readiness, primitives, experimental features and configured named request profiles.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => (await driver()).decisionCapabilities(options()), CAPABILITIES);

  registerJsonTool(server, 'decision-patterns-list', {
    title: 'List decision patterns',
    description: 'List governed decision pattern packs.',
    inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => (await driver()).listPatterns(), PATTERN_LIST);

  registerJsonTool(server, 'decision-pattern-show', {
    title: 'Show decision pattern',
    description: 'Show one pattern pack, schemas and disabled-by-default live plan.',
    inputSchema: { id: z.string().describe('Decision pattern id') },
    annotations: { readOnlyHint: true },
  }, async ({ id }) => (await driver()).showPattern(id), PATTERN_SHOW);

  registerJsonTool(server, 'decision-pattern-offline-run', {
    title: 'Run offline decision pattern fixture',
    description: 'Run a recorded offline fixture through the production decision runtime.',
    inputSchema: { id: z.string(), fixture_id: z.string().optional() },
    annotations: { readOnlyHint: true },
  }, async ({ id, fixture_id }) => (await driver()).runOfflinePattern(id, fixture_id), OFFLINE_RUN);

  registerJsonTool(server, 'decision-pattern-live-plan', {
    title: 'Plan live decision pattern',
    description: 'Report whether an explicitly opted-in synthetic live pattern would be ready; does not execute.',
    inputSchema: {
      id: z.string(),
      explicit_opt_in: z.boolean().default(false),
      credential_resolved: z.boolean().default(false),
      egress_approved: z.boolean().default(false),
    },
    annotations: { readOnlyHint: true },
  }, async ({ id, explicit_opt_in, credential_resolved, egress_approved }) => (await driver()).livePlan(id, {
    explicitOptIn: explicit_opt_in,
    credentialResolved: credential_resolved,
    egressApproved: egress_approved,
  }), LIVE_PLAN);

  registerJsonTool(server, 'decision-validate', {
    title: 'Validate decision artifact',
    description: 'Validate a request, definition, ruleset or binding without importing modules or resolving secrets.',
    inputSchema: {
      target: z.enum(['request', 'definition', 'ruleset', 'binding']),
      document: z.unknown().optional().describe('Inline decision document or dispatcher request object'),
    },
    annotations: { readOnlyHint: true },
  }, async ({ target, document }) => (await driver()).validateDecisionValue(target, document, 'mcp-inline'), VALIDATION);

  registerJsonTool(server, 'decision-evaluate-profile', {
    title: 'Evaluate named decision request profile',
    description: 'Evaluate a server-configured named request profile only when env and per-call opt-in are present.',
    inputSchema: {
      profile: z.string().describe('Profile name from AIWG_DECISION_MCP_REQUESTS'),
      opt_in: z.boolean().default(false).describe('Required per-call opt-in'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async ({ profile, opt_in }) => (await driver()).evaluateMcpProfile(profile, opt_in, options()), EVALUATE);

  registerJsonTool(server, 'decision-ask', {
    title: 'Ask bounded Jev decision',
    description: 'Ask a bounded yes/no, choice, or small ordinal decision. Falls back to the caller on missing setup or low confidence.',
    inputSchema: {
      question: z.string().min(1),
      yes_no: z.boolean().default(false),
      choices: z.array(z.string()).min(2).max(255).optional().describe('Choice ids, each optionally written as id=description so Jev knows what the option means'),
      scale: z.object({ low: integer(), high: integer() }).optional(),
      context: z.string().optional(),
      threshold: z.number().min(0).max(1).default(0.8),
      timeout_ms: integer().positive().default(15000),
      passes: integer().positive().optional(),
      escalation_passes: integer().positive().optional(),
      caller: z.string().optional().describe('Optional decision-point attribution tag, recorded in the decision ledger (#2946)'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
  }, async ({ question, yes_no, choices, scale, context, threshold, timeout_ms, passes, escalation_passes, caller }) => {
    const modeCount = (yes_no ? 1 : 0) + (choices ? 1 : 0) + (scale ? 1 : 0);
    if (modeCount !== 1) throw new Error('Select exactly one of yes_no, choices, or scale');
    const driverModule = await driver();
    const opts = options();
    const input = {
      question,
      mode: yes_no ? { kind: 'yes-no' } : choices ? { kind: 'choices', choices } : { kind: 'scale', low: scale.low, high: scale.high },
      ...(context === undefined ? {} : { context }),
      threshold,
      timeoutMs: timeout_ms,
      ...(passes === undefined ? {} : { passes }),
      ...(escalation_passes === undefined ? {} : { escalationPasses: escalation_passes }),
    };
    const sanitizedCaller = typeof caller === 'string' && driverModule.ATTRIBUTION_FIELD_PATTERN.test(caller) ? caller : null;
    const invocation = await driverModule.runDecisionOffloadCheckpoint(input, {
      transport: 'mcp',
      projectRoot: opts.cwd,
      env: opts.env,
      caller: sanitizedCaller ?? 'decision-mcp:ask',
      ledgerCaller: sanitizedCaller,
      category: sanitizedCaller ? undefined : 'unattributed',
      askRuntime: opts,
    });
    if (!invocation.result) throw invocation.error ?? new Error('Decision ask was skipped');
    return invocation.result;
  }, ASK);

  registerJsonTool(server, 'decision-setup-synthetic-classification', {
    title: 'Prepare synthetic classification artifacts',
    description: 'Return reviewable pinned synthetic classification artifacts and a dispatcher request.',
    inputSchema: {
      allowed_options: z.array(z.string()).min(1).optional(),
      text: z.string().optional(),
    },
    annotations: { readOnlyHint: true },
  }, async ({ allowed_options, text }) => (await driver()).syntheticClassificationSetup({ allowedOptions: allowed_options, text }, options()), SYNTHETIC_SETUP);
}
