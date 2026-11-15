// Publish a validated zero-launch stop through the existing signed delivery route.
import { createHash } from 'node:crypto';
import { lstatSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importImpl } from '../../_resolve-impl.mjs';
import { prepareDeliveryRecord } from './worker-delivery-record.mjs';

function destinationFor(deliverablePath, writableRoots) {
  const destination = join(realpathSync(dirname(deliverablePath)), basename(deliverablePath));
  for (const tree of writableRoots) {
    const rel = relative(realpathSync(tree), destination);
    if (rel === '' || rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)) {
      throw new Error('--deliverable must be outside worker-writable roots');
    }
  }
  let existing;
  try { existing = lstatSync(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing && (!existing.isFile() || existing.nlink !== 1)) throw new Error('--deliverable must be a regular non-linked file or an absent path');
  return destination;
}

export async function deliverTypedStop(input, { prepareRecord = prepareDeliveryRecord } = {}) {
  const { projectDir = process.cwd(), ...request } = input;
  const { typedStopDeliverySchema, invalidTypedStop } = await importImpl(import.meta.url, 'mcp/tools/worker-verify-deliver-schema.mjs');
  const parsed = typedStopDeliverySchema.safeParse(request);
  if (!parsed.success) throw invalidTypedStop(parsed.error.message);
  const { deliverablePath, typedStop } = parsed.data;
  const { loadWorkerInputs } = await importImpl(import.meta.url, 'cli/handlers/models.js');
  const inputs = await loadWorkerInputs({ cwd: projectDir, args: [], rawArgs: [],
    frameworkRoot: fileURLToPath(new URL('../../../', import.meta.url)) });
  const writableRoots = Object.values(inputs.drivers).flatMap(driver => driver.qualification.installation?.workerWritableRoots ?? []);
  const destination = destinationFor(deliverablePath, writableRoots);
  const bytes = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(typedStop).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))) + '\n');
  const artifactDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const complete = await prepareRecord(projectDir, { kind: 'typed-stop', verifierId: 'typed-stop@1', artifactDigest, deliverablePath: destination });
  // Recheck after signing, before the same-directory atomic rename.
  destinationFor(destination, writableRoots);
  const staging = mkdtempSync(join(dirname(destination), '.aiwg-deliver-'));
  try {
    const staged = join(staging, 'typed-stop');
    writeFileSync(staged, bytes, { flag: 'wx', mode: 0o600 });
    renameSync(staged, destination);
  } finally { rmSync(staging, { recursive: true, force: true }); }
  return { status: 'accepted', kind: 'typed-stop', verifierId: 'typed-stop@1', artifactDigest, deliveryRecord: await complete() };
}
