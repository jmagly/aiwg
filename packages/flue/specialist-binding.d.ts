import type { McpConnectionDefinition, SubagentDefinition, ToolDefinition } from '@flue/runtime';
export interface SpecialistOptions {
  /** Omit to inherit the app's model. */
  model?: string;
  /** Bind the actual Node tool definitions the delegate will mount. */
  tools?: readonly ToolDefinition[];
  /** Prepare remote tools in root lifecycle hooks; list required tools explicitly. Call the factory inside the root render. */
  connection?: McpConnectionDefinition;
}
export declare function createSpecialist(definition: SubagentDefinition, options?: SpecialistOptions): SubagentDefinition;
