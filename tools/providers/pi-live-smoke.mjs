#!/usr/bin/env node
/**
 * Opt-in Pi/OpenRouter qualification.
 *
 * Normal CI only exercises --check and a local stub. The live path downloads a
 * pinned Pi package through npx, uses isolated agent/session roots, summarizes
 * output without persisting model content, and requires an explicit gate.
 */
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PI_SUPPORTED_VERSIONS } from '../ralph-external/lib/pi-adapter.mjs';

export const PI_PACKAGE = '@earendil-works/pi-coding-agent';
/** The single qualified Pi version; the adapter's accepted range is the source of truth (#2550). */
export const PI_VERSION = PI_SUPPORTED_VERSIONS.at(-1);
export const LIVE_GATE = 'AIWG_PI_LIVE_SMOKE';

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) throw new Error(`unexpected positional argument: ${value}`);
    const key = value.slice(2);
    const next = argv[index + 1];
    values[key] = !next || next.startsWith('--') ? true : next;
    if (values[key] !== true) index += 1;
  }
  return values;
}

function invocation(piBin) {
  if (piBin) return { command: String(piBin), prefix: [] };
  return {
    command: 'npx',
    prefix: ['--yes', '--package', `${PI_PACKAGE}@${PI_VERSION}`, 'pi'],
  };
}

function runPi(runtime, args, env, input) {
  return spawnSync(runtime.command, [...runtime.prefix, ...args], {
    encoding: 'utf8',
    env,
    input,
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    killSignal: 'SIGKILL',
  });
}

function parseJsonl(raw, label) {
  const lines = raw.split('\n').filter(Boolean);
  if (!lines.length) throw new Error(`${label} emitted no JSONL records`);
  return lines.map((line, index) => {
    if (line.includes('\u2028') || line.includes('\u2029')) {
      throw new Error(`${label} record ${index + 1} contains a forbidden record delimiter`);
    }
    try {
      return JSON.parse(line.endsWith('\r') ? line.slice(0, -1) : line);
    } catch {
      throw new Error(`${label} record ${index + 1} is not JSON`);
    }
  });
}

function assertSuccess(result, label) {
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit ${result.status}; stderr bytes=${Buffer.byteLength(result.stderr)}`);
  }
}

export function checkContract() {
  return {
    live: false,
    normalCiCostUsd: 0,
    requiredGate: `${LIVE_GATE}=1`,
    credential: 'OPENROUTER_API_KEY',
    package: PI_PACKAGE,
    version: PI_VERSION,
    installation: 'ephemeral npx package',
    isolatedEnvironment: [
      'PI_CODING_AGENT_DIR',
      'PI_CODING_AGENT_SESSION_DIR',
    ],
    trustPolicy: '--no-approve',
    modes: ['list-models', 'json', 'rpc'],
  };
}

export function qualify(options, baseEnv = process.env) {
  if (baseEnv[LIVE_GATE] !== '1') {
    throw new Error(`Live Pi smoke is disabled; set ${LIVE_GATE}=1 explicitly`);
  }
  if (!baseEnv.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is required and must be injected ephemerally');
  }
  if (!options.model) throw new Error('--model is required for the bounded inference check');

  const scratch = mkdtempSync(join(tmpdir(), 'aiwg-pi-live-smoke-'));
  const agentDir = join(scratch, 'agent');
  const sessionDir = join(scratch, 'sessions');
  const runtime = invocation(options['pi-bin']);
  const env = {
    PATH: baseEnv.PATH ?? '',
    HOME: scratch,
    OPENROUTER_API_KEY: baseEnv.OPENROUTER_API_KEY,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    NO_COLOR: '1',
  };

  try {
    const version = runPi(runtime, ['--version'], env);
    assertSuccess(version, 'Pi version');
    if (version.stdout.trim() !== PI_VERSION && options['allow-version-drift'] !== true) {
      throw new Error(`Pi version drift: expected ${PI_VERSION}, received ${version.stdout.trim()}`);
    }

    const models = runPi(runtime, ['--no-approve', '--provider', 'openrouter', '--list-models'], env);
    assertSuccess(models, 'Pi OpenRouter model discovery');
    if (!models.stdout.split(/\r?\n/).some(line => line.includes(String(options.model)))) {
      throw new Error(`requested model was not discovered: ${options.model}`);
    }

    const rpc = runPi(
      runtime,
      ['--no-approve', '--no-session', '--mode', 'rpc'],
      env,
      [
        JSON.stringify({ id: 'state-1', type: 'get_state' }),
        JSON.stringify({ id: 'abort-1', type: 'abort' }),
        '',
      ].join('\n'),
    );
    assertSuccess(rpc, 'Pi RPC control check');
    const rpcRecords = parseJsonl(rpc.stdout, 'Pi RPC');
    const responses = new Map(rpcRecords.filter(record => record.id).map(record => [record.id, record]));
    if (!responses.get('state-1')?.success || !responses.get('abort-1')?.success) {
      throw new Error('Pi RPC control responses were incomplete or unsuccessful');
    }

    const prompt = options.prompt ?? 'Reply with exactly PI_OPENROUTER_OK';
    const json = runPi(
      runtime,
      [
        '--no-approve',
        '--provider', 'openrouter',
        '--model', String(options.model),
        '--mode', 'json',
        '-p', String(prompt),
      ],
      env,
    );
    assertSuccess(json, 'Pi JSON inference');
    const events = parseJsonl(json.stdout, 'Pi JSON');
    const eventTypes = [...new Set(events.map(event => event.type).filter(Boolean))];
    if (!eventTypes.includes('agent_settled')) {
      throw new Error('Pi JSON stream ended without agent_settled');
    }

    return {
      schema: 'aiwg.pi-live-smoke.v1',
      status: 'pass',
      package: PI_PACKAGE,
      expectedVersion: PI_VERSION,
      observedVersion: version.stdout.trim(),
      model: String(options.model),
      trustPolicy: '--no-approve',
      isolation: {
        temporaryHome: true,
        agentDir: true,
        sessionDir: true,
        globalInstallRequired: false,
      },
      discovery: {
        provider: 'openrouter',
        requestedModelPresent: true,
      },
      rpc: {
        strictJsonl: true,
        records: rpcRecords.length,
        commands: ['get_state', 'abort'],
      },
      inference: {
        strictJsonl: true,
        eventCount: events.length,
        eventTypes,
        settled: true,
      },
      secretHandling: {
        credentialPersisted: false,
        rawOutputPersisted: false,
      },
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.check === true) {
    process.stdout.write(`${JSON.stringify(checkContract(), null, 2)}\n`);
    return;
  }
  const evidence = qualify(options);
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (options.output) writeFileSync(String(options.output), serialized, { flag: 'wx', mode: 0o600 });
  process.stdout.write(serialized);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
