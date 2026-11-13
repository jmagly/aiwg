// Supply synthetic installed qualification roots to the offline CLI subprocess.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function loadWorkerInputs(options) {
  if (process.env.AIWG_CONDUCTOR_PROBE_INPUTS) {
    return (await import(pathToFileURL(process.env.AIWG_CONDUCTOR_PROBE_INPUTS).href)).loadWorkerInputs(options);
  }
  const roots = JSON.parse(readFileSync(new URL('./qualified-roots.json', import.meta.url), 'utf8'));
  return { drivers: { fixture: { qualification: { installation: { workerWritableRoots: roots } } } } };
}

const self = import.meta.url;
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.endsWith('/tools/ralph-external/lib/worker-invocation-processes.mjs')) {
      // The offline CLI gets a complete synthetic inventory, including any
      // real fixture descendants linked under clients/proc by the test.
      const source = String(result.source);
      const binding = "procRoot = '/proc'";
      if (!source.includes(binding)) throw new Error('Synthetic proc inventory binding changed');
      return { ...result, source: source.replace(binding,
        `procRoot = ${JSON.stringify(fileURLToPath(new URL('./proc', self)))}`) };
    }
    return result;
  },
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (resolved.url.startsWith('file:') && fileURLToPath(resolved.url).endsWith('/dist/src/cli/handlers/models.js')) {
      return { url: self, shortCircuit: true };
    }
    return resolved;
  },
});
