// Collect workerClaims candidates only after schema and on-disk artifact validation.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { importImpl } from '../../_resolve-impl.mjs';
import { boundedPrivateRead, withWorkerPath } from './worker-inputs.mjs';
import { parseStrictWorkerJson } from './strict-worker-json.mjs';

const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const escapePointer = key => key.replace(/~/g, '~0').replace(/\//g, '~1');

// The shared validator renders Ajv instancePath; required/additional fields
// identify the child in params, rendered in its existing diagnostic text.
function schemaDiagnostic(error) {
  const match = /^(\/\S*) (must (?:have required|NOT have additional) propert(?:y|ies) '([^']+)'.*)$/.exec(error);
  return match ? `${match[1] === '/' ? '' : match[1]}/${escapePointer(match[3])} ${match[2]}` : error;
}

// Names only: bounded, nonrecursive discovery never reads or accepts worker candidates.
async function rootCandidates(workdir, finalPath) {
  const candidates = [];
  let truncated = false, scanError = null;
  try {
    await withWorkerPath(workdir, async target => {
      const root = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const entries = await opendir(`/proc/self/fd/${root.fd}`);
        let scanned = 0;
        for await (const entry of entries) {
          if (++scanned > 256 || candidates.length === 32) { truncated = true; break; }
          const path = join(workdir, entry.name);
          if (entry.isFile() && path !== finalPath && /\.(json|jsonl|txt|md|ya?ml|csv)$/i.test(entry.name)) {
            candidates.push({ path, location: 'worker-tree-root', candidate: true, verified: false });
          }
        }
      } finally { await root.close(); }
    });
  } catch (error) { scanError = error.message; }
  return { candidates: candidates.sort((a, b) => a.path.localeCompare(b.path)), truncated, scanError };
}

async function artifactErrors(claims, workdir) {
  const errors = [];
  for (const [index, artifact] of claims.artifacts.entries()) {
    const pointer = `/artifacts/${index}`;
    const filename = resolve(workdir, artifact.path);
    const within = relative(workdir, filename);
    if (!within || within === '..' || within.startsWith('../') || isAbsolute(within) || artifact.path.includes('\0')) {
      errors.push(`${pointer}/path Artifact must name a file beneath the worker tree`);
      continue;
    }
    try {
      // Pin every ancestor and refuse symlinks, hardlinks and special files.
      const actual = await withWorkerPath(filename, async target => {
        const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const before = await handle.stat({ bigint: true });
          if (!before.isFile() || before.nlink !== 1n) throw new Error('Artifact must be an unaliased regular file');
          const hash = createHash('sha256');
          for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
          const after = await handle.stat({ bigint: true });
          if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
            throw new Error('Artifact changed while hashing');
          }
          return `sha256:${hash.digest('hex')}`;
        } finally { await handle.close(); }
      });
      if (actual !== artifact.digest) errors.push(`${pointer}/digest Artifact digest mismatch: expected ${artifact.digest}, actual ${actual}`);
    } catch (error) {
      errors.push(`${pointer}/path Cannot hash artifact in worker tree: ${error.message}`);
    }
  }
  return errors;
}

export async function collectWorkerFinal({ path, workdir, driver, output, invocationId, result, inspect, handle, publish, outputFraming }) {
  const { validateWorkerPayload, WORKER_MAX_JSON_BYTES, WORKER_MAX_NESTING_DEPTH, assertWorkerTerminal } =
    await importImpl(import.meta.url, 'mission-protocol/index.js');
  const scan = bytes => parseStrictWorkerJson(
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), WORKER_MAX_NESTING_DEPTH);
  let finalBytes, extracted = false, parsedClaims, parseError, failureKind = 'invalid-file';
  const evidence = () => ({ invocationId, path, digest: finalBytes ? digest(finalBytes) : null,
    source: extracted ? 'adapter-extraction' : 'worker-output', candidate: true, verified: false });
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > WORKER_MAX_JSON_BYTES) throw new Error('Invalid final output');
    await inspect(path, 'file');
    let claims;
    if (stat.size === 0 && driver.extractFinal) {
      failureKind = output.length ? 'wrong-shape' : 'missing-file';
      claims = driver.extractFinal(output.toString('utf8'));
      if (claims === null || claims === undefined || claims.success === false) throw new Error('Missing or unsuccessful final extraction');
      const bytes = JSON.stringify({ invocationId, source: 'adapter-extraction', candidate: true, verified: false, result: claims });
      if (Buffer.byteLength(bytes) > WORKER_MAX_JSON_BYTES) throw new Error('Final exceeds bound');
      await handle.writeFile(bytes); extracted = true;
    }
    finalBytes = await boundedPrivateRead(path, WORKER_MAX_JSON_BYTES, inspect, true);
    if (!finalBytes.length) { failureKind = 'missing-file'; throw new Error('Missing final output'); }
    failureKind = 'wrong-shape';
    if (extracted) {
      if (driver.parseWorkerFinal) {
        try {
          // The adapter owns framing (including text preambles) and strict
          // decoding. Invoke it once with the launcher's actual exit status.
          parsedClaims = await driver.parseWorkerFinal(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(output), {
            format: outputFraming === 'jsonl' ? 'jsonl' : 'json', observation: { transport: 'shell',
              status: result.exitCode === 0 && !result.errorCode && !result.timedOut ? 'completed' : 'failed',
              termination: result.termination, exitCode: result.exitCode },
            // Content validation precedes the independent terminal assertion
            // below, so degraded termination cannot hide artifact mismatches.
            assertTerminal: () => {},
          });
          claims = parsedClaims;
        } catch (error) {
          parseError = error;
          // A decoded claims document must satisfy the schema. A non-claims
          // text candidate retains exit-only evidence and a rejected strict
          // parse; it can never authorize health completion or recovery.
          if (/^Invalid workerClaims:|Duplicate worker JSON|nesting depth|byte bound/.test(error.message)) throw error;
          claims = undefined;
        }
      } else {
        // Without a strict adapter hook, scan original bytes before trusting
        // synchronous extraction, which may have discarded duplicate keys.
        if (outputFraming === 'jsonl') {
          const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(output);
          for (const line of text.split('\n')) if (line.trim()) scan(Buffer.from(line));
        } else scan(output);
      }
    } else {
      const decoded = scan(finalBytes);
      claims = driver.extractFinal ? driver.extractFinal(finalBytes.toString('utf8')) : decoded;
    }
    if (!parseError) {
      const validation = validateWorkerPayload('workerClaims', claims);
      const errors = validation.errors.map(schemaDiagnostic);
      if (validation.valid) {
        failureKind = 'invalid-artifact';
        errors.push(...await artifactErrors(claims, workdir));
      }
      if (errors.length) {
        result.finalOutputErrors = errors;
        throw new Error('Invalid workerClaims');
      }
    }
  } catch (error) {
    result.errorCode ??= 'FINAL_OUTPUT_INVALID';
    const found = await rootCandidates(workdir, path);
    if (error.code === 'ENOENT') failureKind = 'missing-file';
    if (failureKind === 'missing-file' && found.candidates.some(candidate => basename(candidate.path) === basename(path))) {
      failureKind = 'wrong-location';
    }
    result.finalOutputFailure = { kind: failureKind, expectedPath: path,
      message: `${failureKind}: final output at ${JSON.stringify(path)}: ${error.message}`,
      ...found };
    // Adapter decoding uses assertValidWorkerPayload's existing rendered
    // diagnostics; retain its pointers when validation fails inside it.
    const schemaErrors = /^Invalid workerClaims: (.*)\.$/.exec(error.message)?.[1];
    result.finalOutputErrors ??= schemaErrors ? schemaErrors.split('; ').map(schemaDiagnostic) : [`/ ${error.message}`];
    // No candidate document exists for a missing/empty final; retain diagnostics in exit.json.
    if (!finalBytes?.length) throw error;
    await publish('final-evidence.json', { ...evidence(), terminalSuccess: false,
      errorCode: 'FINAL_OUTPUT_INVALID', errors: result.finalOutputErrors });
    throw error;
  }
  await publish('final-evidence.json', { ...evidence(),
    terminalSuccess: result.exitCode === 0 && !result.timedOut && !result.errorCode });
  // Reuse the adapter's content result without a second hook invocation.
  // Keep the existing health path's terminal assertion independent of content.
  const parseFinal = async (bytes, options) => {
    if (!extracted) return driver.parseWorkerFinal(bytes, options);
    if (parseError) throw parseError;
    assertWorkerTerminal(options.observation);
    return parsedClaims;
  };
  return { finalBytes, extracted, parseFinal };
}
