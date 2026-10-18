/**
 * Artifact Index Builder Tests
 *
 * @source @src/artifacts/index-builder.ts
 * @implements #415
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { parseFrontmatter, extractMentions, extractMarkdownLinks, buildIndex, normalizeNamedCaptures, buildFilenameMetadataEntry } from '../../../src/artifacts/index-builder.js';
import { INDEX_DIR, GRAPH_CONFIGS, loadUserGraphConfigs, loadModuleGraphConfigs, loadGlobalGraphConfigs, normalizeEdge, normalizeEdges, getGraphIndexDir } from '../../../src/artifacts/types.js';
import type { TypedEdge, DependencyGraph } from '../../../src/artifacts/types.js';
import { itWithSqlite, sqliteAvailable } from '../../helpers/sqlite.js';

describe('loadUserGraphConfigs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-graphs-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Clean up any user-defined graphs added to GRAPH_CONFIGS
    for (const key of Object.keys(GRAPH_CONFIGS)) {
      if (!['framework', 'project', 'codebase', 'source', 'user'].includes(key)) {
        delete GRAPH_CONFIGS[key];
      }
    }
  });

  it('should load user-defined graphs from .aiwg/config.yaml', () => {
    const aiwgDir = path.join(tmpDir, '.aiwg');
    fs.mkdirSync(aiwgDir, { recursive: true });
    fs.writeFileSync(path.join(aiwgDir, 'config.yaml'), `
index:
  graphs:
    references:
      scanDirs:
        - documentation/references
      extensions:
        - .md
      defaultBuild: false
`);

    const loaded = loadUserGraphConfigs(tmpDir);

    expect(loaded).toContain('references');
    expect(GRAPH_CONFIGS['references']).toBeDefined();
    expect(GRAPH_CONFIGS['references'].scanDirs).toEqual(['documentation/references']);
    expect(GRAPH_CONFIGS['references'].extensions).toEqual(['.md']);
    expect(GRAPH_CONFIGS['references'].defaultBuild).toBe(false);
  });

  it('should not override built-in graph names', () => {
    const aiwgDir = path.join(tmpDir, '.aiwg');
    fs.mkdirSync(aiwgDir, { recursive: true });
    fs.writeFileSync(path.join(aiwgDir, 'config.yaml'), `
index:
  graphs:
    project:
      scanDirs:
        - custom-dir
`);

    loadUserGraphConfigs(tmpDir);

    // project should still point to .aiwg, not custom-dir
    expect(GRAPH_CONFIGS['project'].scanDirs).toEqual(['.aiwg']);
  });

  it('should return empty array when config.yaml does not exist', () => {
    const loaded = loadUserGraphConfigs(tmpDir);
    expect(loaded).toEqual([]);
  });

  it('should load user-defined graphs from the local control config when the corpus is external', () => {
    const artifactRoot = path.join(tmpDir, 'private-corpus', '.aiwg');
    fs.mkdirSync(artifactRoot, { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.aiwg'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.aiwg-location'), 'private-corpus/.aiwg\n');
    fs.writeFileSync(path.join(tmpDir, '.aiwg', 'aiwg.config'), JSON.stringify({
      index: {
        graphs: {
          references: {
            scanDirs: ['documentation/references'],
            extensions: ['.md'],
            defaultBuild: false,
          },
        },
      },
    }));

    const loaded = loadUserGraphConfigs(tmpDir);

    expect(loaded).toContain('references');
    expect(GRAPH_CONFIGS['references'].scanDirs).toEqual(['documentation/references']);
  });
});

describe('loadModuleGraphConfigs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-module-graphs-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const key of Object.keys(GRAPH_CONFIGS)) {
      if (!['framework', 'project', 'codebase', 'source', 'user'].includes(key)) {
        delete GRAPH_CONFIGS[key];
      }
    }
  });

  it('should load graph declarations from framework manifest.json', () => {
    // Create registry
    const registryDir = path.join(tmpDir, '.aiwg', 'frameworks');
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(registryDir, 'registry.json'), JSON.stringify({
      version: '1.0.0',
      frameworks: [{ id: 'research-complete', installed: '2026-01-01', version: '1.0.0' }],
    }));

    // Create framework manifest with graph declarations
    const frameworkDir = path.join(tmpDir, 'agentic', 'code', 'frameworks', 'research-complete');
    fs.mkdirSync(frameworkDir, { recursive: true });
    fs.writeFileSync(path.join(frameworkDir, 'manifest.json'), JSON.stringify({
      id: 'research-complete',
      type: 'framework',
      index: {
        graphs: {
          papers: {
            scanDirs: ['pdfs/full'],
            extensions: ['.pdf'],
            nodeStrategy: 'filename-metadata',
            defaultBuild: true,
          },
          'citation-network': {
            scanDirs: ['documentation/citations'],
            extensions: ['.md'],
            edgeExtraction: { parser: 'citation-sidecar', edges: [] },
            defaultBuild: true,
          },
        },
      },
    }));

    const loaded = loadModuleGraphConfigs(tmpDir);

    expect(loaded).toContain('papers');
    expect(loaded).toContain('citation-network');
    expect(GRAPH_CONFIGS['papers']).toBeDefined();
    expect(GRAPH_CONFIGS['papers'].scanDirs).toEqual(['pdfs/full']);
    expect(GRAPH_CONFIGS['papers'].extensions).toEqual(['.pdf']);
    expect(GRAPH_CONFIGS['papers'].nodeStrategy).toBe('filename-metadata');
    expect(GRAPH_CONFIGS['citation-network']).toBeDefined();
    expect(GRAPH_CONFIGS['citation-network'].edgeExtraction?.parser).toBe('citation-sidecar');
  });

  it('should not override built-in graph names from manifests', () => {
    const registryDir = path.join(tmpDir, '.aiwg', 'frameworks');
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(registryDir, 'registry.json'), JSON.stringify({
      version: '1.0.0',
      frameworks: [{ id: 'evil-framework' }],
    }));

    const frameworkDir = path.join(tmpDir, 'agentic', 'code', 'frameworks', 'evil-framework');
    fs.mkdirSync(frameworkDir, { recursive: true });
    fs.writeFileSync(path.join(frameworkDir, 'manifest.json'), JSON.stringify({
      id: 'evil-framework',
      index: { graphs: { project: { scanDirs: ['hacked'] } } },
    }));

    loadModuleGraphConfigs(tmpDir);

    expect(GRAPH_CONFIGS['project'].scanDirs).toEqual(['.aiwg']);
  });

  it('should return empty when registry does not exist', () => {
    const loaded = loadModuleGraphConfigs(tmpDir);
    expect(loaded).toEqual([]);
  });

  it('should skip frameworks with no manifest', () => {
    const registryDir = path.join(tmpDir, '.aiwg', 'frameworks');
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(registryDir, 'registry.json'), JSON.stringify({
      version: '1.0.0',
      frameworks: [{ id: 'ghost-framework' }],
    }));

    const loaded = loadModuleGraphConfigs(tmpDir);
    expect(loaded).toEqual([]);
  });

  it('should load module graph declarations from the configured artifact root registry', () => {
    const artifactRoot = path.join(tmpDir, 'private-corpus', '.aiwg');
    const registryDir = path.join(artifactRoot, 'frameworks');
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.aiwg-location'), 'private-corpus/.aiwg\n');
    fs.writeFileSync(path.join(registryDir, 'registry.json'), JSON.stringify({
      version: '1.0.0',
      frameworks: [{ id: 'relocated-framework' }],
    }));

    const frameworkDir = path.join(tmpDir, 'agentic', 'code', 'frameworks', 'relocated-framework');
    fs.mkdirSync(frameworkDir, { recursive: true });
    fs.writeFileSync(path.join(frameworkDir, 'manifest.json'), JSON.stringify({
      id: 'relocated-framework',
      index: {
        graphs: {
          'relocated-docs': { scanDirs: ['docs/relocated'], extensions: ['.md'] },
        },
      },
    }));

    const loaded = loadModuleGraphConfigs(tmpDir);

    expect(loaded).toContain('relocated-docs');
    expect(GRAPH_CONFIGS['relocated-docs'].scanDirs).toEqual(['docs/relocated']);
  });

  it('should also check addons directory', () => {
    const registryDir = path.join(tmpDir, '.aiwg', 'frameworks');
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(registryDir, 'registry.json'), JSON.stringify({
      version: '1.0.0',
      frameworks: [{ id: 'my-addon' }],
    }));

    const addonDir = path.join(tmpDir, 'agentic', 'code', 'addons', 'my-addon');
    fs.mkdirSync(addonDir, { recursive: true });
    fs.writeFileSync(path.join(addonDir, 'manifest.json'), JSON.stringify({
      id: 'my-addon',
      type: 'addon',
      index: {
        graphs: {
          'addon-graph': { scanDirs: ['addon-data'], extensions: ['.csv'] },
        },
      },
    }));

    const loaded = loadModuleGraphConfigs(tmpDir);
    expect(loaded).toContain('addon-graph');
    expect(GRAPH_CONFIGS['addon-graph'].scanDirs).toEqual(['addon-data']);
  });
});

describe('loadUserGraphConfigs with module graphs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-combined-graphs-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const key of Object.keys(GRAPH_CONFIGS)) {
      if (!['framework', 'project', 'codebase', 'source', 'user'].includes(key)) {
        delete GRAPH_CONFIGS[key];
      }
    }
  });

  it('should let operator config.yaml override module-declared graphs', () => {
    // Create module graph
    const registryDir = path.join(tmpDir, '.aiwg', 'frameworks');
    fs.mkdirSync(registryDir, { recursive: true });
    fs.writeFileSync(path.join(registryDir, 'registry.json'), JSON.stringify({
      version: '1.0.0',
      frameworks: [{ id: 'research-complete' }],
    }));

    const frameworkDir = path.join(tmpDir, 'agentic', 'code', 'frameworks', 'research-complete');
    fs.mkdirSync(frameworkDir, { recursive: true });
    fs.writeFileSync(path.join(frameworkDir, 'manifest.json'), JSON.stringify({
      id: 'research-complete',
      index: {
        graphs: {
          papers: { scanDirs: ['pdfs/full'], extensions: ['.pdf'], defaultBuild: true },
        },
      },
    }));

    // Create operator override
    fs.writeFileSync(path.join(tmpDir, '.aiwg', 'config.yaml'), `
index:
  graphs:
    papers:
      scanDirs:
        - my/custom/pdfs
      extensions:
        - .pdf
`);

    const loaded = loadUserGraphConfigs(tmpDir);

    expect(loaded).toContain('papers');
    // Operator config wins over module config
    expect(GRAPH_CONFIGS['papers'].scanDirs).toEqual(['my/custom/pdfs']);
  });
});

describe('loadGlobalGraphConfigs', () => {
  let tmpDir: string;
  let prevHome: string | undefined;
  let prevXdg: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-global-graphs-test-'));
    prevHome = process.env.HOME;
    prevXdg = process.env.XDG_DATA_HOME;
    process.env.HOME = path.join(tmpDir, 'home');
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'xdg');
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const key of Object.keys(GRAPH_CONFIGS)) {
      if (!['framework', 'project', 'codebase', 'source', 'user'].includes(key)) {
        delete GRAPH_CONFIGS[key];
      }
    }
  });

  it('loads and builds named user-level graphs from ~/.aiwg/aiwg.config', async () => {
    const homeAiwg = path.join(process.env.HOME!, '.aiwg');
    fs.mkdirSync(path.join(homeAiwg, 'indices', 'personal'), { recursive: true });
    fs.mkdirSync(path.join(homeAiwg, 'indices', 'org'), { recursive: true });
    fs.writeFileSync(path.join(homeAiwg, 'indices', 'personal', 'note.md'), '# Personal Index\n\nReusable note.\n');
    fs.writeFileSync(path.join(homeAiwg, 'indices', 'org', 'runbook.md'), '# Org Runbook\n\nReusable runbook.\n');
    fs.writeFileSync(path.join(homeAiwg, 'aiwg.config'), JSON.stringify({
      version: '1',
      indices: {
        user: {
          enabled: true,
          roots: {
            org: {
              path: '~/.aiwg/indices/org',
              backend: 'local',
            },
          },
        },
      },
      index: {
        graphs: {
          personal: {
            scanDirs: ['~/.aiwg/indices/personal'],
            extensions: ['.md'],
            defaultBuild: false,
          },
        },
      },
    }));

    const loaded = loadGlobalGraphConfigs();
    expect(loaded).toContain('personal');
    expect(loaded).toContain('org');
    expect(GRAPH_CONFIGS.personal.shared).toBe(true);
    expect(GRAPH_CONFIGS.org.shared).toBe(true);

    const projectDir = path.join(tmpDir, 'project');
    fs.mkdirSync(projectDir, { recursive: true });
    await buildIndex(projectDir, { graph: 'personal', force: true });
    const graphDir = getGraphIndexDir(projectDir, 'personal');
    expect(graphDir).toBe(path.join(process.env.XDG_DATA_HOME!, 'aiwg', 'index', 'personal'));
    const metadata = JSON.parse(fs.readFileSync(path.join(graphDir, 'metadata.json'), 'utf-8'));
    expect(Object.keys(metadata.entries)).toEqual([
      path.join(process.env.HOME!, '.aiwg', 'indices', 'personal', 'note.md'),
    ]);

    await buildIndex(projectDir, { graph: 'org', force: true });
    const orgDir = getGraphIndexDir(projectDir, 'org');
    const orgMetadata = JSON.parse(fs.readFileSync(path.join(orgDir, 'metadata.json'), 'utf-8'));
    expect(Object.keys(orgMetadata.entries)).toEqual([
      path.join(process.env.HOME!, '.aiwg', 'indices', 'org', 'runbook.md'),
    ]);
  });
});

describe('getGraphIndexDir', () => {
  let tmpDir: string;
  let prevHome: string | undefined;
  let prevXdg: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-graph-index-dir-test-'));
    prevHome = process.env.HOME;
    prevXdg = process.env.XDG_DATA_HOME;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('uses os.homedir when HOME and XDG_DATA_HOME are unset (#132)', () => {
    delete process.env.HOME;
    delete process.env.XDG_DATA_HOME;

    expect(getGraphIndexDir(tmpDir, 'framework')).toBe(
      path.join(os.homedir(), '.local', 'share', 'aiwg', 'index', 'framework'),
    );
    expect(getGraphIndexDir(tmpDir, 'framework')).not.toContain('undefined');
  });

  it('preserves an explicit XDG_DATA_HOME', () => {
    process.env.XDG_DATA_HOME = path.join(tmpDir, 'xdg-data');

    expect(getGraphIndexDir(tmpDir, 'framework')).toBe(
      path.join(tmpDir, 'xdg-data', 'aiwg', 'index', 'framework'),
    );
  });
});

describe('Artifact Index Builder', () => {
  describe('parseFrontmatter', () => {
    it('should parse valid YAML frontmatter', () => {
      const content = `---
title: Test Document
type: use-case
tags:
  - auth
  - security
---
# Test

Body content here.`;
      const result = parseFrontmatter(content);
      expect(result.data.title).toBe('Test Document');
      expect(result.data.type).toBe('use-case');
      expect(result.data.tags).toEqual(['auth', 'security']);
      expect(result.body).toContain('# Test');
    });

    it('should return empty data for content without frontmatter', () => {
      const content = '# Just a heading\n\nSome content.';
      const result = parseFrontmatter(content);
      expect(result.data).toEqual({});
      expect(result.body).toBe(content);
    });

    it('should handle malformed YAML gracefully', () => {
      const content = `---
invalid: yaml: [broken
---
# Body`;
      const result = parseFrontmatter(content);
      expect(result.data).toEqual({});
    });

    it('should handle empty frontmatter', () => {
      const content = `---
---
# Body`;
      const result = parseFrontmatter(content);
      expect(result.data).toEqual({});
      expect(result.body).toContain('# Body');
    });
  });

  describe('extractMentions', () => {
    it('should extract @-mention file references', () => {
      const content = `
See @src/artifacts/types.ts for type definitions.
Also references @.aiwg/requirements/UC-001.md and @.aiwg/architecture/sad.md
`;
      const mentions = extractMentions(content);
      expect(mentions).toContain('src/artifacts/types.ts');
      expect(mentions).toContain('.aiwg/requirements/UC-001.md');
      expect(mentions).toContain('.aiwg/architecture/sad.md');
    });

    it('should deduplicate mentions', () => {
      const content = `
Ref @src/foo.ts and also @src/foo.ts again.
`;
      const mentions = extractMentions(content);
      const fooCount = mentions.filter(m => m === 'src/foo.ts').length;
      expect(fooCount).toBe(1);
    });

    it('should return empty array for content without mentions', () => {
      const content = 'No mentions here.';
      const mentions = extractMentions(content);
      expect(mentions).toEqual([]);
    });

    it('normalizes $AIWG_ROOT framework references to repo-relative paths', () => {
      const content = `
References:
- @$AIWG_ROOT/agentic/code/frameworks/forensics-complete/rules/evidence-integrity.md
- @$AIWG_ROOT/agentic/code/addons/aiwg-utils/rules/human-authorization.md
`;
      const mentions = extractMentions(content);
      expect(mentions).toContain('agentic/code/frameworks/forensics-complete/rules/evidence-integrity.md');
      expect(mentions).toContain('agentic/code/addons/aiwg-utils/rules/human-authorization.md');
    });
  });

  describe('extractMarkdownLinks', () => {
    it('extracts relative Markdown links and excludes external, anchor-only, and image links', () => {
      const content = `
[target](./target.md)
[parent](../parent.md#section)
[external](https://example.test/doc.md)
[anchor](#local)
![image](./target.md)
`;
      expect(extractMarkdownLinks(content)).toEqual(['./target.md', '../parent.md']);
    });
  });

  describe('buildIndex', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-index-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should build index from .aiwg/ directory', async () => {
      // Create test artifacts
      const aiwgDir = path.join(tmpDir, '.aiwg', 'requirements');
      fs.mkdirSync(aiwgDir, { recursive: true });

      fs.writeFileSync(path.join(aiwgDir, 'UC-001.md'), `---
title: User Login
type: use-case
tags:
  - auth
  - security
---
# UC-001: User Login

Users can log in with email and password.
`);

      fs.writeFileSync(path.join(aiwgDir, 'UC-002.md'), `---
title: User Registration
type: use-case
tags:
  - auth
---
# UC-002: User Registration

New users can register.

@.aiwg/requirements/UC-001.md
`);

      // Suppress console output during build
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await buildIndex(tmpDir, { force: true });

      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();

      // Check index files exist
      const indexDir = path.join(tmpDir, INDEX_DIR);
      expect(fs.existsSync(path.join(indexDir, 'metadata.json'))).toBe(true);
      expect(fs.existsSync(path.join(indexDir, 'tags.json'))).toBe(true);
      expect(fs.existsSync(path.join(indexDir, 'dependencies.json'))).toBe(true);
      expect(fs.existsSync(path.join(indexDir, 'stats.json'))).toBe(true);

      // Check metadata content
      const metadata = JSON.parse(fs.readFileSync(path.join(indexDir, 'metadata.json'), 'utf-8'));
      expect(metadata.version).toBe('1.0.0');
      expect(metadata.extractorVersion).toBe('2026.10.18.1');
      expect(Object.keys(metadata.entries)).toHaveLength(2);

      const uc001 = metadata.entries['.aiwg/requirements/UC-001.md'];
      expect(uc001).toBeDefined();
      expect(uc001.title).toBe('User Login');
      expect(uc001.type).toBe('use-case');
      expect(uc001.phase).toBe('requirements');
      expect(uc001.tags).toContain('auth');
      expect(uc001.checksum).toHaveLength(16);

      // Check tag index
      const tags = JSON.parse(fs.readFileSync(path.join(indexDir, 'tags.json'), 'utf-8'));
      expect(tags.auth).toHaveLength(2);
      expect(tags.security).toHaveLength(1);

      // Check stats
      const stats = JSON.parse(fs.readFileSync(path.join(indexDir, 'stats.json'), 'utf-8'));
      expect(stats.totalArtifacts).toBe(2);
      expect(stats.byPhase.requirements).toBe(2);
      expect(stats.byType['use-case']).toBe(2);
    });

    it('normalizes allowlisted operational-state frontmatter into index metadata', async () => {
      const issuePath = path.join(tmpDir, '.aiwg', 'issues', 'AIWG-1827.md');
      fs.mkdirSync(path.dirname(issuePath), { recursive: true });
      fs.writeFileSync(issuePath, `---
title: Live-state provenance
type: issue
operational_state:
  source_repo: roctinam/aiwg
  source_kind: issue
  source_id: aiwg#1827
  observed_state: open
  observed_at: 2026-07-21T10:00:00Z
  source_updated_at: 2026-07-21T09:00:00Z
  evidence_url: https://user:synthetic@git.example.test/roctinam/aiwg/issues/1827?token=synthetic
  observer: gitea-mcp
  classification: fresh
  current_action_selector: true
  bearer_token: synthetic-must-not-survive
---
# Live-state provenance
`);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await buildIndex(tmpDir, { force: true });
      } finally {
        consoleSpy.mockRestore();
      }

      const metadata = JSON.parse(fs.readFileSync(
        path.join(tmpDir, INDEX_DIR, 'metadata.json'),
        'utf-8',
      ));
      expect(metadata.entries['.aiwg/issues/AIWG-1827.md'].operationalState).toEqual({
        source_repo: 'roctinam/aiwg',
        source_kind: 'issue',
        source_id: 'aiwg#1827',
        observed_state: 'open',
        observed_at: '2026-07-21T10:00:00.000Z',
        source_updated_at: '2026-07-21T09:00:00.000Z',
        evidence_url: 'https://git.example.test/roctinam/aiwg/issues/1827',
        observer: 'gitea-mcp',
        classification: 'fresh',
        current_action_selector: true,
      });
      expect(JSON.stringify(metadata)).not.toContain('synthetic');
    });

    it('normalizes explicit state-transfer lifecycle without using operational state', async () => {
      const artifactPath = path.join(tmpDir, '.aiwg', 'archive', 'retired.md');
      fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
      fs.writeFileSync(artifactPath, `---
title: Retired artifact
state_transfer:
  deleted_at: 2026-07-20T08:30:00-04:00
---
# Retired artifact
`);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await buildIndex(tmpDir, { force: true });
      } finally {
        consoleSpy.mockRestore();
      }

      const metadata = JSON.parse(fs.readFileSync(
        path.join(tmpDir, INDEX_DIR, 'metadata.json'),
        'utf-8',
      ));
      expect(metadata.entries['.aiwg/archive/retired.md'].stateTransfer).toEqual({
        deletedAt: '2026-07-20T12:30:00.000Z',
      });
      expect(metadata.entries['.aiwg/archive/retired.md']).not.toHaveProperty(
        'operationalState',
      );
    });

    it('indexes every operational asset type from project-local bundle layouts', async () => {
      const assets: Array<[string, string]> = [
        ['.aiwg/extensions/local-review/skills/local-review/SKILL.md', [
          '---', 'name: local-review', 'description: Run a local review.', '---',
          '# Local Review',
        ].join('\n')],
        ['.aiwg/extensions/local-review/rules/local-review.md', '# Local Review Rule\n'],
        ['.aiwg/addons/local-ops/agents/local-operator.md', '# Local Operator\n'],
        ['.aiwg/addons/local-ops/commands/local-check.md', '# Local Check\n'],
        ['.aiwg/frameworks/local-delivery/behaviors/local-safety.md', '# Local Safety\n'],
        // Provider-native project templates were the gap: the project graph
        // previously omitted non-Markdown/YAML extensions accepted upstream.
        ['.aiwg/frameworks/local-delivery/templates/provider/config.toml', 'mode = "local"\n'],
        ['.aiwg/frameworks/local-delivery/schemas/deploy.schema.json', JSON.stringify({
          title: 'DeployConfig',
          description: 'Schema for local deployment configuration.',
          type: 'object',
        })],
        ['.aiwg/frameworks/local-delivery/runbooks/recovery-runbook.md', [
          '---', 'type: runbook', 'description: Recover the local delivery service.', '---',
          '# Recovery Runbook', '', '## Procedure', '', 'Restart the service.', '',
          '## Verification', '', 'Confirm service health.',
        ].join('\n')],
        ['.aiwg/frameworks/local-delivery/flows/release.yaml', [
          'apiVersion: flow.aiwg.io/v1', 'kind: FlowPlaybook', 'metadata:',
          '  name: local-release', 'spec:', '  description: Release the local project.',
          '  steps:', '    - id: verify', '      action: run-tests',
        ].join('\n')],
        ['.aiwg/plugins/local-tools/hooks/preflight.md', '# Local Preflight Hook\n'],
      ];
      for (const [relativePath, content] of assets) {
        const fullPath = path.join(tmpDir, relativePath);
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content);
      }

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        await buildIndex(tmpDir, { graph: 'project', force: true, explicit: true });
      } finally {
        consoleSpy.mockRestore();
        consoleErrorSpy.mockRestore();
      }

      const metadata = JSON.parse(fs.readFileSync(
        path.join(tmpDir, INDEX_DIR, 'project', 'metadata.json'),
        'utf-8',
      ));
      const byPath = metadata.entries as Record<string, { type: string; kind?: string }>;
      expect(Object.fromEntries(
        assets.map(([relativePath]) => [relativePath, byPath[relativePath]?.type]),
      )).toEqual({
        '.aiwg/extensions/local-review/skills/local-review/SKILL.md': 'skill',
        '.aiwg/extensions/local-review/rules/local-review.md': 'rule',
        '.aiwg/addons/local-ops/agents/local-operator.md': 'agent',
        '.aiwg/addons/local-ops/commands/local-check.md': 'command',
        '.aiwg/frameworks/local-delivery/behaviors/local-safety.md': 'behavior',
        '.aiwg/frameworks/local-delivery/templates/provider/config.toml': 'template',
        '.aiwg/frameworks/local-delivery/schemas/deploy.schema.json': 'schema',
        '.aiwg/frameworks/local-delivery/runbooks/recovery-runbook.md': 'runbook',
        '.aiwg/frameworks/local-delivery/flows/release.yaml': 'flow',
        '.aiwg/plugins/local-tools/hooks/preflight.md': 'hook',
      });
      expect(byPath['.aiwg/frameworks/local-delivery/schemas/deploy.schema.json']).toMatchObject({
        name: 'deploy',
        title: 'DeployConfig',
      });
      expect(byPath['.aiwg/frameworks/local-delivery/flows/release.yaml']?.kind).toBe('FlowPlaybook');
    });

    it.each(['extractorVersion', 'buildConfigHash'])('re-extracts unchanged files when %s is stale', async field => {
      const templateDir = path.join(tmpDir, 'agentic', 'code', 'addons', 'ops', 'templates');
      fs.mkdirSync(templateDir, { recursive: true });
      const runbookPath = path.join(templateDir, 'rotation-runbook.md');
      fs.writeFileSync(runbookPath, [
        '# Rotation Runbook', '',
        '## Purpose', '', 'Rotate credentials safely.', '',
        '## Procedure', '', 'Install the replacement.', '',
        '## Verification', '', 'Confirm clients authenticate.', '',
        '## Rollback', '', 'Restore the prior credential.', '',
      ].join('\n'));

      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      await buildIndex(tmpDir, { scope: 'agentic', outputDir: tmpDir, force: true });
      const metadataPath = path.join(tmpDir, INDEX_DIR, 'metadata.json');
      const stale = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      const entryPath = Object.keys(stale.entries)[0];
      if (field === 'buildConfigHash') delete stale.buildConfigHash;
      else stale.extractorVersion = '2026.07.17.1';
      stale.entries[entryPath].type = 'template';
      delete stale.entries[entryPath].kind;
      fs.writeFileSync(metadataPath, JSON.stringify(stale));

      await buildIndex(tmpDir, { scope: 'agentic', outputDir: tmpDir });
      logSpy.mockRestore();
      const rebuilt = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      expect(rebuilt.version).toBe('1.0.0');
      expect(rebuilt.extractorVersion).toBe('2026.10.18.1');
      expect(rebuilt.buildConfigHash).toMatch(/^[a-f0-9]{64}$/);
      expect(rebuilt.entries[entryPath].type).toBe('runbook');
      expect(rebuilt.entries[entryPath].kind).toBe('Runbook');
    });

    it('links framework skills to rules referenced through $AIWG_ROOT', async () => {
      const skillDir = path.join(tmpDir, 'agentic/code/frameworks/forensics-complete/skills/evidence-preservation');
      const ruleDir = path.join(tmpDir, 'agentic/code/frameworks/forensics-complete/rules');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.mkdirSync(ruleDir, { recursive: true });

      fs.writeFileSync(path.join(ruleDir, 'evidence-integrity.md'), `---
enforcement: critical
---
# Evidence Integrity
`);
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---
name: evidence-preservation
description: Preserve forensic evidence.
---
# evidence-preservation

## References

- @$AIWG_ROOT/agentic/code/frameworks/forensics-complete/rules/evidence-integrity.md
`);

      const oldXdgData = process.env.XDG_DATA_HOME;
      process.env.XDG_DATA_HOME = path.join(tmpDir, 'xdg');
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      try {
        await buildIndex(tmpDir, { graph: 'framework', force: true, explicit: true });
      } finally {
        consoleSpy.mockRestore();
        consoleErrorSpy.mockRestore();
        if (oldXdgData === undefined) delete process.env.XDG_DATA_HOME;
        else process.env.XDG_DATA_HOME = oldXdgData;
      }

      const indexDir = path.join(tmpDir, 'xdg', 'aiwg', 'index', 'framework');
      const deps = JSON.parse(fs.readFileSync(path.join(indexDir, 'dependencies.json'), 'utf-8')) as DependencyGraph;
      const skillPath = 'agentic/code/frameworks/forensics-complete/skills/evidence-preservation/SKILL.md';
      const rulePath = 'agentic/code/frameworks/forensics-complete/rules/evidence-integrity.md';

      expect(deps[skillPath].upstream).toEqual([{ path: rulePath, type: 'depends-on' }]);
      expect(deps[rulePath].downstream).toEqual([{ path: skillPath, type: 'depends-on' }]);
    });

    it('should handle incremental builds', async () => {
      // Create one artifact
      const aiwgDir = path.join(tmpDir, '.aiwg', 'requirements');
      fs.mkdirSync(aiwgDir, { recursive: true });

      fs.writeFileSync(path.join(aiwgDir, 'UC-001.md'), `---
title: User Login
type: use-case
---
# UC-001
`);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // First build
      await buildIndex(tmpDir, { force: true });

      // Add another artifact
      fs.writeFileSync(path.join(aiwgDir, 'UC-002.md'), `---
title: User Registration
type: use-case
---
# UC-002
`);

      // Incremental build (force = false by default)
      await buildIndex(tmpDir, {});

      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();

      const indexDir = path.join(tmpDir, INDEX_DIR);
      const metadata = JSON.parse(fs.readFileSync(path.join(indexDir, 'metadata.json'), 'utf-8'));
      expect(Object.keys(metadata.entries)).toHaveLength(2);
    });

    it.each(['default', 'project', 'codebase', 'outputDir', ...(sqliteAvailable ? ['sqlite'] : [])])(
      'preserves index bytes and mtimes on repeated no-op builds (%s)', async variant => {
        const sourceDir = path.join(tmpDir, variant === 'codebase' ? 'src' : '.aiwg/requirements');
        fs.mkdirSync(sourceDir, { recursive: true });
        const extension = variant === 'codebase' ? 'ts' : 'md';
        fs.writeFileSync(path.join(sourceDir, `target.${extension}`), '# Target\n');
        fs.writeFileSync(path.join(sourceDir, `source.${extension}`), `# Source\n\n[target](./target.${extension})\n`);
        if (variant === 'sqlite') {
          fs.writeFileSync(path.join(tmpDir, '.aiwg', 'aiwg.config'), JSON.stringify({
            index: { graphBackend: 'sqlite' },
          }));
        }
        const options = {
          quiet: true,
          graph: variant === 'project' || variant === 'sqlite' ? 'project'
            : variant === 'codebase' ? 'codebase' : undefined,
          outputDir: variant === 'outputDir' ? path.join(tmpDir, 'output') : undefined,
        };
        await buildIndex(tmpDir, { ...options, force: true });
        const indexDir = path.join(options.outputDir ?? tmpDir, INDEX_DIR, options.graph ?? '');
        const filenames = ['metadata.json', 'tags.json', 'dependencies.json', 'checksum-manifest.json'];
        if (variant === 'sqlite') filenames.push('graph.db');
        const snapshots = filenames.map(filename => {
          const file = path.join(indexDir, filename);
          fs.utimesSync(file, new Date('2000-01-01'), new Date('2000-01-01'));
          return { file, bytes: fs.readFileSync(file), mtime: fs.statSync(file, { bigint: true }).mtimeNs };
        });
        const statsFile = path.join(indexDir, 'stats.json');
        const originalStats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
        fs.utimesSync(statsFile, new Date('2000-01-01'), new Date('2000-01-01'));
        const statsMtime = fs.statSync(statsFile, { bigint: true }).mtimeNs;

        await buildIndex(tmpDir, options);
        await buildIndex(tmpDir, options);

        for (const { file, bytes, mtime } of snapshots) {
          expect(fs.readFileSync(file), file).toEqual(bytes);
          expect(fs.statSync(file, { bigint: true }).mtimeNs, file).toBe(mtime);
        }
        expect(fs.statSync(statsFile, { bigint: true }).mtimeNs).not.toBe(statsMtime);
        const stats = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
        expect(stats.graphMetrics).toEqual(originalStats.graphMetrics);
        expect(stats.totalArtifacts).toBe(2);
      },
    );

    it('re-extracts citation edges on unchanged-source incremental builds', async () => {
      const sourceDir = path.join(tmpDir, 'citations');
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.mkdirSync(path.join(tmpDir, '.aiwg'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.aiwg', 'aiwg.config'), JSON.stringify({
        index: {
          graphs: {
            'citation-noop': {
              scanDirs: ['citations'],
              extensions: ['.md'],
              edgeExtraction: { parser: 'citation-sidecar', edges: [] },
            },
          },
        },
      }));
      fs.writeFileSync(path.join(sourceDir, 'a.md'), [
        '---', 'ref: REF-001', '---',
        '## Outgoing: Papers This Work Cites', '',
        '| Title | Inducted REF |', '|---|---|', '| Target | REF-002 |', '',
      ].join('\n'));
      fs.writeFileSync(path.join(sourceDir, 'b.md'), '---\nref: REF-002\n---\n# Target\n');
      fs.writeFileSync(path.join(sourceDir, 'c.md'), '---\nref: REF-003\n---\n# Unrelated\n');

      try {
        const options = { graph: 'citation-noop', quiet: true };
        await buildIndex(tmpDir, { ...options, force: true });
        const depsFile = path.join(tmpDir, INDEX_DIR, 'citation-noop', 'dependencies.json');
        const expected: DependencyGraph = JSON.parse(fs.readFileSync(depsFile, 'utf8'));
        expect(expected['citations/a.md'].upstream).toEqual([{ path: 'citations/b.md', type: 'cites' }]);
        const stale: DependencyGraph = JSON.parse(fs.readFileSync(depsFile, 'utf8'));
        stale['citations/a.md'].upstream.push({ path: 'citations/c.md', type: 'cites' });
        stale['citations/c.md'].downstream.push({ path: 'citations/a.md', type: 'cites' });
        fs.writeFileSync(depsFile, JSON.stringify(stale));

        await buildIndex(tmpDir, options);

        expect(JSON.parse(fs.readFileSync(depsFile, 'utf8'))).toEqual(expected);
      } finally {
        delete GRAPH_CONFIGS['citation-noop'];
      }
    });

    it('refreshes only the manifest and stats when source timestamps drift', async () => {
      const sourceDir = path.join(tmpDir, '.aiwg', 'requirements');
      fs.mkdirSync(sourceDir, { recursive: true });
      const source = path.join(sourceDir, 'a.md');
      fs.writeFileSync(source, '# A\n');
      await buildIndex(tmpDir, { force: true, quiet: true });
      const indexDir = path.join(tmpDir, INDEX_DIR);
      const files = ['metadata.json', 'tags.json', 'dependencies.json'].map(name => path.join(indexDir, name));
      const before = files.map(file => fs.readFileSync(file, 'utf8'));
      fs.utimesSync(source, new Date('2000-01-01'), new Date('2000-01-01'));

      await buildIndex(tmpDir, { quiet: true });

      expect(files.map(file => fs.readFileSync(file, 'utf8'))).toEqual(before);
      const manifest = JSON.parse(fs.readFileSync(path.join(indexDir, 'checksum-manifest.json'), 'utf8'));
      expect(manifest.entries['.aiwg/requirements/a.md'].mtime).toBe(fs.statSync(source).mtime.toISOString());
    });

    it.each(['tags.json', 'dependencies.json', 'stats.json', 'checksum-manifest.json', ...(sqliteAvailable ? ['graph.db'] : [])])(
      'rebuilds when a required index file is missing (%s)', async filename => {
        const sourceDir = path.join(tmpDir, '.aiwg', 'requirements');
        fs.mkdirSync(sourceDir, { recursive: true });
        fs.writeFileSync(path.join(sourceDir, 'a.md'), '# A\n');
        if (filename === 'graph.db') {
          fs.writeFileSync(path.join(tmpDir, '.aiwg', 'aiwg.config'), JSON.stringify({
            index: { graphBackend: 'sqlite' },
          }));
        }
        await buildIndex(tmpDir, { force: true, quiet: true });
        const file = path.join(tmpDir, INDEX_DIR, filename);
        fs.unlinkSync(file);

        await buildIndex(tmpDir, { quiet: true });

        expect(fs.existsSync(file)).toBe(true);
        expect(fs.statSync(file).size).toBeGreaterThan(0);
      },
    );

    it('rebuilds metadata and dependencies after a source is deleted', async () => {
      const sourceDir = path.join(tmpDir, '.aiwg', 'requirements');
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.writeFileSync(path.join(sourceDir, 'a.md'), '# A\n\n@.aiwg/requirements/b.md\n');
      fs.writeFileSync(path.join(sourceDir, 'b.md'), '# B\n');
      await buildIndex(tmpDir, { force: true, quiet: true });
      fs.unlinkSync(path.join(sourceDir, 'b.md'));

      await buildIndex(tmpDir, { quiet: true });

      const indexDir = path.join(tmpDir, INDEX_DIR);
      const metadata = JSON.parse(fs.readFileSync(path.join(indexDir, 'metadata.json'), 'utf8'));
      const deps = JSON.parse(fs.readFileSync(path.join(indexDir, 'dependencies.json'), 'utf8'));
      expect(Object.keys(metadata.entries)).toEqual(['.aiwg/requirements/a.md']);
      expect(deps['.aiwg/requirements/a.md'].upstream).toEqual([]);
      expect(deps['.aiwg/requirements/b.md']).toBeUndefined();
    });

    it('rebuilds metadata and tags after source content changes', async () => {
      const sourceDir = path.join(tmpDir, '.aiwg', 'requirements');
      fs.mkdirSync(sourceDir, { recursive: true });
      const source = path.join(sourceDir, 'a.md');
      fs.writeFileSync(source, '# A\n');
      await buildIndex(tmpDir, { force: true, quiet: true });
      fs.writeFileSync(source, '---\ntitle: Changed\ntags: [updated]\n---\n# A\n');

      await buildIndex(tmpDir, { quiet: true });

      const indexDir = path.join(tmpDir, INDEX_DIR);
      const metadata = JSON.parse(fs.readFileSync(path.join(indexDir, 'metadata.json'), 'utf8'));
      const tags = JSON.parse(fs.readFileSync(path.join(indexDir, 'tags.json'), 'utf8'));
      expect(metadata.entries['.aiwg/requirements/a.md'].title).toBe('Changed');
      expect(tags.updated).toEqual(['.aiwg/requirements/a.md']);
    });

    itWithSqlite('rebuilds the selected backend after configuration changes', async () => {
      const sourceDir = path.join(tmpDir, '.aiwg', 'requirements');
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.writeFileSync(path.join(sourceDir, 'a.md'), '# A\n');
      await buildIndex(tmpDir, { force: true, quiet: true });
      fs.writeFileSync(path.join(tmpDir, '.aiwg', 'aiwg.config'), JSON.stringify({
        index: { graphBackend: 'sqlite' },
      }));

      await buildIndex(tmpDir, { quiet: true });

      const indexDir = path.join(tmpDir, INDEX_DIR);
      const stats = JSON.parse(fs.readFileSync(path.join(indexDir, 'stats.json'), 'utf8'));
      expect(stats.graphMetrics.backend).toBe('sqlite');
      expect(fs.existsSync(path.join(indexDir, 'graph.db'))).toBe(true);
    });

    it('completes a no-op 3000-artifact build in under 25 percent of a forced build', async () => {
      const sourceDir = path.join(tmpDir, 'src');
      fs.mkdirSync(sourceDir, { recursive: true });
      for (let i = 0; i < 3000; i++) {
        const refs = [1, 2, 3].map(offset => `@src/artifact-${(i + offset) % 3000}.ts`).join('\n');
        fs.writeFileSync(path.join(sourceDir, `artifact-${i}.ts`),
          `---\ntitle: Artifact ${i}\ntags: [synthetic]\n---\n# Artifact ${i}\n\n${refs}\n`);
      }
      const start = performance.now();
      await buildIndex(tmpDir, { graph: 'codebase', force: true, quiet: true });
      const forcedMs = performance.now() - start;
      const incrementalStart = performance.now();
      await buildIndex(tmpDir, { graph: 'codebase', quiet: true });
      const incrementalMs = performance.now() - incrementalStart;

      const stats = JSON.parse(fs.readFileSync(path.join(tmpDir, INDEX_DIR, 'codebase', 'stats.json'), 'utf8'));
      expect(stats.totalArtifacts).toBe(3000);
      expect(stats.graphMetrics.totalEdges).toBe(9000);
      console.info(`3000 artifacts: forced=${forcedMs.toFixed(1)}ms, no-op=${incrementalMs.toFixed(1)}ms (${(100 * incrementalMs / forcedMs).toFixed(1)}%)`);
      expect(incrementalMs).toBeLessThan(forcedMs * 0.25);
    });

    it('should infer type from filename patterns', async () => {
      const aiwgDir = path.join(tmpDir, '.aiwg', 'architecture');
      fs.mkdirSync(aiwgDir, { recursive: true });

      fs.writeFileSync(path.join(aiwgDir, 'adr-001-foo.md'), '# ADR-001\nSome decision.');
      fs.writeFileSync(path.join(aiwgDir, 'sad.md'), '# Software Architecture\nOverview.');

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await buildIndex(tmpDir, { force: true });

      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();

      const indexDir = path.join(tmpDir, INDEX_DIR);
      const metadata = JSON.parse(fs.readFileSync(path.join(indexDir, 'metadata.json'), 'utf-8'));

      const adr = metadata.entries['.aiwg/architecture/adr-001-foo.md'];
      expect(adr.type).toBe('adr');

      const sad = metadata.entries['.aiwg/architecture/sad.md'];
      expect(sad.type).toBe('architecture');
    });

    it('should exit with error when .aiwg/ does not exist', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });

      await expect(buildIndex(path.join(tmpDir, 'nonexistent'))).rejects.toThrow('process.exit');

      exitSpy.mockRestore();
      consoleSpy.mockRestore();
      logSpy.mockRestore();
    });

    it('should skip gracefully when defaultBuild graph dirs do not exist (non-explicit)', async () => {
      // tmpDir has no src/test/tools — codebase graph should warn and return, not error
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });

      await expect(buildIndex(tmpDir, { graph: 'codebase', explicit: false })).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('codebase graph: scan directories not found'));
      expect(exitSpy).not.toHaveBeenCalled();

      exitSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('should skip gracefully when any auto-selected graph dirs do not exist', async () => {
      // `aiwg index build --all` auto-selects framework even though it is
      // defaultBuild:false. Corpus repos should not fail just because they do
      // not carry framework source directories locally.
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });

      await expect(buildIndex(tmpDir, { graph: 'framework', explicit: false })).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('framework graph: scan directories not found'));
      expect(exitSpy).not.toHaveBeenCalled();

      exitSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it('should error when explicitly requested graph dirs do not exist', async () => {
      // explicit: true (--graph codebase) should still hard-error
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
        throw new Error('process.exit');
      });

      await expect(buildIndex(tmpDir, { graph: 'codebase', explicit: true })).rejects.toThrow('process.exit');

      exitSpy.mockRestore();
      consoleSpy.mockRestore();
      logSpy.mockRestore();
    });

    it('should produce typed edges in dependency graph', async () => {
      const aiwgDir = path.join(tmpDir, '.aiwg', 'requirements');
      fs.mkdirSync(aiwgDir, { recursive: true });

      fs.writeFileSync(path.join(aiwgDir, 'UC-001.md'), `---
title: User Login
type: use-case
---
# UC-001: User Login

Users can log in.
`);

      fs.writeFileSync(path.join(aiwgDir, 'UC-002.md'), `---
title: User Registration
type: use-case
---
# UC-002: User Registration

Depends on @.aiwg/requirements/UC-001.md
`);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await buildIndex(tmpDir, { force: true });

      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();

      const indexDir = path.join(tmpDir, INDEX_DIR);
      const deps: DependencyGraph = JSON.parse(
        fs.readFileSync(path.join(indexDir, 'dependencies.json'), 'utf-8')
      );

      // UC-002 should have UC-001 as upstream with type "depends-on"
      const uc002 = deps['.aiwg/requirements/UC-002.md'];
      expect(uc002).toBeDefined();
      expect(uc002.upstream).toHaveLength(1);
      expect(uc002.upstream[0]).toEqual({ path: '.aiwg/requirements/UC-001.md', type: 'depends-on' });

      // UC-001 should have UC-002 as downstream
      const uc001 = deps['.aiwg/requirements/UC-001.md'];
      expect(uc001).toBeDefined();
      expect(uc001.downstream).toHaveLength(1);
      expect(uc001.downstream[0]).toEqual({ path: '.aiwg/requirements/UC-002.md', type: 'depends-on' });
    });

    it('builds scoped markdown-link edges and reports their count (#147)', async () => {
      const docsDir = path.join(tmpDir, '.aiwg', 'docs');
      const outsideDir = path.join(tmpDir, 'outside');
      fs.mkdirSync(docsDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });

      fs.writeFileSync(path.join(docsDir, 'target.md'), '# Target\n');
      fs.writeFileSync(path.join(outsideDir, 'outside.md'), '# Outside\n');
      fs.writeFileSync(path.join(docsDir, 'source.md'), `---
title: Source
---
# Source

[target](./target.md)
[external](https://example.test/target.md)
[anchor](#local)
[outside](../../outside/outside.md)
`);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await buildIndex(tmpDir, { force: true, graph: 'project' });

      consoleSpy.mockRestore();
      consoleErrorSpy.mockRestore();

      const indexDir = path.join(tmpDir, INDEX_DIR, 'project');
      const metadata = JSON.parse(fs.readFileSync(path.join(indexDir, 'metadata.json'), 'utf-8'));
      const deps: DependencyGraph = JSON.parse(
        fs.readFileSync(path.join(indexDir, 'dependencies.json'), 'utf-8')
      );
      const stats = JSON.parse(fs.readFileSync(path.join(indexDir, 'stats.json'), 'utf-8'));

      const sourcePath = '.aiwg/docs/source.md';
      const targetPath = '.aiwg/docs/target.md';
      expect(metadata.entries[sourcePath].dependencies).toEqual([]);
      expect(metadata.entries[sourcePath].markdownLinks).toEqual(['./target.md', '../../outside/outside.md']);
      expect(deps[sourcePath].upstream).toEqual([{ path: targetPath, type: 'markdown-link' }]);
      expect(deps[targetPath].downstream).toEqual([{ path: sourcePath, type: 'markdown-link' }]);
      expect(Object.keys(deps).some(key => key.includes('outside.md'))).toBe(false);
      expect(stats.graphMetrics.totalEdges).toBe(1);
      expect(stats.graphMetrics.markdownLinkEdges).toBe(1);
      expect(stats.graphMetrics.orphanedArtifacts).toBe(0);
    });
  });

  describe('normalizeEdge / normalizeEdges', () => {
    it('should convert string to TypedEdge with depends-on type', () => {
      const edge = normalizeEdge('path/to/file.md');
      expect(edge).toEqual({ path: 'path/to/file.md', type: 'depends-on' });
    });

    it('should pass through TypedEdge unchanged', () => {
      const input: TypedEdge = { path: 'ref.md', type: 'cites' };
      expect(normalizeEdge(input)).toEqual(input);
    });

    it('should normalize mixed arrays', () => {
      const mixed: (string | TypedEdge)[] = [
        'old-string-edge.md',
        { path: 'new-typed.md', type: 'cites' },
      ];
      const result = normalizeEdges(mixed);
      expect(result).toEqual([
        { path: 'old-string-edge.md', type: 'depends-on' },
        { path: 'new-typed.md', type: 'cites' },
      ]);
    });
  });

  describe('normalizeNamedCaptures', () => {
    it('should convert Python-style (?P<name>...) to JS-style (?<name>...)', () => {
      const input = 'REF-(?P<ref>\\d{3})-(?P<author>[^-]+)-(?P<year>\\d{4})-(?P<slug>.+)\\.pdf';
      const result = normalizeNamedCaptures(input);
      expect(result).toBe('REF-(?<ref>\\d{3})-(?<author>[^-]+)-(?<year>\\d{4})-(?<slug>.+)\\.pdf');
    });

    it('should pass through JS-style patterns unchanged', () => {
      const input = 'REF-(?<ref>\\d{3})\\.pdf';
      expect(normalizeNamedCaptures(input)).toBe(input);
    });
  });

  describe('buildFilenameMetadataEntry', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-filename-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('should extract metadata from filename with regex captures', () => {
      const pdfPath = path.join(tmpDir, 'REF-008-lewis-2020-rag.pdf');
      fs.writeFileSync(pdfPath, Buffer.from('fake pdf content'));

      const pattern = 'REF-(?P<ref>\\d{3})-(?P<author>[^-]+)-(?P<year>\\d{4})-(?P<slug>.+)\\.pdf';
      const entry = buildFilenameMetadataEntry('pdfs/full/REF-008-lewis-2020-rag.pdf', pdfPath, pattern);

      expect(entry.type).toBe('paper');
      expect(entry.title).toBe('REF-008 — lewis — 2020 — rag');
      expect(entry.dependencies).toEqual([]);
      expect(entry.summary).toBe('');
      expect(entry.checksum).toHaveLength(16);

      // Captures should be accessible
      const captures = (entry as Record<string, unknown>).captures as Record<string, string>;
      expect(captures.ref).toBe('008');
      expect(captures.author).toBe('lewis');
      expect(captures.year).toBe('2020');
      expect(captures.slug).toBe('rag');
    });

    it('should use basename as title when no pattern matches', () => {
      const pdfPath = path.join(tmpDir, 'random-file.pdf');
      fs.writeFileSync(pdfPath, Buffer.from('fake'));

      const entry = buildFilenameMetadataEntry('pdfs/random-file.pdf', pdfPath, undefined);
      expect(entry.title).toBe('random-file.pdf');
      expect(entry.type).toBe('document');
    });

    it('should use basename as title when pattern does not match', () => {
      const pdfPath = path.join(tmpDir, 'no-match.pdf');
      fs.writeFileSync(pdfPath, Buffer.from('fake'));

      const pattern = 'REF-(?P<ref>\\d{3})\\.pdf';
      const entry = buildFilenameMetadataEntry('pdfs/no-match.pdf', pdfPath, pattern);
      expect(entry.title).toBe('no-match.pdf');
    });
  });

  describe('buildIndex with filename-metadata strategy', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-pdf-index-test-'));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      for (const key of Object.keys(GRAPH_CONFIGS)) {
        if (!['framework', 'project', 'codebase', 'source', 'user'].includes(key)) {
          delete GRAPH_CONFIGS[key];
        }
      }
    });

    it('should index PDF files as identity nodes using filename-metadata strategy', async () => {
      // Create config with filename-metadata strategy
      const aiwgDir = path.join(tmpDir, '.aiwg');
      fs.mkdirSync(aiwgDir, { recursive: true });
      fs.writeFileSync(path.join(aiwgDir, 'config.yaml'), `
index:
  graphs:
    papers:
      scanDirs:
        - pdfs/full
      extensions:
        - .pdf
      nodeStrategy: filename-metadata
      filenamePattern: "REF-(?P<ref>\\\\d{3})-(?P<author>[^-]+)-(?P<year>\\\\d{4})-(?P<slug>.+)\\\\.pdf"
      defaultBuild: true
`);

      // Create PDF directory and fake PDF files
      const pdfDir = path.join(tmpDir, 'pdfs', 'full');
      fs.mkdirSync(pdfDir, { recursive: true });
      fs.writeFileSync(path.join(pdfDir, 'REF-001-bandara-2024-production-agentic.pdf'), Buffer.from('fake pdf'));
      fs.writeFileSync(path.join(pdfDir, 'REF-008-lewis-2020-rag.pdf'), Buffer.from('fake pdf'));
      fs.writeFileSync(path.join(pdfDir, 'REF-016-wei-2022-cot.pdf'), Buffer.from('fake pdf'));

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await buildIndex(tmpDir, { force: true, graph: 'papers' });

      consoleSpy.mockRestore();
      consoleWarnSpy.mockRestore();

      // Check index output
      const indexDir = path.join(tmpDir, '.aiwg', '.index', 'papers');
      expect(fs.existsSync(path.join(indexDir, 'metadata.json'))).toBe(true);

      const metadata = JSON.parse(fs.readFileSync(path.join(indexDir, 'metadata.json'), 'utf-8'));
      expect(Object.keys(metadata.entries)).toHaveLength(3);

      const ref008 = metadata.entries['pdfs/full/REF-008-lewis-2020-rag.pdf'];
      expect(ref008).toBeDefined();
      expect(ref008.type).toBe('paper');
      expect(ref008.title).toContain('REF-008');
      expect(ref008.title).toContain('lewis');
      expect(ref008.title).toContain('2020');
      expect(ref008.dependencies).toEqual([]);
    });

    it('should apply metadata supplements from sidecar files', async () => {
      // Create config with metadata supplements
      const aiwgDir = path.join(tmpDir, '.aiwg');
      fs.mkdirSync(aiwgDir, { recursive: true });
      fs.writeFileSync(path.join(aiwgDir, 'config.yaml'), `
index:
  graphs:
    papers:
      scanDirs:
        - pdfs/full
      extensions:
        - .pdf
      nodeStrategy: filename-metadata
      filenamePattern: "REF-(?P<ref>\\\\d{3})-(?P<author>[^-]+)-(?P<year>\\\\d{4})-(?P<slug>.+)\\\\.pdf"
      defaultBuild: true
      metadataSupplements:
        - scanDir: documentation/citations
          matchOn: frontmatter.ref
          nodeKey: ref
          mergeFields:
            - title
            - authors
`);

      // Create PDF
      const pdfDir = path.join(tmpDir, 'pdfs', 'full');
      fs.mkdirSync(pdfDir, { recursive: true });
      fs.writeFileSync(path.join(pdfDir, 'REF-008-lewis-2020-rag.pdf'), Buffer.from('fake'));

      // Create sidecar with enriched metadata
      const citationDir = path.join(tmpDir, 'documentation', 'citations');
      fs.mkdirSync(citationDir, { recursive: true });
      fs.writeFileSync(path.join(citationDir, 'REF-008-citations.md'), `---
ref: REF-008
title: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks"
authors: "Lewis, Perez, Piktus, Petroni, Karpukhin, Goyal, Küttler, Lewis, Yih, Rocktäschel, Riedel, Kiela"
type: citations
---

## Outgoing: Papers This Work Cites

| # | Title | Inducted REF |
|---|-------|-------------|
| 1 | Dense passage retrieval | REF-029 |
`);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await buildIndex(tmpDir, { force: true, graph: 'papers' });

      consoleSpy.mockRestore();
      consoleWarnSpy.mockRestore();

      const indexDir = path.join(tmpDir, '.aiwg', '.index', 'papers');
      const metadata = JSON.parse(fs.readFileSync(path.join(indexDir, 'metadata.json'), 'utf-8'));
      const ref008 = metadata.entries['pdfs/full/REF-008-lewis-2020-rag.pdf'];

      // Title should be enriched from sidecar
      expect(ref008.title).toBe('Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks');
      // Authors should be in summary
      expect(ref008.summary).toContain('Lewis');

      // Supplements are outside the graph scan roots and can change independently.
      fs.writeFileSync(path.join(citationDir, 'REF-008-citations.md'), `---
ref: REF-008
title: Updated title
authors: Updated authors
---
`);
      await buildIndex(tmpDir, { graph: 'papers', quiet: true });
      const updated = JSON.parse(fs.readFileSync(path.join(indexDir, 'metadata.json'), 'utf-8'));
      expect(updated.entries['pdfs/full/REF-008-lewis-2020-rag.pdf'].title).toBe('Updated title');
      expect(updated.entries['pdfs/full/REF-008-lewis-2020-rag.pdf'].summary).toContain('Updated authors');
    });

    it('accepts match shorthand in metadataSupplements config (#738)', async () => {
      // Use "match" shorthand instead of separate matchOn + nodeKey
      const aiwgDir = path.join(tmpDir, '.aiwg');
      fs.mkdirSync(aiwgDir, { recursive: true });
      fs.writeFileSync(path.join(aiwgDir, 'config.yaml'), `
index:
  graphs:
    papers:
      scanDirs:
        - pdfs/full
      extensions:
        - .pdf
      nodeStrategy: filename-metadata
      filenamePattern: "REF-(?P<ref>\\\\d{3})-(?P<slug>.+)\\\\.pdf"
      defaultBuild: true
      metadataSupplements:
        - scanDir: documentation/citations
          match: frontmatter.ref
          mergeFields:
            - title
            - authors
`);

      const pdfDir = path.join(tmpDir, 'pdfs', 'full');
      fs.mkdirSync(pdfDir, { recursive: true });
      fs.writeFileSync(path.join(pdfDir, 'REF-008-rag.pdf'), Buffer.from('fake'));

      const citationDir = path.join(tmpDir, 'documentation', 'citations');
      fs.mkdirSync(citationDir, { recursive: true });
      fs.writeFileSync(path.join(citationDir, 'REF-008-citations.md'), `---
ref: REF-008
title: "RAG for Knowledge-Intensive NLP"
authors: "Lewis et al."
---
`);

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await buildIndex(tmpDir, { force: true, graph: 'papers' });

      consoleSpy.mockRestore();
      consoleWarnSpy.mockRestore();

      const indexDir = path.join(tmpDir, '.aiwg', '.index', 'papers');
      const metadata = JSON.parse(fs.readFileSync(path.join(indexDir, 'metadata.json'), 'utf-8'));
      const ref008 = metadata.entries['pdfs/full/REF-008-rag.pdf'];

      expect(ref008.title).toBe('RAG for Knowledge-Intensive NLP');
      expect(ref008.summary).toContain('Lewis');
    });
  });
});
