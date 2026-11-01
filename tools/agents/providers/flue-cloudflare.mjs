// Generate a portable remote connection resolved only inside Worker execution.
export function cloudflareTools({ fluePackage }) {
  return `${fluePackage ? "import { createAiwgConnection } from '@aiwg/flue/tools';" : `import { defineMcpConnection } from '@flue/runtime';
function createAiwgConnection({ url, token }: { url: string; token: string }) {
  return defineMcpConnection({ name: 'aiwg', url, auth: token, tools: ['discover', 'skill-show', 'artifact-write'] });
}`}
import { getCloudflareContext } from '@flue/runtime/cloudflare';

export function aiwgConnection() {
  const { env } = getCloudflareContext();
  const url = env.AIWG_MCP_URL;
  const token = env.AIWG_MCP_TOKEN;
  if (typeof url !== 'string' || !url || typeof token !== 'string' || !token) {
    throw new Error('AIWG remote tools require Worker bindings AIWG_MCP_URL and AIWG_MCP_TOKEN');
  }
  return createAiwgConnection({ url, token });
}
export { bindRemoteSpecialist } from '${fluePackage ? '@aiwg/flue/specialists' : './remote-specialist.js'}';
`;
}
