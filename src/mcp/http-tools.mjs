// Project-bound, strict schema projection and tool authorization for remote MCP.
import { z } from 'zod';
import { toolContext } from './tool-context.mjs';

const scopeFields = new Set([
  'project_dir', 'projectDir', 'project_root', 'projectRoot', 'project',
  'cwd', 'root', 'workdir', 'working_directory', 'scope',
  'artifact_root', 'artifacts_path', 'aiwg_dir',
]);

function containsCliOption(value) {
  if (typeof value === 'string') return value.startsWith('--');
  if (value && typeof value === 'object') return Object.values(value).some(containsCliOption);
  return false;
}

export function remoteToolPolicy(projectDir, tools) {
  const selected = tools === undefined ? undefined : new Set(tools);
  const exposed = new Set();
  const children = new Set();
  let active = 0;
  return {
    configureTool(name, config, handler) {
      const allowed = name === 'discover' || name.endsWith('-show') || name === 'artifact-write';
      if (!allowed || (selected && !selected.has(name))) return undefined;
      exposed.add(name);
      const shape = config.inputSchema?.shape ?? {};
      const inputSchema = z.strictObject(Object.fromEntries(
        Object.entries(shape).filter(([key]) => !scopeFields.has(key)),
      ));
      return { config: { ...config, inputSchema }, handler: async (args, extra) => {
        extra.signal.throwIfAborted();
        // CLI-backed cards must not reinterpret data values as scope/source flags.
        // artifact-write uses openArtifact directly and spawns no CLI.
        if (name !== 'artifact-write' && containsCliOption(args)) {
          throw new Error('Tool arguments must not contain CLI options');
        }
        active++;
        try { return await toolContext.run({ projectDir, signal: extra.signal, children }, () => handler(args, extra)); }
        finally { active--; }
      } };
    },
    busy: () => active > 0 || children.size > 0,
    drain: () => Promise.allSettled([...children]),
    validate() {
      if (selected && [...selected].some(name => !exposed.has(name))) {
        throw new Error('--tools must name only available discover, *-show or artifact-write tools; enable required --toolsets explicitly');
      }
    },
  };
}
