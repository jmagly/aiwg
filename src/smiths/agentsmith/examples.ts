/**
 * AgentSmith Usage Examples
 *
 * Demonstrates common agent generation patterns.
 */

import { AgentGenerator } from './generator.js';
import type { AgentOptions } from './types.js';

const generator = new AgentGenerator();

/**
 * Example 1: Simple Agent - Single-Purpose Task
 *
 * Generate a simple agent that performs a focused task with minimal tools.
 */
async function example1_SimpleAgent() {
  const options: AgentOptions = {
    name: 'api-documenter',
    description: 'Generates API documentation from source code',
    template: 'simple',
    platform: 'claude',
    projectPath: '/path/to/project',
    category: 'documentation',
    version: '1.0.0',
    guidance: `
      Expert in JSDoc, TypeScript, and OpenAPI specifications.
      Must parse function signatures and extract type information.
      Should generate markdown documentation with examples.
      Example: Parse async function fetchUser(id: string): Promise<User> to document REST endpoint.
      Output format: Markdown files with sections for endpoints, parameters, responses, examples.
    `,
  };

  const agent = await generator.generateAgent(options);
  await generator.deployAgent(agent);

  console.log(`Deployed ${agent.name} to ${agent.path}`);
  console.log(`Model: ${agent.model}, Tools: ${agent.tools.join(', ')}`);
}

/**
 * Example 2: Complex Agent - Analysis and Decision-Making
 *
 * Generate a complex agent that requires deeper analysis capabilities.
 */
async function example2_ComplexAgent() {
  const options: AgentOptions = {
    name: 'code-quality-analyzer',
    description: 'Analyzes code quality and suggests improvements',
    template: 'complex',
    platform: 'cursor',
    projectPath: '/path/to/project',
    category: 'quality',
    guidance: `
      Expert in code smells, SOLID principles, and design patterns.
      Knowledge of cyclomatic complexity and maintainability metrics.
      Must scan codebase for anti-patterns and code smells.
      Should prioritize issues by severity and impact.
      Example: Detect functions exceeding 50 lines or cyclomatic complexity > 10.
      Output format: JSON report with severity, file, line, issue type, and refactoring suggestion.
    `,
  };

  const agent = await generator.generateAgent(options);
  await generator.deployAgent(agent);

  console.log(`Deployed ${agent.name} to ${agent.path}`);
}

/**
 * Example 3: Orchestrator Agent - Multi-Agent Coordination
 *
 * Generate an orchestrator that delegates to other agents.
 */
async function example3_OrchestratorAgent() {
  const options: AgentOptions = {
    name: 'test-suite-orchestrator',
    description: 'Coordinates comprehensive test suite execution across multiple test types',
    template: 'orchestrator',
    platform: 'factory',
    projectPath: '/path/to/project',
    category: 'testing',
    version: '2.0.0',
    guidance: `
      Expert in test strategy, parallel execution, and result aggregation.
      Must delegate to unit-test-runner, integration-test-runner, e2e-test-runner agents.
      Should launch agents in parallel when tests are independent.
      Must synthesize coverage reports and failure summaries.
      Output format: Aggregated test results with pass/fail counts, coverage %, execution time, and failure details.
    `,
  };

  const agent = await generator.generateAgent(options);
  await generator.deployAgent(agent);

  console.log(`Deployed ${agent.name} to ${agent.path}`);
}

/**
 * Example 4: Validator Agent - Read-Only Quality Checks
 *
 * Generate a validator that performs quality checks without modification.
 */
async function example4_ValidatorAgent() {
  const options: AgentOptions = {
    name: 'security-validator',
    description: 'Validates code for security vulnerabilities',
    template: 'validator',
    platform: 'claude',
    projectPath: '/path/to/project',
    category: 'security',
    guidance: `
      Expert in OWASP Top 10, secure coding practices, and vulnerability patterns.
      Knowledge of SQL injection, XSS, CSRF, insecure deserialization.
      Must scan for hardcoded secrets, weak cryptography, and unsafe dependencies.
      Should flag severity levels: critical, high, medium, low.
      Example: Detect "SELECT * FROM users WHERE id=" + userId as SQL injection vulnerability.
      Output format: JSON report with CVE references, severity, file, line, description, remediation.
    `,
  };

  const agent = await generator.generateAgent(options);
  await generator.deployAgent(agent);

  console.log(`Deployed ${agent.name} to ${agent.path}`);
}

/**
 * Example 5: Custom Tools - Override Template Defaults
 *
 * Generate an agent with custom tool selection.
 */
async function example5_CustomTools() {
  const options: AgentOptions = {
    name: 'dependency-checker',
    description: 'Checks for outdated dependencies',
    template: 'simple',
    platform: 'claude',
    projectPath: '/path/to/project',
    tools: ['Read', 'Bash'], // Override default Read, Write
    category: 'maintenance',
    guidance: `
      Expert in npm, package.json, and semantic versioning.
      Must read package.json and check for outdated dependencies.
      Should use npm outdated command to identify updates.
      Output format: Table with package name, current version, latest version, wanted version.
    `,
  };

  const agent = await generator.generateAgent(options);
  await generator.deployAgent(agent);

  console.log(`Deployed ${agent.name} to ${agent.path}`);
}

/**
 * Example 6: Dry Run - Preview Without Deployment
 *
 * Generate agent content without writing to filesystem.
 */
async function example6_DryRun() {
  const options: AgentOptions = {
    name: 'preview-agent',
    description: 'Preview agent generation',
    platform: 'claude',
    projectPath: '/path/to/project',
    dryRun: true,
  };

  const agent = await generator.generateAgent(options);

  // Agent generated but not deployed
  console.log('Agent preview:');
  console.log(`Name: ${agent.name}`);
  console.log(`Path: ${agent.path}`);
  console.log(`Model: ${agent.model}`);
  console.log(`Tools: ${agent.tools.join(', ')}`);
  console.log('\nContent preview:');
  console.log(agent.content.slice(0, 500) + '...');
}

/**
 * Example 7: Multi-Platform Deployment
 *
 * Generate same agent for multiple platforms.
 */
async function example7_MultiPlatform() {
  const baseOptions = {
    name: 'logger-helper',
    description: 'Adds logging statements to functions',
    template: 'simple' as const,
    category: 'debugging',
    guidance: 'Must insert console.log or logger statements at function entry/exit points.',
  };

  const platforms = ['claude', 'cursor', 'codex'] as const;

  for (const platform of platforms) {
    const options: AgentOptions = {
      ...baseOptions,
      platform,
      projectPath: '/path/to/project',
    };

    const agent = await generator.generateAgent(options);
    await generator.deployAgent(agent);

    console.log(`Deployed to ${platform}: ${agent.path}`);
  }
}

/**
 * Example 8: List Available Templates
 *
 * Explore available templates and their configurations.
 */
function example8_ListTemplates() {
  const templates = generator.listTemplates();

  console.log('Available Templates:\n');

  for (const { name, config } of templates) {
    console.log(`Template: ${name}`);
    console.log(`  Description: ${config.description}`);
    console.log(`  Model: ${config.modelTier}`);
    console.log(`  Tools: ${config.tools.join(', ')}`);
    console.log(`  Max Tools: ${config.maxTools}`);
    console.log(`  Can Delegate: ${config.canDelegate}`);
    console.log(`  Read-Only: ${config.readOnly}`);
    console.log('');
  }
}

/**
 * Example 9: Model Tier Override
 *
 * Use a higher model tier for complex simple tasks.
 */
async function example9_ModelOverride() {
  const options: AgentOptions = {
    name: 'complex-formatter',
    description: 'Formats complex code with advanced patterns',
    template: 'simple', // Default: haiku
    model: 'opus', // Override: use opus for complex formatting
    platform: 'claude',
    projectPath: '/path/to/project',
    guidance: `
      Expert in AST manipulation and code formatting.
      Must preserve semantics while reformatting code.
      Should handle edge cases in complex expressions.
    `,
  };

  const agent = await generator.generateAgent(options);
  await generator.deployAgent(agent);

  console.log(`Deployed with model override: ${agent.model}`);
}

/**
 * Example 10: Devin Desktop Platform - Aggregated AGENTS.md
 *
 * Generate agent for Devin Desktop's aggregated format.
 */
async function example10_WindsurfFormat() {
  const options: AgentOptions = {
    name: 'refactor-assistant',
    description: 'Assists with code refactoring tasks',
    template: 'complex',
    platform: 'devin',
    projectPath: '/path/to/project',
    category: 'refactoring',
    guidance: `
      Expert in Extract Method, Extract Class, and Inline refactorings.
      Knowledge of SOLID principles and design patterns.
      Must maintain test coverage during refactoring.
    `,
  };

  const agent = await generator.generateAgent(options);
  await generator.deployAgent(agent);

  console.log('Devin Desktop agent deployed:');
  console.log(`Path: ${agent.path}`);
  console.log('Note: Devin Desktop uses plain markdown without YAML frontmatter');
}

// Export examples for use in CLI or documentation
export const examples = {
  example1_SimpleAgent,
  example2_ComplexAgent,
  example3_OrchestratorAgent,
  example4_ValidatorAgent,
  example5_CustomTools,
  example6_DryRun,
  example7_MultiPlatform,
  example8_ListTemplates,
  example9_ModelOverride,
  example10_WindsurfFormat,
};

// Run all examples (commented out by default)
// async function runAllExamples() {
//   console.log('=== AgentSmith Examples ===\n');
//
//   console.log('Example 1: Simple Agent');
//   await example1_SimpleAgent();
//
//   console.log('\nExample 2: Complex Agent');
//   await example2_ComplexAgent();
//
//   console.log('\nExample 3: Orchestrator Agent');
//   await example3_OrchestratorAgent();
//
//   console.log('\nExample 4: Validator Agent');
//   await example4_ValidatorAgent();
//
//   console.log('\nExample 5: Custom Tools');
//   await example5_CustomTools();
//
//   console.log('\nExample 6: Dry Run');
//   await example6_DryRun();
//
//   console.log('\nExample 7: Multi-Platform');
//   await example7_MultiPlatform();
//
//   console.log('\nExample 8: List Templates');
//   example8_ListTemplates();
//
//   console.log('\nExample 9: Model Override');
//   await example9_ModelOverride();
//
//   console.log('\nExample 10: Devin Desktop Format');
//   await example10_WindsurfFormat();
// }
