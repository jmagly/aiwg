import type { McpAuth, McpConnectionDefinition } from '@flue/runtime';
export type AiwgConnectionOptions = Omit<McpConnectionDefinition, 'name' | 'auth'> & { token: McpAuth };
export declare function createAiwgConnection(options: AiwgConnectionOptions): McpConnectionDefinition;
