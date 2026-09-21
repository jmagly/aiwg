#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { inventoryWorkflowExecution } from './workflow-execution-inventory.mjs';

function argumentsFor(argv) {
  const options = { input: '', boundary: 'read', config: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--input') options.input = argv[++index] ?? '';
    else if (item === '--execution-boundary') options.boundary = argv[++index] ?? '';
    else if (item === '--config') options.config = argv[++index] ?? '';
    else if (item === '--help' || item === '-h') {
      console.log('Usage: inventory-workflow-execution.mjs [--input snapshot.json] [--execution-boundary read|execute] [--config aiwg.config]');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${item}`);
  }
  return options;
}

try {
  const options = argumentsFor(process.argv.slice(2));
  const snapshot = JSON.parse(readFileSync(options.input || 0, 'utf8'));
  const defaultConfig = path.join(process.cwd(), '.aiwg', 'aiwg.config');
  const configPath = options.config || (existsSync(defaultConfig) ? defaultConfig : '');
  const policy = configPath ? JSON.parse(readFileSync(configPath, 'utf8'))?.security?.threatAssessment : undefined;
  console.log(JSON.stringify(inventoryWorkflowExecution(snapshot,
    { executionBoundary: options.boundary, policy }), null, 2));
} catch (error) {
  console.error(`workflow-execution-inventory: ${error.message}`);
  process.exitCode = 1;
}
