import type { McpConnectionDefinition, SubagentDefinition, ToolDefinition } from '@flue/runtime';
export interface SpecialistOptions {
  /** Omit to inherit the app's model. */
  model?: string;
  /** Bind the actual Node tool definitions the delegate will mount. */
  tools?: readonly ToolDefinition[];
  /** Bind the remote connection the delegate will mount; list its required tools explicitly. */
  connection?: McpConnectionDefinition;
}
export declare function createSpecialist(definition: SubagentDefinition, options?: SpecialistOptions): SubagentDefinition;
