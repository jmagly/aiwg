// Define a project-bound remote connection without platform-specific imports.
import { defineMcpConnection } from '@flue/runtime';
export function createAiwgConnection({ url, token, tools = ['discover', 'skill-show', 'artifact-write'], ...options }) {
  if (!token) throw new Error('createAiwgConnection requires a caller-supplied token');
  return defineMcpConnection({ ...options, name: 'aiwg', url, auth: token, tools });
}
