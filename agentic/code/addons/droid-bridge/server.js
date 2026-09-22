#!/usr/bin/env node

/**
 * Droid MCP Server
 * Bridges Claude Code to Factory Droid via Model Context Protocol
 *
 * Features:
 * - Session tracking with unique IDs
 * - Full request/response logging
 * - Automatic archival support
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, existsSync, symlinkSync, unlinkSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';

// Base paths for logging
const PROJECT_ROOT = process.env.DROID_PROJECT_ROOT || process.cwd();
const AIWG_DROID_DIR = join(PROJECT_ROOT, '.aiwg', 'droid');
const SESSIONS_DIR = join(AIWG_DROID_DIR, 'sessions');
const CURRENT_LINK = join(AIWG_DROID_DIR, 'current');

// Ensure directories exist
function ensureDirectories() {
  const dirs = [
    AIWG_DROID_DIR,
    SESSIONS_DIR,
    join(AIWG_DROID_DIR, 'archive')
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Generate a unique session ID
 */
function generateSessionId() {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').split('.')[0];
  const random = randomBytes(4).toString('hex');
  return `${timestamp}-${random}`;
}

/**
 * Create a session directory and return its path
 */
function createSession(sessionId, toolName, args) {
  ensureDirectories();

  const sessionDir = join(SESSIONS_DIR, sessionId);
  mkdirSync(sessionDir, { recursive: true });

  // Write request metadata
  const request = {
    sessionId,
    tool: toolName,
    args,
    startTime: new Date().toISOString(),
    status: 'in_progress'
  };

  writeFileSync(
    join(sessionDir, 'request.json'),
    JSON.stringify(request, null, 2)
  );

  // Update current symlink
  try {
    if (existsSync(CURRENT_LINK)) {
      unlinkSync(CURRENT_LINK);
    }
    symlinkSync(sessionDir, CURRENT_LINK);
  } catch (e) {
    // Symlink may fail on some systems, non-critical
  }

  return sessionDir;
}

/**
 * Complete a session with response data
 */
function completeSession(sessionDir, result, duration) {
  const requestPath = join(sessionDir, 'request.json');
  const request = JSON.parse(readFileSync(requestPath, 'utf8'));

  // Update request with completion info
  request.endTime = new Date().toISOString();
  request.duration = duration;
  request.status = result.success ? 'completed' : 'failed';

  writeFileSync(requestPath, JSON.stringify(request, null, 2));

  // Write response
  writeFileSync(
    join(sessionDir, 'response.json'),
    JSON.stringify({
      success: result.success,
      exitCode: result.exitCode,
      output: result.output,
      error: result.error || null,
      stderr: result.stderr || null
    }, null, 2)
  );

  // Write combined log for easy reading
  const log = `
================================================================================
DROID SESSION: ${request.sessionId}
================================================================================
Tool: ${request.tool}
Started: ${request.startTime}
Ended: ${request.endTime}
Duration: ${duration}ms
Status: ${request.status}
Exit Code: ${result.exitCode}

--- PROMPT ---
${request.args.prompt || 'N/A'}

--- OUTPUT ---
${result.output || '(no output)'}

--- ERRORS ---
${result.error || result.stderr || '(none)'}
================================================================================
`.trim();

  writeFileSync(join(sessionDir, 'session.log'), log);
}

// Create MCP server
const server = new Server(
  {
    name: 'droid-mcp-server',
    version: '2.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * Execute a Droid command and return the result
 */
async function executeDroid(prompt, options = {}) {
  const {
    autoLevel = 'medium',
    model = 'claude-sonnet-5',
    cwd = process.cwd(),
    timeout = 300000 // 5 minutes default
  } = options;

  return new Promise((resolve, reject) => {
    const args = ['exec'];

    // Add autonomy level
    if (autoLevel && autoLevel !== 'readonly') {
      args.push('--auto', autoLevel);
    }

    // Add model if specified
    if (model) {
      args.push('--model', model);
    }

    // Add working directory
    args.push('--cwd', cwd);

    // Add the prompt
    args.push(prompt);

    const droidProcess = spawn('droid', args, {
      cwd: cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    droidProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    droidProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // Timeout handler
    const timeoutId = setTimeout(() => {
      droidProcess.kill('SIGTERM');
      reject(new Error(`Droid execution timed out after ${timeout}ms`));
    }, timeout);

    droidProcess.on('close', (code) => {
      clearTimeout(timeoutId);
      if (code === 0) {
        resolve({
          success: true,
          output: stdout,
          stderr: stderr || null,
          exitCode: code
        });
      } else {
        resolve({
          success: false,
          output: stdout,
          error: stderr || `Process exited with code ${code}`,
          exitCode: code
        });
      }
    });

    droidProcess.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(new Error(`Failed to spawn Droid: ${err.message}`));
    });
  });
}

/**
 * Check if Droid is available
 */
async function checkDroidAvailable() {
  return new Promise((resolve) => {
    const check = spawn('droid', ['--version'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let version = '';

    check.stdout.on('data', (data) => {
      version += data.toString();
    });

    check.on('close', (code) => {
      resolve({
        available: code === 0,
        version: version.trim()
      });
    });

    check.on('error', () => {
      resolve({ available: false, version: null });
    });
  });
}

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'droid_exec',
        description: `Execute a task using Factory Droid AI agent. Droid is excellent for:
- Quick batch fixes (linting, formatting, refactoring)
- Code modifications that don't need conversation context
- Automated fixes (TypeScript errors, test failures)
- File operations across multiple files

Autonomy levels:
- readonly: Only read operations (safe analysis)
- low: Basic file operations (docs, comments, formatting)
- medium: Development operations (npm install, git commit, builds)
- high: Production operations (git push, deployments)`,
        inputSchema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'The task description for Droid to execute'
            },
            autoLevel: {
              type: 'string',
              enum: ['readonly', 'low', 'medium', 'high'],
              default: 'medium',
              description: 'Autonomy level controlling what operations Droid can perform'
            },
            model: {
              type: 'string',
              default: 'claude-sonnet-5',
              description: 'Model to use for Droid execution'
            },
            cwd: {
              type: 'string',
              description: 'Working directory for Droid (defaults to current directory)'
            },
            timeout: {
              type: 'number',
              default: 300000,
              description: 'Timeout in milliseconds (default: 5 minutes)'
            }
          },
          required: ['prompt']
        }
      },
      {
        name: 'droid_status',
        description: 'Check if Factory Droid is available and get version info',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'droid_analyze',
        description: 'Use Droid in read-only mode to analyze code without making changes. Safe for exploration and planning.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'What to analyze (e.g., "review security of auth module", "find performance issues")'
            },
            cwd: {
              type: 'string',
              description: 'Working directory for analysis'
            }
          },
          required: ['prompt']
        }
      }
    ]
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case 'droid_exec': {
      const sessionId = generateSessionId();
      const sessionDir = createSession(sessionId, name, args);
      const startTime = Date.now();

      try {
        const result = await executeDroid(args.prompt, {
          autoLevel: args.autoLevel || 'medium',
          model: args.model,
          cwd: args.cwd || PROJECT_ROOT,
          timeout: args.timeout || 300000
        });

        const duration = Date.now() - startTime;
        completeSession(sessionDir, result, duration);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ...result, sessionId }, null, 2)
            }
          ]
        };
      } catch (error) {
        const duration = Date.now() - startTime;
        const errorResult = { success: false, error: error.message, exitCode: -1 };
        completeSession(sessionDir, errorResult, duration);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ...errorResult, sessionId }, null, 2)
            }
          ],
          isError: true
        };
      }
    }

    case 'droid_status': {
      const status = await checkDroidAvailable();

      // Count sessions
      let sessionCount = 0;
      try {
        const { readdirSync } = await import('fs');
        sessionCount = readdirSync(SESSIONS_DIR).filter(f => !f.startsWith('.')).length;
      } catch (e) {}

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              available: status.available,
              version: status.version,
              sessionsDir: SESSIONS_DIR,
              totalSessions: sessionCount,
              message: status.available
                ? `Droid v${status.version} is ready (${sessionCount} sessions logged)`
                : 'Droid is not available in PATH'
            }, null, 2)
          }
        ]
      };
    }

    case 'droid_analyze': {
      const sessionId = generateSessionId();
      const sessionDir = createSession(sessionId, name, args);
      const startTime = Date.now();

      try {
        const result = await executeDroid(args.prompt, {
          autoLevel: 'readonly',
          cwd: args.cwd || PROJECT_ROOT,
          timeout: 120000 // 2 min for analysis
        });

        const duration = Date.now() - startTime;
        completeSession(sessionDir, result, duration);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ...result, sessionId }, null, 2)
            }
          ]
        };
      } catch (error) {
        const duration = Date.now() - startTime;
        const errorResult = { success: false, error: error.message, exitCode: -1 };
        completeSession(sessionDir, errorResult, duration);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ...errorResult, sessionId }, null, 2)
            }
          ],
          isError: true
        };
      }
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Start the server
async function main() {
  ensureDirectories();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Droid MCP Server v2.0.0 started (with session logging)');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
