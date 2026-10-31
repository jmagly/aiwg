// Bind a delegate's required capabilities explicitly before mounting it.
import { defineSubagent, useTool, useMcpConnection } from '@flue/runtime';
const required = ['aiwg_discover', 'aiwg_show', 'aiwg_artifact_write'];
const remote = ['discover', 'skill-show', 'artifact-write'];
export function createSpecialist(definition, { model, tools = [], connection } = {}) {
  const mounted = new Map(tools.map(tool => [tool.name, tool]));
  for (const [index, name] of required.entries()) {
    if (mounted.has(name)) continue;
    const remoteName = `mcp__aiwg__${remote[index]}`;
    if (connection?.name === 'aiwg' && connection.tools?.includes(remote[index]) && !connection.optional) continue;
    throw new Error(`Specialist ${definition.name} requires missing tool ${name} from @aiwg/flue/tools/node or ${remoteName} from @aiwg/flue/tools`);
  }
  return defineSubagent({ ...definition, ...(model === undefined ? {} : { model }), agent() {
    for (const name of required) if (mounted.has(name)) useTool(mounted.get(name));
    if (connection) useMcpConnection(connection);
    return definition.agent();
  } });
}
