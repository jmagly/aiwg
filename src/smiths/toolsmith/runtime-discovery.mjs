/**
 * Runtime Discovery Module for Toolsmith
 *
 * Discovers installed tools, verifies functionality, and generates runtime catalog.
 *
 * @architecture @docs/smithing/toolsmith.md
 * @architecture @docs/smithing/toolsmith.md
 */

import { boundedExecFileSync, boundedExecSync } from '../../process/bounded-child-process.mjs';
import { readFile, writeFile, mkdir, access, stat } from 'fs/promises';
import { existsSync, constants } from 'fs';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'path';
import { platform, arch, homedir, tmpdir, cpus, totalmem, freemem } from 'os';
import { fileURLToPath } from 'url';
import { projectAiwgPath } from '../../config/project-artifacts-runtime.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * RuntimeDiscovery - Discovers and catalogs installed system tools
 */
export class RuntimeDiscovery {
  constructor(basePath = null, { cwd = process.cwd(), quiet = false } = {}) {
    this.cwd = cwd;
    this.quiet = quiet;
    this.basePath = basePath || projectAiwgPath(this.cwd, 'smiths', 'toolsmith');
    this.knownTools = this.#loadKnownTools();
  }

  /**
   * Refresh discovery, skipping version probes when inputs are unchanged.
   * @returns {Promise<Object>} RuntimeCatalog
   */
  async discover({ force = false } = {}) {
    if (!this.quiet) console.log('Starting runtime discovery...');

    const loaded = await this.#loadCatalog().catch(error => {
      if (error instanceof SyntaxError) return null;
      throw error;
    });
    const previous = Array.isArray(loaded?.tools) ? loaded : null;
    const paths = new Map();
    const inputs = [];
    for (const name of this.#safeTools()) {
      const toolPath = await this.#findToolPath(name);
      paths.set(name, toolPath);
      const metadata = toolPath ? await stat(toolPath).catch(() => null) : null;
      inputs.push([name, toolPath, metadata && [metadata.mtimeMs, metadata.ctimeMs, metadata.size, metadata.mode]]);
    }
    const inputFingerprint = createHash('sha256').update(JSON.stringify([
      1, this.knownTools, inputs, platform(), arch(), homedir(), this.cwd,
      process.env.PATH, process.env.PATHEXT, process.env.SHELL, process.env.ComSpec,
    ])).digest('hex');
    if (!force && previous?.inputFingerprint === inputFingerprint
      && existsSync(join(this.basePath, 'runtime-info.md'))) {
      if (!this.quiet) console.log(`Discovery skipped: unchanged (${previous.tools.length} tools)`);
      return previous;
    }

    const environment = await this.getEnvironment();
    const resources = await this.getResources();
    const tools = await this.#discoverTools(paths);
    const previousIds = new Set((previous?.tools || []).map(tool => tool.id));
    const currentIds = new Set(tools.available.map(tool => tool.id));
    const delta = {
      added: [...currentIds].filter(id => !previousIds.has(id)),
      removed: [...previousIds].filter(id => !currentIds.has(id)),
    };

    const catalog = {
      $schema: 'https://aiwg.io/schemas/toolsmith/runtime-catalog-v1.json',
      version: '1.0',
      generated: new Date().toISOString(),
      inputFingerprint,
      delta,
      environment,
      resources,
      tools: tools.available,
      unavailable: tools.unavailable
    };

    // Write catalog
    await this.#writeCatalog(catalog);
    await this.#writeRuntimeInfo(catalog);

    if (!this.quiet) console.log(`Discovery complete: ${catalog.tools.length} tools found`);
    if (!this.quiet) console.log(`Tool delta: +${delta.added.length} added, -${delta.removed.length} removed`);
    if (delta.removed.length) {
      if (!this.quiet) console.warn(`Previously cataloged tools no longer available: ${delta.removed.join(', ')}`);
    }
    return catalog;
  }

  /**
   * Verify existing catalog is still accurate
   * @returns {Promise<Object>} VerificationResult
   */
  async verify() {
    const catalog = await this.#loadCatalog();

    if (!catalog) {
      throw new Error('No catalog found. Run discovery first.');
    }

    const results = {
      valid: 0,
      total: catalog.tools.length,
      failed: [],
      timestamp: new Date().toISOString()
    };

    for (const tool of catalog.tools) {
      const check = await this.checkTool(tool.id);

      if (check.available && check.version === tool.version) {
        results.valid++;
      } else {
        results.failed.push(tool);
      }
    }

    return results;
  }

  /**
   * Check a specific tool
   * @param {string} toolName
   * @returns {Promise<Object>} ToolCheckResult
   */
  async checkTool(toolName) {
    const toolPath = await this.#findToolPath(toolName);

    if (!toolPath) {
      return {
        id: toolName,
        available: false,
        installHint: this.#getInstallHint(toolName)
      };
    }

    const version = await this.#detectToolVersion(toolName, toolPath);

    return {
      id: toolName,
      available: true,
      version,
      path: toolPath,
      status: 'verified',
      lastVerified: new Date().toISOString()
    };
  }

  /**
   * Get environment information
   * @returns {Promise<Object>} EnvironmentInfo
   */
  async getEnvironment() {
    const os = platform();
    let osVersion = 'Unknown';

    try {
      if (os === 'linux') {
        // Check for WSL
        if (existsSync('/proc/version')) {
          const version = await readFile('/proc/version', 'utf-8');
          if (version.includes('microsoft') || version.includes('WSL')) {
            osVersion = 'WSL';
          } else {
            // Try to get Linux distribution info
            if (existsSync('/etc/os-release')) {
              const osRelease = await readFile('/etc/os-release', 'utf-8');
              const match = osRelease.match(/PRETTY_NAME="([^"]+)"/);
              if (match) osVersion = match[1];
            }
          }
        }
      } else if (os === 'darwin') {
        const version = boundedExecFileSync('sw_vers', ['-productVersion'], 'quick', { encoding: 'utf-8' }).trim();
        osVersion = `macOS ${version}`;
      } else if (os === 'win32') {
        osVersion = boundedExecSync('ver', 'quick', { encoding: 'utf-8' }).trim();
      }
    } catch (error) {
      if (!this.quiet) console.warn('Could not detect OS version:', error.message);
    }

    return {
      os,
      osVersion,
      arch: arch(),
      shell: process.env.SHELL || process.env.ComSpec || '/bin/sh',
      homeDir: homedir(),
      workingDir: this.cwd
    };
  }

  /**
   * Get resource information (disk, memory, cpu)
   * @returns {Promise<Object>} ResourceInfo
   */
  async getResources() {
    let diskFreeGb = 0;
    let memoryTotalGb = 0;
    let memoryAvailableGb = 0;

    try {
      // Disk space
      if (platform() === 'win32') {
        // Windows: use wmic
        const output = boundedExecFileSync('wmic', ['logicaldisk', 'get', 'size,freespace'], 'quick', { encoding: 'utf-8' });
        const lines = output.trim().split('\n').slice(1);
        let totalFree = 0;
        for (const line of lines) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2) {
            totalFree += parseInt(parts[0]) || 0;
          }
        }
        diskFreeGb = Math.round((totalFree / (1024 ** 3)) * 10) / 10;
      } else {
        // Unix: use df
        const output = boundedExecFileSync('df', ['-k', '.'], 'quick', { encoding: 'utf-8', cwd: this.cwd });
        const lines = output.trim().split('\n');
        if (lines.length > 1) {
          const parts = lines[1].trim().split(/\s+/);
          const availableKb = parseInt(parts[3]) || 0;
          diskFreeGb = Math.round((availableKb / (1024 ** 2)) * 10) / 10;
        }
      }

      // Memory (from os module)
      const totalMem = totalmem();
      const freeMem = freemem();
      memoryTotalGb = Math.round((totalMem / (1024 ** 3)) * 10) / 10;
      memoryAvailableGb = Math.round((freeMem / (1024 ** 3)) * 10) / 10;
    } catch (error) {
      if (!this.quiet) console.warn('Could not get resource info:', error.message);
    }

    return {
      diskFreeGb,
      memoryTotalGb,
      memoryAvailableGb,
      cpuCores: cpus().length
    };
  }

  /**
   * Get runtime summary for display
   * @returns {Promise<Object>} RuntimeSummary
   */
  async getSummary() {
    const catalog = await this.#loadCatalog();

    if (!catalog) {
      throw new Error('No catalog found. Run discovery first.');
    }

    const toolCounts = {
      core: 0,
      languages: 0,
      utilities: 0,
      custom: 0
    };

    for (const tool of catalog.tools) {
      toolCounts[tool.category]++;
    }

    return {
      environment: catalog.environment,
      resources: catalog.resources,
      toolCounts,
      totalTools: catalog.tools.length,
      lastDiscovery: catalog.generated,
      catalogPath: join(this.basePath, 'runtime.json')
    };
  }

  /**
   * Add a custom tool to the catalog
   * @param {Object} config - CustomToolConfig
   */
  async addCustomTool(config) {
    const catalog = await this.#loadCatalog();

    if (!catalog) {
      throw new Error('No catalog found. Run discovery first.');
    }

    // Check if tool exists
    const check = await this.checkTool(config.id);
    if (!check.available) {
      throw new Error(`Tool ${config.id} not found at ${config.path}`);
    }

    const customTool = {
      id: config.id,
      name: config.name,
      category: config.category,
      version: check.version || 'unknown',
      path: config.path,
      status: 'verified',
      lastVerified: new Date().toISOString(),
      capabilities: config.capabilities,
      documentation: config.documentation,
      aliases: config.aliases || [],
      relatedTools: []
    };

    // Add or update tool
    const existingIndex = catalog.tools.findIndex(t => t.id === config.id);
    if (existingIndex >= 0) {
      catalog.tools[existingIndex] = customTool;
    } else {
      catalog.tools.push(customTool);
    }

    await this.#writeCatalog(catalog);
  }

  // Private methods

  /**
   * Discover tools using allowlist-only approach.
   *
   * SAFETY: Only probes tools from the knownTools database plus a curated
   * discovery list. Never enumerates or blindly executes arbitrary PATH
   * executables — doing so can crash privileged system tools (BPF, saned),
   * trigger rogue network connections (input-leapc), or overwhelm
   * apport/systemd with crash reports.
   *
   * @see https://git.integrolabs.net/roctinam/aiwg/issues/820
   * @private
   */
  #safeTools() {
    // Curated list: knownTools database + common dev tools safe to probe
    return new Set([
      // From knownTools database
      ...Object.keys(this.knownTools),
      // Aliases from knownTools
      ...Object.values(this.knownTools).flatMap(t => t.aliases || []),
      // Additional safe dev tools not yet in knownTools
      'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno',
      'pip', 'pip3', 'pipx', 'uv',
      'ruby', 'gem', 'go', 'cargo', 'rustc', 'rustup',
      'java', 'javac', 'mvn', 'gradle',
      'make', 'cmake', 'gcc', 'g++', 'clang',
      'bash', 'zsh', 'fish', 'sh',
      'grep', 'sed', 'awk', 'find', 'xargs',
      'tar', 'gzip', 'unzip', 'zip',
      'ssh', 'scp', 'rsync',
      'wget', 'httpie',
      'vim', 'nvim', 'nano', 'code',
      'tmux', 'screen',
      'ag', 'fd', 'fzf', 'bat', 'exa', 'eza', 'delta',
      'terraform', 'kubectl', 'helm', 'podman',
      'sqlite3', 'psql', 'mysql', 'mongosh', 'redis-cli',
      'gh', 'git-lfs', 'hub', 'lab',
      'aws', 'az', 'gcloud',
      'ffmpeg', 'ffprobe', 'convert', 'magick',
      'pandoc', 'latex', 'pdflatex',
      'yq', 'fx', 'miller',
      'htop', 'ncdu', 'dust', 'procs', 'tokei',
    ]);
  }

  async #discoverTools(paths) {
    const available = [];
    const unavailable = [];

    for (const [name, toolPath] of paths) {
      if (!toolPath) {
        // Not installed — skip silently (not an error)
        continue;
      }

      try {
        const version = await this.#detectToolVersion(name, toolPath);
        const tool = await this.#categorizeTool(name, toolPath, version);

        if (tool) {
          available.push(tool);
        }
      } catch (error) {
        unavailable.push({
          id: name,
          reason: 'broken',
          installHint: error.message
        });
      }
    }

    return { available, unavailable };
  }

  /**
   * Search PATH first, then common user installation directories on Unix.
   * @private
   */
  async #findToolPath(toolName) {
    try {
      const cmd = platform() === 'win32' ? 'where' : 'which';
      const path = boundedExecFileSync(cmd, [toolName], 'quick', { encoding: 'utf-8' })
        .trim()
        .split('\n')[0];
      return path;
    } catch {
      // Scheduled jobs often omit user installation directories from PATH.
    }
    if (platform() !== 'win32' && !toolName.includes('/') && !toolName.includes('\\')) {
      const home = homedir();
      const directories = new Set([
        join(process.env.CARGO_HOME || join(home, '.cargo'), 'bin'),
        join(home, '.local', 'bin'), join(home, 'bin'),
        join(home, '.npm-global', 'bin'), join(home, 'go', 'bin'),
        join(home, '.bun', 'bin'), join(home, '.deno', 'bin'),
      ]);
      for (const directory of directories) {
        const candidate = join(directory, toolName);
        try {
          await access(candidate, constants.X_OK);
          if ((await stat(candidate)).isFile()) return candidate;
        } catch {
          // Continue to the next user directory.
        }
      }
    }
    return null;
  }

  /**
   * Detect tool version using safe command variants only.
   *
   * SAFETY: Only uses flag-style arguments (--version, -v, -V).
   * Never uses bare positional `version` — many tools interpret
   * positional args as filenames, hostnames, or operational parameters,
   * causing crashes, rogue connections, or kernel tracepoint attachment.
   *
   * Uses a 3-second timeout with SIGKILL to prevent tools that spawn
   * persistent background work from outliving the probe.
   *
   * @see https://git.integrolabs.net/roctinam/aiwg/issues/820
   * @private
   */
  async #detectToolVersion(toolName, toolPath) {
    // Only flag-style version args — safe for well-behaved tools.
    // Bare `version` (positional) is intentionally excluded: it caused
    // BPF tools to attach tracepoints, input-leapc to connect to
    // hostname "version", and cs2cs to open a file named "version".
    const versionArgs = ['--version', '-v', '-V'];

    for (const arg of versionArgs) {
      try {
        const output = boundedExecFileSync(toolPath, [arg], 'quick', {
          encoding: 'utf-8',
          timeout: 3000,
          killSignal: 'SIGKILL',
          stdio: ['ignore', 'pipe', 'pipe']
        }).trim();

        // Extract version number
        const version = this.#parseVersion(output, toolName);
        if (version) return version;
      } catch {
        // Try next command
      }
    }

    return 'unknown';
  }

  /**
   * Parse version from output
   * @private
   */
  #parseVersion(output, toolName) {
    // Try known pattern first
    const knownTool = this.knownTools[toolName];
    if (knownTool && knownTool.versionPattern) {
      const regex = new RegExp(knownTool.versionPattern);
      const match = output.match(regex);
      if (match && match[1]) return match[1];
    }

    // Generic version pattern
    const patterns = [
      /version\s+([0-9]+\.[0-9]+\.[0-9]+)/i,
      /v([0-9]+\.[0-9]+\.[0-9]+)/i,
      /([0-9]+\.[0-9]+\.[0-9]+)/,
      /([0-9]+\.[0-9]+)/
    ];

    for (const pattern of patterns) {
      const match = output.match(pattern);
      if (match && match[1]) return match[1];
    }

    return null;
  }

  /**
   * Categorize and enrich tool
   * @private
   */
  async #categorizeTool(name, path, version) {
    const knownTool = this.knownTools[name];

    let category = 'utilities';
    let capabilities = [];
    let documentation = '';
    let aliases = [];
    let relatedTools = [];

    if (knownTool) {
      category = knownTool.category;
      capabilities = knownTool.capabilities;
      documentation = knownTool.documentation || '';
      aliases = knownTool.aliases;
      relatedTools = knownTool.relatedTools;
    } else {
      // Infer category from name
      if (['git', 'bash', 'sh', 'curl', 'ssh', 'grep', 'sed', 'awk'].includes(name)) {
        category = 'core';
      } else if (['node', 'python', 'python3', 'ruby', 'go', 'java', 'javac', 'rustc'].includes(name)) {
        category = 'languages';
      }
    }

    // Find man page
    const manPage = await this.#findManPage(name);

    return {
      id: name,
      name,
      category,
      version,
      path,
      status: 'verified',
      lastVerified: new Date().toISOString(),
      capabilities,
      manPage,
      documentation,
      aliases,
      relatedTools
    };
  }

  /**
   * Find man page for tool
   * @private
   */
  async #findManPage(toolName) {
    if (platform() === 'win32') return undefined;

    try {
      const manPath = boundedExecFileSync('man', ['-w', toolName], 'quick', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();

      if (manPath && existsSync(manPath)) {
        return manPath;
      }
    } catch {
      // No man page found
    }

    return undefined;
  }

  /**
   * Get install hint for tool
   * @private
   */
  #getInstallHint(toolId) {
    const os = platform();
    const hints = {
      linux: {
        jq: 'apt install jq  # or dnf install jq',
        ripgrep: 'apt install ripgrep  # or cargo install ripgrep',
        docker: 'apt install docker.io  # or follow docker.com/get-started'
      },
      darwin: {
        jq: 'brew install jq',
        ripgrep: 'brew install ripgrep',
        docker: 'brew install --cask docker'
      },
      win32: {
        jq: 'choco install jq  # or scoop install jq',
        ripgrep: 'choco install ripgrep',
        docker: 'choco install docker-desktop'
      }
    };

    return hints[os]?.[toolId] || `Install ${toolId} for your system`;
  }

  /**
   * Load known tools database
   * @private
   */
  #loadKnownTools() {
    // Simplified inline database for Phase 1
    // Full database can be loaded from JSON file later
    return {
      git: {
        category: 'core',
        capabilities: ['version-control', 'remote', 'branching', 'merging'],
        documentation: 'https://git-scm.com/docs',
        aliases: ['g'],
        relatedTools: ['gh', 'git-lfs'],
        versionPattern: 'git version ([\\d.]+)',
        examples: []
      },
      jq: {
        category: 'utilities',
        capabilities: ['json-processing', 'filtering', 'transformation'],
        documentation: 'https://stedolan.github.io/jq/manual/',
        aliases: [],
        relatedTools: ['yq', 'fx'],
        versionPattern: 'jq-([\\d.]+)',
        examples: []
      },
      node: {
        category: 'languages',
        capabilities: ['javascript', 'runtime'],
        documentation: 'https://nodejs.org/docs/',
        aliases: ['nodejs'],
        relatedTools: ['npm', 'npx'],
        versionPattern: 'v([\\d.]+)',
        examples: []
      },
      python: {
        category: 'languages',
        capabilities: ['python', 'runtime'],
        documentation: 'https://docs.python.org/',
        aliases: ['python3'],
        relatedTools: ['pip', 'pip3'],
        versionPattern: 'Python ([\\d.]+)',
        examples: []
      },
      curl: {
        category: 'core',
        capabilities: ['http-client', 'download', 'api-testing'],
        documentation: 'https://curl.se/docs/',
        aliases: [],
        relatedTools: ['wget', 'httpie'],
        versionPattern: 'curl ([\\d.]+)',
        examples: []
      },
      docker: {
        category: 'utilities',
        capabilities: ['containers', 'virtualization'],
        documentation: 'https://docs.docker.com/',
        aliases: [],
        relatedTools: ['docker-compose', 'podman'],
        versionPattern: 'Docker version ([\\d.]+)',
        examples: []
      },
      ripgrep: {
        category: 'utilities',
        capabilities: ['search', 'grep', 'regex'],
        documentation: 'https://github.com/BurntSushi/ripgrep',
        aliases: ['rg'],
        relatedTools: ['grep', 'ag'],
        versionPattern: 'ripgrep ([\\d.]+)',
        examples: []
      }
    };
  }

  /**
   * Load catalog from file
   * @private
   */
  async #loadCatalog() {
    const catalogPath = join(this.basePath, 'runtime.json');

    if (!existsSync(catalogPath)) {
      return null;
    }

    const content = await readFile(catalogPath, 'utf-8');
    return JSON.parse(content);
  }

  /**
   * Write catalog to file
   * @private
   */
  async #writeCatalog(catalog) {
    const catalogPath = join(this.basePath, 'runtime.json');
    // #1264(b): ensure parent dir exists; first --discover on a fresh project
    // otherwise fails with ENOENT before any catalog write.
    await mkdir(this.basePath, { recursive: true });
    await writeFile(catalogPath, JSON.stringify(catalog, null, 2), 'utf-8');
  }

  /**
   * Write human-readable runtime info
   * @private
   */
  async #writeRuntimeInfo(catalog) {
    const lines = [
      '# Runtime Environment Summary',
      '',
      '## Environment',
      '',
      `- **OS**: ${catalog.environment.os} (${catalog.environment.osVersion}) ${catalog.environment.arch}`,
      `- **Shell**: ${catalog.environment.shell}`,
      `- **Home**: ${catalog.environment.homeDir}`,
      `- **Working Directory**: ${catalog.environment.workingDir}`,
      '',
      '## Resources',
      '',
      `- **Disk Free**: ${catalog.resources.diskFreeGb} GB`,
      `- **Memory**: ${catalog.resources.memoryAvailableGb} GB available / ${catalog.resources.memoryTotalGb} GB total`,
      `- **CPU Cores**: ${catalog.resources.cpuCores}`,
      '',
      '## Installed Tools',
      ''
    ];

    const byCategory = {
      core: [],
      languages: [],
      utilities: [],
      custom: []
    };

    for (const tool of catalog.tools) {
      byCategory[tool.category].push(tool);
    }

    for (const [category, tools] of Object.entries(byCategory)) {
      if (tools.length > 0) {
        lines.push(`### ${category.charAt(0).toUpperCase() + category.slice(1)}`);
        lines.push('');

        for (const tool of tools) {
          lines.push(`- **${tool.name}** (${tool.version}) - ${tool.path}`);
          if (tool.capabilities.length > 0) {
            lines.push(`  - Capabilities: ${tool.capabilities.join(', ')}`);
          }
        }

        lines.push('');
      }
    }

    lines.push('## Summary');
    lines.push('');
    lines.push(`- **Total Tools**: ${catalog.tools.length}`);
    lines.push(`- **Unavailable**: ${catalog.unavailable.length}`);
    lines.push(`- **Generated**: ${catalog.generated}`);
    lines.push(`- **Catalog**: ${join(this.basePath, 'runtime.json')}`);

    const infoPath = join(this.basePath, 'runtime-info.md');
    await writeFile(infoPath, lines.join('\n'), 'utf-8');
  }
}
