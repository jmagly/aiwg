/**
 * AIWG MCP Server
 *
 * Model Context Protocol server exposing AIWG capabilities.
 * Follows MCP 2025-11-25 specification.
 *
 * @see https://modelcontextprotocol.io/specification/2025-11-25
 * @architecture @.aiwg/architecture/software-architecture-doc.md - Section 2.1 CLI Layer
 * @reference @docs/references/REF-066-mcp-specification-2025.md
 * @cli @docs/cli/agent-usage.md - mcp serve command
 * @frameworks @agentic/code/frameworks/sdlc-complete/
 * @frameworks @agentic/code/frameworks/media-marketing-kit/
 */

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs/promises';
import { constants } from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerWriterProfileResources } from './tools/writer-profiles.mjs';
import { registerDiscoveryTools } from './tools/discovery.mjs';
import { registerCommandRunTool } from './tools/command-run.mjs';
import { registerInteractionTools } from './tools/interaction.mjs';
import { parseToolsets, registerOptInToolsets, KNOWN_TOOLSETS } from './tools/subsystems.mjs';
import { AIWG_ROOT, findProjectRoot, resolveProjectAiwgDir } from './helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Framework paths
const FRAMEWORKS = {
  'sdlc-complete': path.join(AIWG_ROOT, 'agentic/code/frameworks/sdlc-complete'),
  'media-marketing-kit': path.join(AIWG_ROOT, 'agentic/code/frameworks/media-marketing-kit')
};

function assertArtifactContained(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Artifact path must stay beneath the artifact root');
  }
}

async function resolveArtifactRoot(projectRoot, write) {
  const configured = await resolveProjectAiwgDir(projectRoot);
  try {
    return await fs.realpath(configured);
  } catch (error) {
    if (!write || error.code !== 'ENOENT') throw error;
    // Only bootstrap the local default. An unavailable configured store or
    // dangling root alias must fail closed, without a local fallback.
    if (configured !== path.resolve(projectRoot, '.aiwg')) throw error;
    const existing = await fs.lstat(configured).catch(missing => {
      if (missing.code !== 'ENOENT') throw missing;
    });
    if (existing) throw error;
    const project = await fs.realpath(projectRoot);
    let parent;
    let verified = false;
    try {
      let entry = path.join(project, '.aiwg');
      if (process.platform === 'linux' && constants.O_DIRECTORY && constants.O_NOFOLLOW) {
        parent = await fs.open(project, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        if (await fs.realpath(`/proc/self/fd/${parent.fd}`) !== project) {
          throw new Error('Project root changed during artifact creation');
        }
        entry = `/proc/self/fd/${parent.fd}/.aiwg`;
      }
      try {
        await fs.mkdir(entry);
      } catch (mkdirError) {
        if (mkdirError.code !== 'EEXIST') throw mkdirError;
      }
      const info = await fs.lstat(entry);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Artifact root changed during creation');
      const root = await fs.realpath(entry);
      if (root !== path.join(project, '.aiwg')) throw new Error('Artifact root changed during creation');
      verified = true;
      return root;
    } finally {
      if (parent) {
        const [closed] = await Promise.allSettled([parent.close()]);
        if (verified && closed.status === 'rejected') throw closed.reason;
      }
    }
  }
}

/** Resolve existing aliases before creating anything; dangling symlinks fail closed. */
async function resolveArtifactPath(projectRoot, artifactPath, { write = false } = {}) {
  if (!artifactPath || path.isAbsolute(artifactPath) || path.win32.isAbsolute(artifactPath)
    || /^[A-Za-z]:/.test(artifactPath)
    || (process.platform === 'win32' && artifactPath.split(/[\\/]/).some(part => /[. ]$/.test(part) || part.includes(':')))
    || artifactPath.split(/[\\/]/).includes('..')) {
    throw new Error('Artifact path must be relative and contain no .. segments');
  }
  const root = await resolveArtifactRoot(projectRoot, write);
  const target = path.resolve(root, artifactPath);
  assertArtifactContained(root, target);
  let ancestor = path.dirname(target);
  const missing = [];
  while (true) {
    try {
      // lstat distinguishes a missing directory from a dangling symlink.
      await fs.lstat(ancestor);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
  const realAncestor = await fs.realpath(ancestor);
  if (realAncestor !== root) assertArtifactContained(root, realAncestor);
  const fullPath = path.resolve(realAncestor, ...missing, path.basename(target));
  assertArtifactContained(root, fullPath);
  let info;
  try {
    info = await fs.lstat(fullPath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (info) {
    if (write && info.isSymbolicLink()) throw new Error('Refusing to write through an artifact symlink');
    const realTarget = await fs.realpath(fullPath);
    assertArtifactContained(root, realTarget);
    if (!write) return { root, fullPath: realTarget };
  }
  return { root, fullPath };
}

/**
 * Node has no openat. Linux procfs descriptor paths anchor each lookup to an
 * opened directory, so replacing a parent name cannot redirect open/mkdir.
 * Other platforms use checked path components and post-open identity/containment
 * verification, with O_NOFOLLOW where available and no truncation before checks.
 * That portable fallback has a residual race: a concurrent parent replacement
 * can redirect mkdir/open (including creation outside the root) between checks,
 * or change the path between lstat and realpath. It cannot anchor those lookups.
 * A same-user actor can still rename an opened directory out of the root after
 * verification (or introduce hard links); this is not a hostile-user sandbox.
 */
async function openArtifact(projectRoot, artifactPath, { write = false } = {}) {
  const { root, fullPath } = await resolveArtifactPath(projectRoot, artifactPath, { write });
  if (process.platform !== 'linux' || !constants.O_NOFOLLOW || !constants.O_DIRECTORY) {
    return openArtifactPortable(root, fullPath, { write });
  }
  const directories = [];
  let file;
  let verified = false;
  const descriptorPath = handle => `/proc/self/fd/${handle.fd}`;
  async function verify(handle, { rootHandle = false, directory = false } = {}) {
    const actual = await fs.realpath(descriptorPath(handle));
    if (rootHandle) {
      if (actual !== root) throw new Error('Artifact root changed during access');
    } else {
      assertArtifactContained(root, actual);
    }
    const [opened, current] = await Promise.all([handle.stat(), fs.lstat(actual)]);
    if (opened.dev !== current.dev || opened.ino !== current.ino
      || (directory ? !opened.isDirectory() : !opened.isFile())) {
      throw new Error('Artifact changed during access or is not a regular file/directory');
    }
    return actual;
  }
  try {
    let parent = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    directories.push(parent);
    await verify(parent, { rootHandle: true, directory: true });
    const components = path.relative(root, fullPath).split(path.sep);
    const name = components.pop();
    for (const component of components) {
      const entry = path.join(descriptorPath(parent), component);
      let child;
      try {
        child = await fs.open(entry, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      } catch (error) {
        if (!write || error.code !== 'ENOENT') throw error;
        await verify(parent, { rootHandle: directories.length === 1, directory: true });
        try {
          // One component only: never follow a replaced parent via mkdir -p.
          await fs.mkdir(entry);
        } catch (mkdirError) {
          if (mkdirError.code !== 'EEXIST') throw mkdirError;
        }
        child = await fs.open(entry, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      }
      directories.push(child);
      await verify(child, { directory: true });
      parent = child;
    }
    await verify(parent, { rootHandle: directories.length === 1, directory: true });
    // Do not truncate until the opened file has passed descriptor verification.
    file = await fs.open(path.join(descriptorPath(parent), name),
      (write ? constants.O_WRONLY | constants.O_CREAT : constants.O_RDONLY)
      | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const actual = await verify(file);
    verified = true;
    return { handle: file, fullPath: actual };
  } finally {
    const closed = await Promise.allSettled(directories.map(handle => handle.close()));
    const failure = closed.find(result => result.status === 'rejected');
    if (file && (!verified || failure)) await Promise.allSettled([file.close()]);
    // Preserve the access error on failure; on success retain ownership until
    // directory cleanup succeeds, so a cleanup error cannot leak the file.
    if (verified && failure) throw failure.reason;
  }
}

async function openArtifactPortable(root, fullPath, { write }) {
  async function verifyDirectory(directory) {
    const info = await fs.lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error('Artifact directory changed or is a symlink');
    }
    const actual = await fs.realpath(directory);
    if (directory === root) {
      if (actual !== root) throw new Error('Artifact root changed during access');
    } else {
      assertArtifactContained(root, actual);
    }
  }
  let parent = root;
  await verifyDirectory(parent);
  const components = path.relative(root, fullPath).split(path.sep);
  components.pop();
  for (const component of components) {
    const entry = path.join(parent, component);
    try {
      await fs.lstat(entry);
    } catch (error) {
      if (!write || error.code !== 'ENOENT') throw error;
      await verifyDirectory(parent);
      try {
        // Create one component, then check even if another actor created it.
        await fs.mkdir(entry);
      } catch (mkdirError) {
        if (mkdirError.code !== 'EEXIST') throw mkdirError;
      }
    }
    await verifyDirectory(entry);
    parent = entry;
  }
  await verifyDirectory(parent);
  const flags = (write ? constants.O_WRONLY : constants.O_RDONLY)
    | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0);
  let handle;
  let created = false;
  try {
    handle = await fs.open(fullPath, flags);
  } catch (error) {
    if (!write || error.code !== 'ENOENT') throw error;
    await verifyDirectory(parent);
    // lstat rejects dangling final symlinks even without O_NOFOLLOW; O_EXCL
    // prevents following a final symlink inserted after this check.
    try {
      await fs.lstat(fullPath);
      throw new Error('Artifact appeared during creation');
    } catch (missing) {
      if (missing.code !== 'ENOENT') throw missing;
    }
    handle = await fs.open(fullPath, flags | constants.O_CREAT | constants.O_EXCL);
    created = true;
  }
  try {
    await verifyDirectory(parent);
    const [opened, current] = await Promise.all([handle.stat(), fs.lstat(fullPath)]);
    if (!opened.isFile() || current.isSymbolicLink()
      || opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new Error('Artifact changed during access or is not a regular file');
    }
    const actual = await fs.realpath(fullPath);
    assertArtifactContained(root, actual);
    return { handle, fullPath: actual };
  } catch (error) {
    if (created) {
      // Best effort only: portable Node has no inode-conditional unlink. Refuse
      // a detected replacement, and keep the original verification error.
      try {
        const [opened, current] = await Promise.all([handle.stat(), fs.lstat(fullPath)]);
        if (!current.isSymbolicLink() && opened.dev === current.dev && opened.ino === current.ino) {
          await fs.unlink(fullPath);
        }
      } catch { /* Path moved or cleanup unavailable; see portable race above. */ }
    }
    await Promise.allSettled([handle.close()]);
    throw error;
  }
}

/**
 * Create and configure the AIWG MCP Server
 */
export async function createServer() {
  const server = new McpServer({
    name: 'aiwg',
    version: '1.0.0'
  });

  // ============================================
  // TOOLS
  // ============================================

  // ============================================
  // Discovery toolset (#1311 #1313 #1320) — registers:
  //   discover, skill-list, skill-show, command-list, command-show,
  //   rule-list, rule-show, agent-show, template-list, template-show
  // ============================================
  registerDiscoveryTools(server);
  registerWriterProfileResources(server);

  // ============================================
  // Command-run dispatch (#1312) — registers:
  //   command-run (allow-listed CLI dispatch)
  // ============================================
  registerCommandRunTool(server);

  // ============================================
  // Interaction toolset (#1676) — registers:
  //   ask-user (structured question via MCP elicitation, markdown fallback)
  // ============================================
  registerInteractionTools(server);

  // ============================================
  // Opt-in subsystem toolsets (#1322-#1332)
  //
  // Enabled via AIWG_MCP_TOOLSETS env or `aiwg mcp serve --toolsets=`.
  // Known: flows, missions, memory, kb, research, activity-log, index, ralph, mc, ops, sandbox, decision, all
  // `workers` (#2892 direct worker run/status/cancel) needs an EXPLICIT name;
  // `all` deliberately does not reach it (src/mcp/tools/subsystems.mjs).
  // Default: none (core only — discovery + command-run)
  // ============================================
  const requested = parseToolsets(process.env.AIWG_MCP_TOOLSETS || '');
  // #2892 B1: the `workers` toolset's served project root is resolved ONCE,
  // here, at registration time — never lazily from `process.cwd()` inside
  // the tool handler on first request. A project root that cannot be found
  // (not running inside an AIWG project) means `workers` is simply not
  // registered; `registerWorkerInvokeToolset` refuses rather than falling
  // back to an implicit cwd.
  let projectRoot;
  try {
    projectRoot = await findProjectRoot();
  } catch {
    projectRoot = undefined;
  }
  await registerOptInToolsets(server, requested, { projectRoot });

  // Tool: artifact-read
  server.registerTool('artifact-read', {
    title: 'Read AIWG Artifact',
    description: 'Read artifact from .aiwg/ directory',
    inputSchema: {
      path: z.string().describe('Path relative to .aiwg/ (e.g., "requirements/UC-001.md")'),
      project_dir: z.string().optional().describe('Project directory path (defaults to auto-detected project root)')
    }
  }, async ({ path: artifactPath, project_dir }) => {
    try {
      // Auto-find project root if not specified
      const projectRoot = project_dir || await findProjectRoot();
      const { handle } = await openArtifact(projectRoot, artifactPath);
      let content;
      try {
        content = await handle.readFile('utf-8');
      } finally {
        await handle.close();
      }
      return {
        content: [{
          type: 'text',
          text: content
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error reading artifact: ${error.message}`
        }],
        isError: true
      };
    }
  });

  // Tool: artifact-write
  server.registerTool('artifact-write', {
    title: 'Write AIWG Artifact',
    description: 'Write artifact to .aiwg/ directory',
    inputSchema: {
      path: z.string().describe('Path relative to .aiwg/'),
      content: z.string().describe('Artifact content'),
      project_dir: z.string().optional().describe('Project directory path (defaults to auto-detected project root)')
    }
  }, async ({ path: artifactPath, content, project_dir }) => {
    try {
      // Auto-find project root if not specified
      const projectRoot = project_dir || await findProjectRoot();
      const { handle, fullPath } = await openArtifact(projectRoot, artifactPath, { write: true });
      try {
        await handle.truncate(0);
        await handle.writeFile(content, 'utf-8');
      } finally {
        await handle.close();
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: 'success',
            path: fullPath,
            message: 'Artifact written successfully'
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error writing artifact: ${error.message}`
        }],
        isError: true
      };
    }
  });

  // Tool: template-render
  server.registerTool('template-render', {
    title: 'Render AIWG Template',
    description: 'Render AIWG template with provided variables',
    inputSchema: {
      template: z.string().describe('Template path (e.g., "sdlc/intake/project-intake-template.md")'),
      variables: z.record(z.string()).optional().describe('Template variable substitutions')
    }
  }, async ({ template, variables = {} }) => {
    try {
      // Determine framework and template path
      const [framework, ...pathParts] = template.split('/');
      const frameworkPath = FRAMEWORKS[framework] || FRAMEWORKS['sdlc-complete'];
      const templatePath = path.join(frameworkPath, 'templates', ...pathParts);

      // Read template
      let content = await fs.readFile(templatePath, 'utf-8');

      // Simple variable substitution
      for (const [key, value] of Object.entries(variables)) {
        content = content.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
        content = content.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), value);
      }

      return {
        content: [{
          type: 'text',
          text: content
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error rendering template: ${error.message}`
        }],
        isError: true
      };
    }
  });

  // Tool: agent-list
  server.registerTool('agent-list', {
    title: 'List AIWG Agents',
    description: 'List available AIWG agents',
    inputSchema: {
      framework: z.enum(['sdlc-complete', 'media-marketing-kit', 'all']).default('all')
        .describe('Framework to list agents from'),
      category: z.string().optional().describe('Filter by category (e.g., "security", "testing")')
    }
  }, async ({ framework, category }) => {
    try {
      const agents = [];

      const frameworksToSearch = framework === 'all'
        ? Object.keys(FRAMEWORKS)
        : [framework];

      for (const fw of frameworksToSearch) {
        const agentDir = path.join(FRAMEWORKS[fw], 'agents');
        try {
          const files = await fs.readdir(agentDir);
          for (const file of files) {
            if (file.endsWith('.md') && !file.startsWith('README')) {
              const agentName = file.replace('.md', '');
              if (!category || agentName.includes(category)) {
                agents.push({
                  name: agentName,
                  framework: fw,
                  path: `aiwg://agents/${fw}/${agentName}`
                });
              }
            }
          }
        } catch {
          // Framework directory might not exist
        }
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            count: agents.length,
            agents
          }, null, 2)
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `Error listing agents: ${error.message}`
        }],
        isError: true
      };
    }
  });

  // ============================================
  // RESOURCES
  // ============================================

  // Resource: prompts catalog
  server.registerResource(
    'prompts-catalog',
    'aiwg://prompts/catalog',
    {
      title: 'AIWG Prompts Catalog',
      description: 'List of all available AIWG prompt templates',
      mimeType: 'application/json'
    },
    async () => {
      const promptsDir = path.join(AIWG_ROOT, 'agentic/code/addons/aiwg-utils/prompts');
      const catalog = await scanDirectory(promptsDir, 'prompts');
      return {
        contents: [{
          uri: 'aiwg://prompts/catalog',
          text: JSON.stringify(catalog, null, 2)
        }]
      };
    }
  );

  // Resource: templates catalog
  server.registerResource(
    'templates-catalog',
    'aiwg://templates/catalog',
    {
      title: 'AIWG Templates Catalog',
      description: 'List of all available AIWG document templates',
      mimeType: 'application/json'
    },
    async () => {
      const catalogs = {};
      for (const [fw, fwPath] of Object.entries(FRAMEWORKS)) {
        const templatesDir = path.join(fwPath, 'templates');
        try {
          catalogs[fw] = await scanDirectory(templatesDir, 'templates');
        } catch {
          catalogs[fw] = [];
        }
      }
      return {
        contents: [{
          uri: 'aiwg://templates/catalog',
          text: JSON.stringify(catalogs, null, 2)
        }]
      };
    }
  );

  // Resource: agents catalog
  server.registerResource(
    'agents-catalog',
    'aiwg://agents/catalog',
    {
      title: 'AIWG Agents Catalog',
      description: 'List of all available AIWG agents',
      mimeType: 'application/json'
    },
    async () => {
      const catalogs = {};
      for (const [fw, fwPath] of Object.entries(FRAMEWORKS)) {
        const agentsDir = path.join(fwPath, 'agents');
        try {
          catalogs[fw] = await scanDirectory(agentsDir, 'agents');
        } catch {
          catalogs[fw] = [];
        }
      }
      return {
        contents: [{
          uri: 'aiwg://agents/catalog',
          text: JSON.stringify(catalogs, null, 2)
        }]
      };
    }
  );

  // Dynamic resource: specific prompt
  server.registerResource(
    'prompt',
    new ResourceTemplate('aiwg://prompts/{category}/{name}', { list: undefined }),
    {
      title: 'AIWG Prompt',
      description: 'Retrieve specific AIWG prompt template'
    },
    async (uri, { category, name }) => {
      const promptPath = path.join(
        AIWG_ROOT,
        'agentic/code/addons/aiwg-utils/prompts',
        category,
        `${name}.md`
      );
      try {
        const content = await fs.readFile(promptPath, 'utf-8');
        return {
          contents: [{
            uri: uri.href,
            text: content
          }]
        };
      } catch {
        return {
          contents: [{
            uri: uri.href,
            text: `Prompt not found: ${category}/${name}`
          }]
        };
      }
    }
  );

  // Dynamic resource: specific template
  server.registerResource(
    'template',
    new ResourceTemplate('aiwg://templates/{framework}/{category}/{name}', { list: undefined }),
    {
      title: 'AIWG Template',
      description: 'Retrieve specific AIWG template'
    },
    async (uri, { framework, category, name }) => {
      const templatePath = path.join(
        FRAMEWORKS[framework] || FRAMEWORKS['sdlc-complete'],
        'templates',
        category,
        `${name}.md`
      );
      try {
        const content = await fs.readFile(templatePath, 'utf-8');
        return {
          contents: [{
            uri: uri.href,
            text: content
          }]
        };
      } catch {
        return {
          contents: [{
            uri: uri.href,
            text: `Template not found: ${framework}/${category}/${name}`
          }]
        };
      }
    }
  );

  // Dynamic resource: specific agent
  server.registerResource(
    'agent',
    new ResourceTemplate('aiwg://agents/{framework}/{name}', { list: undefined }),
    {
      title: 'AIWG Agent',
      description: 'Retrieve specific AIWG agent definition'
    },
    async (uri, { framework, name }) => {
      const agentPath = path.join(
        FRAMEWORKS[framework] || FRAMEWORKS['sdlc-complete'],
        'agents',
        `${name}.md`
      );
      try {
        const content = await fs.readFile(agentPath, 'utf-8');
        return {
          contents: [{
            uri: uri.href,
            text: content
          }]
        };
      } catch {
        return {
          contents: [{
            uri: uri.href,
            text: `Agent not found: ${framework}/${name}`
          }]
        };
      }
    }
  );

  // ============================================
  // PROMPTS (MCP Prompt Templates)
  // ============================================

  // Prompt: decompose-task
  server.registerPrompt(
    'decompose-task',
    {
      title: 'Task Decomposition',
      description: 'Break down complex task into manageable subtasks (≤7 for cognitive limit)',
      argsSchema: {
        task: z.string().describe('Complex task to decompose'),
        max_subtasks: z.string().default('7').describe('Maximum subtasks (cognitive limit)')
      }
    },
    ({ task, max_subtasks }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `## Task Decomposition Request

Break down the following task into ${max_subtasks} or fewer concrete, actionable subtasks.

**Task**: ${task}

**Guidelines**:
1. Each subtask should be independently executable
2. Subtasks should have clear completion criteria
3. Order by logical dependency (prerequisites first)
4. Identify which subtasks can run in parallel
5. Flag any subtasks that require user input

**Output Format**:
For each subtask, provide:
- ID: Sequential identifier
- Description: Clear action statement
- Dependencies: List of prerequisite subtask IDs
- Parallelizable: Yes/No
- Requires Input: Yes/No (if Yes, specify what)`
        }
      }]
    })
  );

  // Prompt: parallel-execution
  server.registerPrompt(
    'parallel-execution',
    {
      title: 'Parallel Execution Guide',
      description: 'Identify and coordinate parallelizable work items',
      argsSchema: {
        tasks: z.string().describe('List of tasks to analyze for parallelization')
      }
    },
    ({ tasks }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `## Parallel Execution Analysis

Analyze the following tasks and identify which can be executed in parallel.

**Tasks**:
${tasks}

**Analysis Required**:
1. **Dependency Graph**: Map task dependencies
2. **Parallel Groups**: Group tasks that can run simultaneously
3. **Critical Path**: Identify the longest sequential chain
4. **Resource Conflicts**: Flag tasks that compete for same resources
5. **Coordination Points**: Where parallel streams must synchronize

**Output**: Provide an execution plan with parallel lanes and sync points.`
        }
      }]
    })
  );

  // Prompt: recovery-protocol
  server.registerPrompt(
    'recovery-protocol',
    {
      title: 'Recovery Protocol',
      description: 'Structured error recovery using PAUSE→DIAGNOSE→ADAPT→RETRY→ESCALATE',
      argsSchema: {
        error: z.string().describe('Error message or description'),
        context: z.string().optional().describe('Additional context about what was being attempted')
      }
    },
    ({ error, context }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: `## Recovery Protocol

An error has occurred. Follow the structured recovery protocol.

**Error**: ${error}
${context ? `**Context**: ${context}` : ''}

**Protocol**:

### 1. PAUSE
Stop execution and preserve current state.
- What was the exact operation being performed?
- What state needs to be preserved?

### 2. DIAGNOSE
Analyze the error and classify it:
- **Syntax Error**: Fix formatting/structure
- **Schema Mismatch**: Re-inspect target (Rule 4: Grounding)
- **Logic Error**: Decompose further
- **Loop Detected**: Change approach entirely
- **External Failure**: Network, API, or resource issue

### 3. ADAPT
Choose a recovery strategy:
- Simple retry (transient failures)
- Modified approach (logic issues)
- Alternative path (blocked resources)
- Partial completion (scope reduction)

### 4. RETRY
Execute adapted approach (max 3 attempts).
Track what was tried and outcomes.

### 5. ESCALATE
If retry fails, prepare structured escalation:
- What was attempted
- What failed
- Current state
- Recommended next steps
- Human decision required`
        }
      }]
    })
  );

  return server;
}

// ============================================
// HELPER FUNCTIONS
// ============================================

/**
 * Scan directory for files
 */
async function scanDirectory(dir, type) {
  const results = [];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const subResults = await scanDirectory(path.join(dir, entry.name), type);
        results.push(...subResults.map(r => ({
          ...r,
          category: entry.name
        })));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push({
          name: entry.name.replace('.md', ''),
          path: path.join(dir, entry.name),
          uri: `aiwg://${type}/${entry.name.replace('.md', '')}`
        });
      }
    }
  } catch {
    // Directory doesn't exist
  }
  return results;
}

/**
 * Start the MCP server with stdio transport
 */
export async function startServer() {
  const server = await createServer();
  const transport = new StdioServerTransport();

  console.error('[AIWG MCP] Starting server...');
  await server.connect(transport);
  console.error('[AIWG MCP] Server connected via stdio transport');

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.error('[AIWG MCP] Shutting down...');
    await server.close();
    process.exit(0);
  });
}

// Run if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startServer().catch(error => {
    console.error('[AIWG MCP] Fatal error:', error);
    process.exit(1);
  });
}
