// Copy the shared adapter runtime closure into synthetic installed packages.
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export async function copyWorkerAdapterRuntime(base, packageRoot) {
  for (const name of ['provider-adapter.mjs', 'worker-health.mjs', 'strict-worker-json.mjs', 'session-attempt.mjs']) {
    const destination = join(packageRoot, 'lib', name);
    await copyFile(resolve('tools/ralph-external/lib', name), destination);
    await chmod(destination, 0o644);
  }
  await mkdir(join(base, 'src/models'), { recursive: true, mode: 0o755 });
  await copyFile(resolve('src/models/qualification-digest.mjs'), join(base, 'src/models/qualification-digest.mjs'));
}

/** Install a provider module with the shared strict-claims runtime in a synthetic package. */
export async function installWorkerAdapterPackage(base, approved, bytes) {
  const packageRoot = join(base, 'pkg');
  const writable = join(base, 'worker-writable');
  await mkdir(join(packageRoot, 'lib'), { recursive: true, mode: 0o755 });
  await mkdir(writable);
  await chmod(base, 0o755);
  await writeFile(join(base, 'package.json'), JSON.stringify({ name: 'aiwg', type: 'module' }));
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: approved.packageName,
    version: approved.packageVersion, type: 'module' }), { mode: 0o644 });
  await writeFile(join(packageRoot, approved.modulePath), bytes, { mode: 0o644 });
  await copyWorkerAdapterRuntime(base, packageRoot);
  await copyFile(resolve('tools/_resolve-impl.mjs'), join(base, '_resolve-impl.mjs'));
  for (const [module, target] of [['models/worker-installation.mjs', 'src/models/worker-installation.mjs'],
    ['mission-protocol/index.js', 'src/mission-protocol/index.ts']]) {
    await mkdir(join(base, 'src', module, '..'), { recursive: true });
    await writeFile(join(base, 'src', module), `export * from ${JSON.stringify(resolve(target))};\n`);
  }
  return { packageRoot, writable };
}
