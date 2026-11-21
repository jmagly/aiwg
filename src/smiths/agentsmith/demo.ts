/**
 * AgentSmith Demo
 *
 * Quick demonstration of AgentSmith capabilities.
 * Run with: npx tsx src/smiths/agentsmith/demo.ts
 */

import { AgentGenerator } from './generator.js';
import * as os from 'os';
import * as path from 'path';

async function demo() {
  console.log('=== AgentSmith Demo ===\n');

  const generator = new AgentGenerator();
  const tempDir = os.tmpdir();

  // Demo 1: List available templates
  console.log('1. Available Templates:\n');
  const templates = generator.listTemplates();
  for (const { name, config } of templates) {
    console.log(`   ${name.padEnd(12)} - ${config.description}`);
    console.log(`   ${''.padEnd(16)} Model: ${config.modelTier}, Tools: ${config.tools.join(', ')}`);
  }

  // Demo 2: Generate a simple agent
  console.log('\n2. Generating Simple Agent:\n');
  const simpleAgent = await generator.generateAgent({
    name: 'demo-simple-agent',
    description: 'A simple demonstration agent for basic tasks',
    template: 'simple',
    platform: 'claude',
    projectPath: tempDir,
    dryRun: true, // Don't actually deploy
  });

  console.log(`   Name: ${simpleAgent.name}`);
  console.log(`   Platform: ${simpleAgent.platform}`);
  console.log(`   Model: ${simpleAgent.model}`);
  console.log(`   Tools: ${simpleAgent.tools.join(', ')}`);
  console.log(`   Path: ${simpleAgent.path}`);
  console.log('\n   Content Preview (first 300 chars):');
  console.log('   ' + simpleAgent.content.slice(0, 300).replace(/\n/g, '\n   ') + '...\n');

  // Demo 3: Generate a validator with guidance
  console.log('3. Generating Validator with Guidance:\n');
  const validatorAgent = await generator.generateAgent({
    name: 'demo-security-validator',
    description: 'Validates code for security vulnerabilities',
    template: 'validator',
    platform: 'claude',
    projectPath: tempDir,
    category: 'security',
    version: '1.0.0',
    guidance: `
      Expert in OWASP Top 10 and secure coding practices.
      Knowledge of SQL injection, XSS, and CSRF vulnerabilities.
      Must scan for hardcoded secrets and weak cryptography.
      Example: Detect "SELECT * WHERE id=" + userId as SQL injection risk.
      Output format: JSON report with severity, file, line, description.
    `,
    dryRun: true,
  });

  console.log(`   Name: ${validatorAgent.name}`);
  console.log(`   Platform: ${validatorAgent.platform}`);
  console.log(`   Model: ${validatorAgent.model}`);
  console.log(`   Tools: ${validatorAgent.tools.join(', ')}`);
  console.log(`   Category: ${validatorAgent.category}`);
  console.log(`   Version: ${validatorAgent.version}`);
  console.log('\n   Expertise section:');
  const expertiseMatch = validatorAgent.content.match(/## Expertise\n\n([\s\S]*?)\n\n##/);
  if (expertiseMatch) {
    console.log('   ' + expertiseMatch[1].replace(/\n/g, '\n   '));
  }

  // Demo 4: Generate orchestrator
  console.log('\n4. Generating Orchestrator Agent:\n');
  const orchestratorAgent = await generator.generateAgent({
    name: 'demo-test-orchestrator',
    description: 'Coordinates multiple test agents',
    template: 'orchestrator',
    platform: 'claude',
    projectPath: tempDir,
    guidance: `
      Expert in test strategy and parallel execution.
      Must delegate to unit-test-runner, integration-test-runner, e2e-test-runner.
      Should synthesize coverage reports and failure summaries.
      Output format: Aggregated results with pass/fail counts and coverage %.
    `,
    dryRun: true,
  });

  console.log(`   Name: ${orchestratorAgent.name}`);
  console.log(`   Model: ${orchestratorAgent.model}`);
  console.log(`   Tools: ${orchestratorAgent.tools.join(', ')}`);
  console.log('\n   Workflow steps:');
  const workflowMatch = orchestratorAgent.content.match(/## Workflow\n\n([\s\S]*?)\n\n##/);
  if (workflowMatch) {
    console.log('   ' + workflowMatch[1].replace(/\n/g, '\n   '));
  }

  // Demo 5: Platform transformations
  console.log('\n5. Platform Transformation Examples:\n');

  const platforms = ['claude', 'cursor', 'codex', 'devin'] as const;

  for (const platform of platforms) {
    const agent = await generator.generateAgent({
      name: 'demo-platform-test',
      description: 'Platform transformation test',
      platform,
      projectPath: tempDir,
      dryRun: true,
    });

    console.log(`   ${platform.padEnd(10)} -> ${path.extname(agent.path)}`);
    console.log(`   ${''.padEnd(16)}Format: ${agent.content.startsWith('{') ? 'JSON' : agent.content.startsWith('---') ? 'YAML+MD' : 'Plain MD'}`);
  }

  console.log('\n=== Demo Complete ===\n');
  console.log('AgentSmith is ready for use!');
  console.log('\nNext steps:');
  console.log('  1. Import AgentGenerator from "smiths/agentsmith"');
  console.log('  2. Call generateAgent() with your options');
  console.log('  3. Deploy with deployAgent() or use dryRun for preview');
  console.log('\nSee README.md and examples.ts for more details.\n');
}

// Run demo
demo().catch(console.error);
