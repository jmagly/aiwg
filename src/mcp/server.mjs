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
import { randomUUID } from 'node:crypto';
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

function rootedArtifactAccess() {
  return process.platform === 'linux' && constants.O_NOFOLLOW && constants.O_DIRECTORY;
}

/** A root pinned as missing must be created by us, never adopted later. */
async function createArtifactRoot(store) {
  let parent;
  let directory;
  let verified = false;
  try {
    let entry = store.configured;
    if (rootedArtifactAccess()) {
      parent = await fs.open(store.projectRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      if (await fs.realpath(`/proc/self/fd/${parent.fd}`) !== store.projectRoot) {
        throw new Error('Project root changed during artifact creation');
      }
      entry = `/proc/self/fd/${parent.fd}/.aiwg`;
    }
    // EEXIST is a refusal, including a symlink or directory installed since pinning.
    await fs.mkdir(entry);
    const created = await fs.lstat(entry);
    if (created.isSymbolicLink() || !created.isDirectory()) throw new Error('Artifact root changed during creation');
    // Windows cannot open directory handles through fs.open; its fallback
    // uses static identity checks, as do the subsequent artifact operations.
    if (process.platform !== 'win32') {
      directory = await fs.open(entry, constants.O_RDONLY | (constants.O_DIRECTORY || 0) | (constants.O_NOFOLLOW || 0));
    }
    const opened = directory ? await directory.stat() : await fs.stat(entry);
    const current = await fs.lstat(entry);
    if (current.isSymbolicLink() || !opened.isDirectory()
      || opened.dev !== created.dev || opened.ino !== created.ino
      || opened.dev !== current.dev || opened.ino !== current.ino
      || await fs.realpath(store.configured) !== store.root) {
      throw new Error('Artifact root changed during creation');
    }
    store.identity = opened;
    verified = true;
  } finally {
    const closed = await Promise.allSettled([...(directory ? [directory.close()] : []), ...(parent ? [parent.close()] : [])]);
    const failure = closed.find(result => result.status === 'rejected');
    if (verified && failure) throw failure.reason;
  }
}

/** Pin an existing store once; only a missing local default may be bootstrapped. */
async function pinArtifactRoot(configured, projectRoot) {
  try {
    const root = await fs.realpath(configured);
    const identity = await fs.stat(root);
    const store = { configured, projectRoot, root, identity };
    await verifyArtifactRoot(store);
    return store;
  } catch (error) {
    if (error.code === 'ENOENT' && configured === path.join(projectRoot, '.aiwg')) {
      const existing = await fs.lstat(configured).catch(missing => {
        if (missing.code !== 'ENOENT') throw missing;
      });
      if (!existing) return { configured, projectRoot, root: configured, identity: null };
      // A symlink (or other unexpected node) present where the default root
      // should be created must not become the containment root later.
      return {
        configured,
        projectRoot,
        root: configured,
        error: new Error('Default artifact root is not a creatable directory'),
      };
    }
    // Keep discovery available, but never adopt a store that was unavailable
    // at startup (including a dangling alias) on a later request.
    return { configured, projectRoot, root: configured, error };
  }
}

async function verifyArtifactRoot(store) {
  if (store.error) throw store.error;
  const canonical = await fs.realpath(store.configured);
  const current = await fs.stat(store.configured);
  if (canonical !== store.root || !current.isDirectory()
    || current.dev !== store.identity.dev || current.ino !== store.identity.ino) {
    throw new Error('Artifact root changed since it was pinned');
  }
}

async function pinnedArtifactRoot(store, write) {
  if (store.error) throw store.error;
  if (!store.identity) {
    if (!write) throw new Error('Default artifact root has not been created');
    // Serialize first-write initialization so concurrent requests share one
    // identity. Creation still rejects symlinks and uses a project descriptor.
    store.initialization ||= createArtifactRoot(store);
    await store.initialization;
  }
  await verifyArtifactRoot(store);
  return store.root;
}

/** Resolve existing aliases before creating anything; dangling symlinks fail closed. */
async function resolveArtifactPath(store, artifactPath, { write = false } = {}) {
  if (!artifactPath || path.isAbsolute(artifactPath) || path.win32.isAbsolute(artifactPath)
    || /^[A-Za-z]:/.test(artifactPath)
    || (process.platform === 'win32' && artifactPath.split(/[\\/]/).some(part => part !== '.'
      && (/[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))))
    || artifactPath.split(/[\\/]/).includes('..')) {
    throw new Error('Artifact path must be relative and contain no .. segments');
  }
  if (write && artifactPath.split(/[\\/]/).some(part => /^\.aiwg-location[. ]*(?::.*)?$/i.test(part))) {
    throw new Error('Refusing to write an artifact location pointer');
  }
  const root = await pinnedArtifactRoot(store, write);
  const target = path.resolve(root, artifactPath);
  assertArtifactContained(root, target);
  if (!rootedArtifactAccess()) {
    let componentPath = root;
    for (const component of path.relative(root, target).split(path.sep)) {
      componentPath = path.join(componentPath, component);
      const info = await fs.lstat(componentPath).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (info?.isSymbolicLink()) throw new Error('Refusing artifact symlink component');
    }
  }
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
 * Linux procfs descriptor paths anchor each lookup to an opened directory.
 * Other platforms use static containment checks. Writes use a fresh inode;
 * failed verification closes handles without unsafe pathname cleanup.
 * Concurrent same-user relocation after verification is not a sandbox boundary.
 */
async function openArtifact(store, artifactPath, { write = false } = {}) {
  const { root, fullPath } = await resolveArtifactPath(store, artifactPath, { write });
  if (!rootedArtifactAccess()) return openStaticArtifact(store, root, fullPath, { write });
  const directories = [];
  let file;
  let transferred = false;
  const descriptorPath = handle => `/proc/self/fd/${handle.fd}`;
  async function verify(handle, { rootHandle = false, directory = false, entry } = {}) {
    const actual = await fs.realpath(descriptorPath(handle));
    if (rootHandle) {
      if (actual !== root) throw new Error('Artifact root changed during access');
    } else {
      assertArtifactContained(root, actual);
    }
    const [opened, current] = await Promise.all([handle.stat(), fs.lstat(entry || actual)]);
    if (rootHandle) {
      await verifyArtifactRoot(store);
      if (opened.dev !== store.identity.dev || opened.ino !== store.identity.ino) {
        throw new Error('Artifact root changed since it was pinned');
      }
    }
    if (current.isSymbolicLink() || opened.dev !== current.dev || opened.ino !== current.ino
      || (directory ? !opened.isDirectory() : !opened.isFile())) {
      throw new Error('Artifact changed during access or is not a regular file/directory');
    }
    if (!directory && (opened.nlink > 1 || current.nlink > 1)) {
      throw new Error('Refusing multiply-linked artifact file');
    }
    return actual;
  }
  async function close() {
    const closed = await Promise.allSettled([...(file ? [file.close()] : []), ...directories.map(handle => handle.close())]);
    const failure = closed.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
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
    const parentOptions = { rootHandle: directories.length === 1, directory: true };
    await verify(parent, parentOptions);
    const destination = path.join(descriptorPath(parent), name);
    async function verifyDestination() {
      const info = await fs.lstat(destination).catch(error => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (info && (info.isSymbolicLink() || !info.isFile())) {
        throw new Error('Refusing to replace an artifact symlink or nonregular file');
      }
      return info;
    }
    const targetInfo = write ? await verifyDestination() : undefined;
    const finalMode = targetInfo ? targetInfo.mode & 0o7777 : 0o666 & ~process.umask();
    const entry = write ? path.join(descriptorPath(parent), `.aiwg-write-${randomUUID()}.tmp`) : destination;
    file = await fs.open(entry,
      (write ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL : constants.O_RDONLY)
      | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    await verify(file, { entry });
    transferred = true;
    return {
      handle: file,
      fullPath,
      close,
      async commit() {
        await verify(directories[0], { rootHandle: true, directory: true });
        await verify(file, { entry });
        await verify(parent, parentOptions);
        await verifyDestination();
        await file.chmod(finalMode);
        await fs.rename(entry, destination);
      },
    };
  } finally {
    if (!transferred) await Promise.allSettled([close()]);
  }
}

/** Static checks for platforms without Linux descriptor paths. */
async function openStaticArtifact(store, root, fullPath, { write }) {
  // Inspect the lexical path as well as the resolved path: contained aliases
  // must not hide symlink components on this fallback.
  async function check(target, { allowMissing = false } = {}) {
    const relative = path.relative(root, target);
    assertArtifactContained(root, target);
    let current = root;
    for (const component of relative.split(path.sep)) {
      current = path.join(current, component);
      const info = await fs.lstat(current).catch(error => {
        if (!allowMissing || error.code !== 'ENOENT') throw error;
      });
      if (!info) continue;
      if (info.isSymbolicLink()) throw new Error('Refusing artifact symlink component');
      assertArtifactContained(root, await fs.realpath(current));
    }
  }
  await check(fullPath, { allowMissing: write });
  if (write) await fs.mkdir(path.dirname(fullPath), { recursive: true });
  const target = await fs.lstat(fullPath).catch(error => {
    if (!write || error.code !== 'ENOENT') throw error;
  });
  if (target && (!target.isFile() || target.isSymbolicLink())) throw new Error('Artifact must be a regular file');
  if (!write && target.nlink > 1) throw new Error('Refusing multiply-linked artifact file');
  const entry = write ? path.join(path.dirname(fullPath), `.aiwg-write-${randomUUID()}.tmp`) : fullPath;
  const finalMode = target ? target.mode & 0o7777 : 0o666 & ~process.umask();
  const handle = await fs.open(entry, write ? constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL : constants.O_RDONLY, 0o600);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink > 1) throw new Error('Refusing nonregular or multiply-linked artifact file');
    return {
      handle, fullPath, close: () => handle.close(),
      async commit() {
        await verifyArtifactRoot(store);
        await check(fullPath, { allowMissing: true });
        await handle.chmod(finalMode);
        await fs.rename(entry, fullPath);
      },
    };
  } catch (error) {
    await handle.close().catch(() => {});
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

  // Resolve operator configuration once per trusted project, then pin it.
  const artifactEnv = { ...process.env };
  const trustedProjectRoot = await fs.realpath(projectRoot || process.cwd());
  const trustedArtifactRoot = await resolveProjectAiwgDir(trustedProjectRoot, { env: artifactEnv });
  const startupStore = await pinArtifactRoot(trustedArtifactRoot, trustedProjectRoot);
  const trustedStore = startupStore.root;
  const projects = new Map();
  async function trustProject(requested, store) {
    const canonical = await fs.realpath(requested);
    const identity = await fs.stat(requested);
    if (!identity.isDirectory()) throw new Error('project_dir must be a real directory');
    if (canonical !== trustedProjectRoot) {
      const inStore = path.relative(trustedStore, canonical);
      if (canonical.split(path.sep).includes('.aiwg') || !inStore
        || (inStore !== '..' && !inStore.startsWith(`..${path.sep}`) && !path.isAbsolute(inStore))) {
        throw new Error('project_dir must not select a project inside an artifact store');
      }
    }
    const configured = store ? undefined : await resolveProjectAiwgDir(canonical, { env: { ...process.env } });
    return { canonical, identity, store: store || await pinArtifactRoot(configured, canonical) };
  }
  const startupProject = Promise.resolve(await trustProject(trustedProjectRoot, startupStore));
  projects.set(trustedProjectRoot, startupProject);
  const canonicalProjects = new Map([[trustedProjectRoot, startupProject]]);
  async function artifactRoots(explicit) {
    const requested = explicit ? path.resolve(trustedProjectRoot, explicit) : trustedProjectRoot;
    // Key by the supplied project path, so a replacement cannot acquire fresh trust.
    if (!projects.has(requested)) {
      const canonical = await fs.realpath(requested);
      if (!canonicalProjects.has(canonical)) canonicalProjects.set(canonical, trustProject(requested));
      projects.set(requested, canonicalProjects.get(canonical));
    }
    const pinned = await projects.get(requested);
    const canonical = await fs.realpath(requested);
    const current = await fs.stat(requested);
    if (canonical !== pinned.canonical || !current.isDirectory()
      || current.dev !== pinned.identity.dev || current.ino !== pinned.identity.ino) {
      throw new Error('Project root changed since it was pinned');
    }
    return pinned.store;
  }

  // Tool: artifact-read
  server.registerTool('artifact-read', {
    title: 'Read AIWG Artifact',
    description: 'Read artifact from .aiwg/ directory',
    inputSchema: {
      path: z.string().describe('Path relative to .aiwg/ (e.g., "requirements/UC-001.md")'),
      project_dir: z.string().optional().describe('Real project directory outside artifact trees (defaults to server-start project; artifact store pinned on first use)')
    }
  }, async ({ path: artifactPath, project_dir }) => {
    try {
      const store = await artifactRoots(project_dir);
      const { handle, close } = await openArtifact(store, artifactPath);
      let content;
      let completed = false;
      try {
        content = await handle.readFile('utf-8');
        completed = true;
      } finally {
        const [closed] = await Promise.allSettled([close()]);
        if (completed && closed.status === 'rejected') throw closed.reason;
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
      project_dir: z.string().optional().describe('Real project directory outside artifact trees (defaults to server-start project; artifact store pinned on first use)')
    }
  }, async ({ path: artifactPath, content, project_dir }) => {
    try {
      const store = await artifactRoots(project_dir);
      const { handle, fullPath, commit, close } = await openArtifact(store, artifactPath, { write: true });
      let completed = false;
      try {
        await handle.writeFile(content, 'utf-8');
        await commit();
        completed = true;
      } finally {
        // Close every owned descriptor; preserve any write/verification error.
        const [closed] = await Promise.allSettled([close()]);
        if (completed && closed.status === 'rejected') throw closed.reason;
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
