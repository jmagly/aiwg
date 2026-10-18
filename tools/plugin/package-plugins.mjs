#!/usr/bin/env node

/**
 * @file package-plugins.mjs
 * @description Package AIWG components as Claude Code plugins
 * @implements @.aiwg/architecture/decisions/ADR-016-claude-code-plugin-distribution.md
 *
 * Usage:
 *   node tools/plugin/package-plugins.mjs --all              # Package all plugins
 *   node tools/plugin/package-plugins.mjs --plugin aiwg-sdlc # Package specific plugin
 *   node tools/plugin/package-plugins.mjs --clean            # Clean agentic/code/plugins directory
 *   node tools/plugin/package-plugins.mjs --dry-run          # Show what would be copied
 *   node tools/plugin/package-plugins.mjs --all --check      # Verify tracked Claude copies
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath, pathToFileURL } from 'url';
import { importImpl } from '../_resolve-impl.mjs';
import { rewritePublishedMarkdown, reportPluginLinks } from './plugin-links.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const PLUGINS_DIR = path.join(ROOT_DIR, 'agentic/code/plugins');
const RELEASE_VERSION = JSON.parse(
  fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'),
).version;

// Plugin configurations
const PLUGIN_CONFIGS = {
  'sdlc': {
    name: 'sdlc',
    displayName: 'AIWG SDLC Complete',
    version: '2024.12.4',
    description: 'Complete SDLC framework with 180+ specialized agents for software development lifecycle management.',
    sources: {
      agents: 'agentic/code/frameworks/sdlc-complete/agents',
      commands: 'agentic/code/frameworks/sdlc-complete/commands',
      skills: 'agentic/code/frameworks/sdlc-complete/skills'
    },
    extraCopy: [
      { from: 'tools/security/threat-assessment.mjs', to: 'tools/security/threat-assessment.mjs' },
      { from: 'agentic/code/frameworks/sdlc-complete/flows/flow-architecture-evolution.playbook.yaml', to: 'flows/flow-architecture-evolution.playbook.yaml' },
      { from: 'agentic/code/frameworks/sdlc-complete/flows/flow-release.playbook.yaml', to: 'flows/flow-release.playbook.yaml' }
    ],
    rewrites: [
      {
        file: 'skills/address-issues-threat-assess/scripts/assess.mjs',
        from: '../../../../../../../tools/security/threat-assessment.mjs',
        to: '../../../tools/security/threat-assessment.mjs'
      }
    ],
    readme: `# AIWG SDLC Complete

Complete Software Development Lifecycle framework with 180+ specialized agents.

## Features

- **58 Specialized Agents**: Architecture, security, testing, deployment, and more
- **Phase-Based Workflows**: Inception → Elaboration → Construction → Transition
- **Security Reviews**: Automated threat modeling and security gates
- **Testing Orchestration**: Multi-level test strategy execution
- **Deployment Automation**: Release planning and deployment workflows

## Quick Start

\`\`\`bash
# Check project status
/project-status

# Start SDLC workflow
"transition to elaboration"

# Run security review
"run security review"
\`\`\`

## Agents

Key agents include:
- \`architecture-designer\` - System architecture and ADRs
- \`security-architect\` - Threat modeling and security gates
- \`test-engineer\` - Test strategy and automation
- \`devops-engineer\` - CI/CD and deployment

## Documentation

- Full guide: https://docs.aiwg.io/sdlc
- Discord: https://discord.gg/BuAusFMxdA
`
  },

  'marketing': {
    name: 'marketing',
    displayName: 'AIWG Marketing Kit',
    version: '2024.12.4',
    description: 'Marketing automation framework with 37 specialized agents for campaign management.',
    sources: {
      agents: 'agentic/code/frameworks/media-marketing-kit/agents',
      skills: 'agentic/code/frameworks/media-marketing-kit/skills'
    },
    readme: `# AIWG Marketing Kit

Marketing automation framework with 37 specialized agents.

## Features

- **37 Marketing Agents**: Campaign, content, brand, social media specialists
- **Full Campaign Lifecycle**: Strategy → Creation → Review → Publication → Analysis
- **Brand Compliance**: Automated brand voice and guideline enforcement
- **Analytics Integration**: Campaign performance tracking

## Quick Start

\`\`\`bash
# Start marketing intake
/marketing-intake-wizard

# Create campaign brief
/creative-brief

# Review brand compliance
/brand-review
\`\`\`

## Documentation

- Full guide: https://docs.aiwg.io/marketing
- Discord: https://discord.gg/BuAusFMxdA
`
  },

  'voice': {
    name: 'voice',
    displayName: 'AIWG Voice Framework',
    version: '1.0.0',
    description: 'Voice profile system for consistent, authentic writing.',
    sources: {
      skills: 'agentic/code/addons/voice-framework/skills'
    },
    extraCopy: [
      { from: 'agentic/code/addons/voice-framework/voices', to: 'voices' },
      { from: 'agentic/code/addons/voice-framework/docs/writing-workflows.md', to: 'docs/writing-workflows.md' },
      { from: 'agentic/code/addons/voice-framework/docs/voice-output-impact.md', to: 'docs/voice-output-impact.md' },
      { from: 'agentic/code/addons/voice-framework/docs/natural-voice/ADR-001-evidence-and-ownership.md', to: 'docs/natural-voice/ADR-001-evidence-and-ownership.md' },
      { from: 'agentic/code/addons/voice-framework/docs/natural-voice/evidence-ledger.v1.json', to: 'docs/natural-voice/evidence-ledger.v1.json' },
      { from: 'agentic/code/addons/voice-framework/flows/voice-critique-correction.flow.yaml', to: 'flows/voice-critique-correction.flow.yaml' }
    ],
    readme: `# AIWG Voice Framework

Voice profile system for consistent, authentic writing.

## Built-in Profiles

- **technical-authority**: Direct, precise, confident
- **friendly-explainer**: Approachable, encouraging
- **executive-brief**: Concise, outcome-focused
- **casual-conversational**: Relaxed, personal

## Skills

- \`voice-apply\`: Apply a voice profile to content
- \`voice-create\`: Generate new voice from description
- \`voice-blend\`: Combine multiple profiles
- \`voice-analyze\`: Analyze content's voice characteristics

## Quick Start

\`\`\`bash
# Apply voice to content
"write this in technical-authority voice"

# Create custom voice
"create a voice for API docs - precise, no-nonsense"

# Blend voices
"blend 70% technical with 30% friendly"
\`\`\`

## Documentation

- Full guide: https://docs.aiwg.io/voice
- Discord: https://discord.gg/BuAusFMxdA
`
  },

  'writing': {
    name: 'writing',
    displayName: 'AIWG Writing Quality',
    version: '1.0.0',
    description: 'Writing quality validation and AI pattern detection.',
    sources: {
      agents: 'agentic/code/addons/writing-quality/agents',
      skills: 'agentic/code/addons/writing-quality/skills'
    },
    readme: `# AIWG Writing Quality

Writing quality validation and AI pattern detection.

## Features

- **AI Pattern Detection**: Identify AI-generated writing patterns
- **Authenticity Enhancement**: Suggestions for more authentic voice
- **Writing Validation**: Check against AIWG principles

## Agents

- \`writing-validator\`: Validates content for voice consistency and authenticity
- \`prompt-optimizer\`: Enhances prompts using AIWG principles
- \`content-diversifier\`: Generates varied examples and perspectives

## Quick Start

\`\`\`bash
# Validate content
/writing-validator "path/to/content.md"

# Detect AI patterns
"check this content for AI patterns"
\`\`\`

## Documentation

- Full guide: https://docs.aiwg.io/writing
- Discord: https://discord.gg/BuAusFMxdA
`
  },

  'utils': {
    name: 'utils',
    displayName: 'AIWG Utilities',
    version: '1.5.0',
    description: 'Core AIWG utilities for context regeneration and workspace management.',
    sources: {
      agents: 'agentic/code/addons/aiwg-utils/agents',
      skills: 'agentic/code/addons/aiwg-utils/skills'
    },
    extraCopy: [
      { from: 'agentic/code/addons/aiwg-utils/rules/skill-discovery.md', to: 'rules/skill-discovery.md' },
      { from: 'agentic/code/addons/aiwg-utils/rules/cli-secondary.md', to: 'rules/cli-secondary.md' }
    ],
    readme: `# AIWG Utilities

Core AIWG utilities for context regeneration and workspace management.

## Features

- **Context Regeneration**: Update CLAUDE.md, WARP.md, AGENTS.md
- **Workspace Management**: Prune, realign, reset workspaces
- **Development Kit**: Scaffold new addons, agents, commands, skills
- **@-Mention Traceability**: Wire, validate, and report on @-mentions

## Commands

- \`/aiwg-regenerate\`: Regenerate platform context files
- \`/workspace-realign\`: Reorganize .aiwg/ documentation
- \`/devkit-create-*\`: Scaffold new components
- \`/mention-wire\`: Inject @-mentions for traceability

## Quick Start

\`\`\`bash
# Regenerate context
/aiwg-regenerate

# Create new agent
/devkit-create-agent "my-new-agent"

# Check @-mention traceability
/mention-validate
\`\`\`

## Documentation

- Full guide: https://docs.aiwg.io/utils
- Discord: https://discord.gg/BuAusFMxdA
`
  },

  'codex-sdlc': {
    name: 'codex-sdlc',
    displayName: 'AIWG SDLC for Codex',
    pluginType: 'codex',
    scriptWrappers: [{
      file: 'skills/address-issues-threat-assess/scripts/assess.mjs',
      source: 'agentic/code/frameworks/sdlc-complete/skills/address-issues-threat-assess/scripts/assess.mjs',
      exports: ['assessIssue', 'assessText', 'runCli'],
    }],
    description: 'Complete SDLC framework packaged as a Codex plugin with skills, agents, and marketplace entry.',
    sources: {
      skills: 'agentic/code/frameworks/sdlc-complete/skills'
    },
    extraCopy: [
      { from: 'agentic/code/frameworks/sdlc-complete/flows/flow-architecture-evolution.playbook.yaml', to: 'flows/flow-architecture-evolution.playbook.yaml' },
      { from: 'agentic/code/frameworks/sdlc-complete/flows/flow-release.playbook.yaml', to: 'flows/flow-release.playbook.yaml' }
    ],
    readme: `# AIWG SDLC for Codex

AIWG SDLC framework packaged as a Codex plugin.

## Installation

\`\`\`bash
# Generate the plugin bundle
aiwg use sdlc --provider codex --as-plugin

# Or package directly
node tools/plugin/package-plugins.mjs --plugin codex-sdlc
\`\`\`

Then install in Codex via the \`/plugins\` command or the repo marketplace.

## Documentation

- Full guide: https://docs.aiwg.io/sdlc
- Discord: https://discord.gg/BuAusFMxdA
`
  },

  'forensics': {
    name: 'forensics',
    displayName: 'AIWG Forensics Complete',
    version: '2026.5.0',
    description: 'Digital forensics and incident response framework with 14 specialized agents covering target profiling, evidence acquisition, log/memory/container/cloud analysis, IOC extraction, and reporting.',
    sources: {
      agents: 'agentic/code/frameworks/forensics-complete/agents',
      skills: 'agentic/code/frameworks/forensics-complete/skills'
    },
    readme: `# AIWG Forensics Complete

Digital forensics and incident response framework with 14 specialized agents.

## Features

- **Triage & Acquisition**: RFC 3227 volatility-order capture, chain of custody, hash verification
- **Multi-Domain Analysis**: Logs, memory (Volatility 3), containers (Docker/K8s), cloud (AWS/Azure/GCP)
- **Threat Hunting**: Sigma rule application, IOC extraction in STIX 2.1 format
- **Reporting**: Executive summaries, technical findings, MITRE ATT&CK mapping, remediation plans

## Quick Start

\`\`\`bash
# Full investigation workflow
/forensics-investigate

# Quick triage
/forensics-triage

# Build target profile
/forensics-profile

# Generate forensic report
/forensics-report
\`\`\`

## Documentation

- Full guide: https://docs.aiwg.io/forensics
- Discord: https://discord.gg/BuAusFMxdA
`
  },

  'security-engineering': {
    name: 'security-engineering',
    displayName: 'AIWG Security Engineering',
    version: '2026.5.0',
    description: 'Applied security framework for cryptographic primitive selection, chain-of-trust design, authentication factor analysis, supply-chain trust, and physical-threat modeling. Complements OWASP-style application audits.',
    sources: {
      agents: 'agentic/code/frameworks/security-engineering/agents',
      skills: 'agentic/code/frameworks/security-engineering/skills'
    },
    extraCopy: [
      { from: 'agentic/code/frameworks/security-engineering/rules/ci-action-pinning.md', to: 'rules/ci-action-pinning.md' }
    ],
    readme: `# AIWG Security Engineering

Applied security engineering framework for cryptographic primitive selection, chain-of-trust integrity, and physical-threat modeling.

## Features

- **Applied Cryptography Review**: AEAD selection, KDF correctness, key separation, openssl flag verification
- **Chain-of-Trust Design**: Bootstrap integrity, signing key custody, measured boot
- **Authentication Factor Design**: have/know/are mapping, coercion-resistance, FIDO2 PIN/UV policy
- **Supply-Chain Trust**: Beyond CVE/SBOM — pinning depth, reproducible builds, firmware version locking
- **Physical Threat Modeling**: Evil-maid, DMA, hostile peripherals, cold-boot, side-channel

## Agents

- \`applied-cryptographer\` - Crypto primitive selection and KDF correctness
- \`secure-bootstrap-reviewer\` - Chain-of-trust integrity

## Quick Start

\`\`\`bash
# Crypto primitive selection
/crypto-primitive-selection

# Chain-of-trust design
/chain-of-trust-design

# Auth factor design
/auth-factor-design
\`\`\`

## Documentation

- Full guide: https://docs.aiwg.io/security-engineering
- Discord: https://discord.gg/BuAusFMxdA
`
  },

  'research': {
    name: 'research',
    displayName: 'AIWG Research Complete',
    version: '2026.5.0',
    description: 'Research workflow framework with 9 specialized agents for discovery, acquisition, synthesis, citation management, GRADE quality assessment, and OAIS-compliant archival.',
    sources: {
      agents: 'agentic/code/frameworks/research-complete/agents',
      skills: 'agentic/code/frameworks/research-complete/skills'
    },
    extraCopy: [
      { from: 'agentic/code/frameworks/research-complete/docs/bibliographic-services.md', to: 'docs/bibliographic-services.md' },
      { from: 'agentic/code/frameworks/research-complete/docs/corpus-data-model.md', to: 'docs/corpus-data-model.md' }
    ],
    readme: `# AIWG Research Complete

Research workflow framework with 9 specialized agents for academic and technical research.

## Features

- **Discovery**: Multi-database search, gap detection, reproducible search strategies
- **Acquisition**: PDF download, metadata extraction, provenance tracking
- **Synthesis**: Literature notes, structured summaries, citation networks
- **Quality (GRADE)**: Source quality assessment, FAIR compliance, hedging enforcement
- **Archival (OAIS)**: Long-term preservation, integrity verification, version control
- **Citation Management**: 9,000+ styles, reference verification, hallucination detection

## Quick Start

\`\`\`bash
# Discover sources
/research-discover

# Run full pipeline
/research-workflow

# Verify citations
/verify-citations

# Generate corpus snapshot
/corpus-snapshot
\`\`\`

## Documentation

- Full guide: https://docs.aiwg.io/research
- Discord: https://discord.gg/BuAusFMxdA
`
  },

  'media-curator': {
    name: 'media-curator',
    displayName: 'AIWG Media Curator',
    version: '2026.5.0',
    description: 'Media archive management framework with 7 specialized agents for source discovery, acquisition (yt-dlp / Internet Archive / Bandcamp), quality assessment, metadata tagging, and provenance tracking.',
    sources: {
      agents: 'agentic/code/frameworks/media-curator/agents',
      skills: 'agentic/code/frameworks/media-curator/skills'
    },
    readme: `# AIWG Media Curator

Media archive management framework with 7 specialized agents.

## Features

- **Discography Analysis**: Era identification, catalog structure
- **Source Discovery**: Multi-platform ranking (YouTube, Internet Archive, Bandcamp)
- **Acquisition**: yt-dlp patterns, archive download, format selection
- **Quality Filtering**: Audio/video quality scoring, accept/reject thresholds
- **Metadata Curation**: opustags / ffmpeg patterns, cover art embedding
- **Transcription**: executable local WhisperX transcript sidecars
- **Speaker Diarization**: anonymous speaker clustering with pyannote via WhisperX
- **Provenance Tracking**: W3C PROV-O derivation chains
- **Export**: Plex / Jellyfin / MPD / archival formats

## Quick Start

\`\`\`bash
# Full curation workflow
/curate

# Acquire from sources
/acquire

# Tag a collection
/tag-collection

# Generate a transcript sidecar
/transcribe-media

# Generate an anonymous speaker-diarized transcript sidecar
/diarize-media

# Verify archive integrity
/verify-archive
\`\`\`

## Documentation

- Full guide: https://docs.aiwg.io/media-curator
- Discord: https://discord.gg/BuAusFMxdA
`
  },

  'ops': {
    name: 'ops',
    displayName: 'AIWG Ops Complete',
    version: '2026.5.0',
    description: 'Operational infrastructure framework with 12 specialized agents covering incident response, runbook execution, fleet inventory, certificate lifecycle, and disaster recovery planning.',
    sources: {
      agents: 'agentic/code/frameworks/ops-complete/agents',
      skills: 'agentic/code/frameworks/ops-complete/skills'
    },
    readme: `# AIWG Ops Complete

Operational infrastructure framework with 12 specialized agents for sysops, devops, and itops workflows.

## Features

- **Fleet Inventory**: Reconcile hosts, services, network resources
- **Runbook Execution**: Step-by-step with verification gates and audit trails
- **Incident Response**: Triage, escalation, post-mortem
- **Certificate Lifecycle**: Issuance, renewal, revocation, expiry monitoring
- **Disaster Recovery**: Topology-aware runbook generation with RTO budgets
- **Identity & Secrets**: IdP audits, OpenBao/Vault operations, key rotation
- **Stream Health**: Transcoder, output, service availability monitoring

## Quick Start

\`\`\`bash
# Manage ops workspaces
/ops

# Execute a runbook
/ops-run

# Health check fleet
/ops-status
\`\`\`

## Documentation

- Full guide: https://docs.aiwg.io/ops
- Discord: https://discord.gg/BuAusFMxdA
`
  },

  'knowledge-base': {
    name: 'knowledge-base',
    displayName: 'AIWG Knowledge Base',
    version: '2026.5.0',
    description: 'Knowledge-base / wiki framework with skills for ingestion, query, and lint. Build a structured, citable corpus with cross-references and concept pages.',
    sources: {
      skills: 'agentic/code/frameworks/knowledge-base/skills'
    },
    readme: `# AIWG Knowledge Base

Knowledge-base / wiki framework for structured corpus authoring.

## Features

- **Source Ingestion**: URL, file, or freeform note → entity + concept pages
- **Query**: Search the local KB, synthesize answers with inline citations
- **Health & Lint**: Orphan page detection, broken wiki-links, stale claims, index regeneration

## Skills

- \`kb-ingest\`: Ingest a source into the knowledge base
- \`kb-health\`: Lint and health-check the KB

## Quick Start

\`\`\`bash
# Ingest a source
/kb-ingest "https://example.com/article"

# Health check
/kb-health
\`\`\`

## Documentation

- Full guide: https://docs.aiwg.io/knowledge-base
- Discord: https://discord.gg/BuAusFMxdA
`
  },

  'hooks': {
    name: 'hooks',
    displayName: 'AIWG Hooks',
    version: '1.0.0',
    description: 'Claude Code hooks for workflow tracing and observability.',
    sources: {
      hooks: 'agentic/code/addons/aiwg-hooks/hooks'
    },
    extraCopy: [
      { from: 'agentic/code/addons/aiwg-hooks/scripts', to: 'scripts' }
    ],
    readme: `# AIWG Hooks

Claude Code hooks for workflow tracing and observability.

## Features

- **Workflow Tracing**: Capture multi-agent workflow traces
- **JSONL Output**: Streaming data for analysis
- **Session Management**: Track session state across interactions
- **Timeline Visualization**: Understand workflow execution

## Hooks

- \`SessionStart\`: Initialize tracing on session start
- \`PostToolUse\`: Capture tool execution results
- \`AgentComplete\`: Record agent completion status

## Quick Start

Install the plugin and hooks are automatically active.

Traces are written to \`.aiwg/traces/\` in JSONL format.

## Documentation

- Full guide: https://docs.aiwg.io/hooks
- Discord: https://discord.gg/BuAusFMxdA
`
  }
};

// Manifest-backed Claude plugins. Keep the curated framework bundles above,
// then expose every user-facing addon that contains a Claude-discoverable
// component. Copying the complete addon directory is intentional: Claude Code
// installs marketplace plugins into an isolated cache, so skills must not rely
// on ../ paths back into the AIWG monorepo for templates, schemas, or scripts.
const MANIFEST_PLUGIN_SOURCES = [
  ['validation-complete', 'agentic/code/frameworks/validation-complete'],
  ['agent-loop', 'agentic/code/addons/agent-loop'],
  ['agent-persistence', 'agentic/code/addons/agent-persistence'],
  ['agentic-installer', 'agentic/code/addons/agentic-installer'],
  ['aiwg-evals', 'agentic/code/addons/aiwg-evals'],
  ['aiwg-dev', 'agentic/code/addons/aiwg-dev'],
  ['auto-memory', 'agentic/code/addons/auto-memory'],
  ['browser-control', 'agentic/code/addons/browser-control'],
  ['color-palette', 'agentic/code/addons/color-palette'],
  ['context-curator', 'agentic/code/addons/context-curator'],
  ['compound-memory', 'agentic/code/addons/compound-memory'],
  ['daemon', 'agentic/code/addons/daemon'],
  ['doc-intelligence', 'agentic/code/addons/doc-intelligence'],
  ['droid-bridge', 'agentic/code/addons/droid-bridge'],
  ['guided-implementation', 'agentic/code/addons/guided-implementation'],
  ['line-memory', 'agentic/code/addons/line-memory'],
  ['llm-wiki', 'agentic/code/addons/llm-wiki'],
  ['nlp-prod', 'agentic/code/addons/nlp-prod'],
  ['prose-integration', 'agentic/code/addons/prose-integration'],
  ['rlm', 'agentic/code/addons/rlm'],
  ['semantic-memory', 'agentic/code/addons/semantic-memory'],
  ['skill-factory', 'agentic/code/addons/skill-factory'],
  ['star-prompt', 'agentic/code/addons/star-prompt'],
  ['testing-quality', 'agentic/code/addons/testing-quality'],
  ['twelve-factor', 'agentic/code/addons/twelve-factor'],
  ['uat-mcp', 'agentic/code/addons/uat-mcp'],
  ['verbalized-sampling', 'agentic/code/addons/verbalized-sampling'],
];

for (const [id, sourceRoot] of MANIFEST_PLUGIN_SOURCES) {
  if (!fs.existsSync(path.join(ROOT_DIR, sourceRoot, 'manifest.json'))) continue;
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT_DIR, sourceRoot, 'manifest.json'), 'utf8'),
  );
  PLUGIN_CONFIGS[id] = {
    name: id,
    displayName: manifest.name || id,
    version: manifest.version || '1.0.0',
    description: manifest.description || `${manifest.name || id} for AIWG`,
    keywords: manifest.keywords || manifest.tags || [],
    category: manifest.category || 'productivity',
    sourceRoot,
    declaredSkills: manifest.skills ?? [],
    // Plugin payloads run outside the checkout. Rewrite references back to
    // their packaged root, including the pre-rename Ralph path retained by
    // older Agent Loop documentation.
    selfReferenceRoots: id === 'agent-loop'
      ? [sourceRoot, 'agentic/code/addons/ralph']
      : [sourceRoot],
  };
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    all: false,
    plugin: null,
    clean: false,
    dryRun: false
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--check-links':
        options.checkLinks = true;
        break;
      case '--all':
      case '-a':
        options.all = true;
        break;
      case '--plugin':
      case '-p':
        options.plugin = args[++i];
        break;
      case '--provider':
        options.provider = args[++i];
        break;
      case '--source':
        options.source = args[++i];
        break;
      case '--output':
        options.output = args[++i];
        break;
      case '--clean':
      case '-c':
        options.clean = true;
        break;
      case '--dry-run':
      case '-n':
        options.dryRun = true;
        break;
      case '--check':
        options.check = true;
        break;
      case '--help':
      case '-h':
        console.log(`
AIWG Plugin Packager

Usage:
  node tools/plugin/package-plugins.mjs [options]

Options:
  --check-links         Report payload links without writing; exit 1 on offenders
  --all, -a             Package all plugins
  --plugin, -p NAME     Package specific plugin
  --provider NAME       Package for a specific provider
                        (claude, codex, cursor, factory, openclaw, all)
                        Default: claude
  --source PATH         Explicit project-local wrapper source
  --output PATH         Standalone archive output (default: dist/plugins)
  --clean, -c           Clean plugins directory before packaging
  --dry-run, -n         Show what would be done without writing
  --check               Verify all default Claude outputs without writing to the checkout
  --help, -h            Show this help message

Examples:
  node tools/plugin/package-plugins.mjs --all
  node tools/plugin/package-plugins.mjs --plugin sdlc
  node tools/plugin/package-plugins.mjs --all --provider codex
  node tools/plugin/package-plugins.mjs --plugin sdlc --provider cursor
  node tools/plugin/package-plugins.mjs --all --provider all --clean
`);
        process.exit(0);
    }
  }

  return options;
}

// Copy directory recursively
function copyDir(src, dest, dryRun = false, filter = null) {
  const srcPath = path.join(ROOT_DIR, src);

  if (!fs.existsSync(srcPath)) {
    console.log(`  ⚠️  Source not found: ${src}`);
    return 0;
  }

  if (!dryRun) {
    fs.mkdirSync(dest, { recursive: true });
  }

  let copied = 0;
  const entries = fs.readdirSync(srcPath, { withFileTypes: true });

  for (const entry of entries) {
    const srcFile = path.join(srcPath, entry.name);
    const destFile = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copied += copyDir(path.join(src, entry.name), destFile, dryRun, filter);
    } else {
      // Apply filter if provided
      if (filter) {
        const baseName = path.basename(entry.name, '.md');
        if (!filter.includes(baseName)) {
          continue;
        }
      }

      if (dryRun) {
        console.log(`    Would copy: ${entry.name}`);
      } else {
        fs.copyFileSync(srcFile, destFile);
      }
      copied++;
    }
  }

  return copied;
}

function rewritePackagedSelfReferences(pluginDir, roots = []) {
  if (roots.length === 0) return;
  const pending = [pluginDir];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(target);
      } else if (entry.isFile() && /\.(?:md|json|ya?ml)$/.test(entry.name)) {
        const original = fs.readFileSync(target, 'utf8');
        let rewritten = original;
        for (const root of roots) {
          rewritten = rewritten.replaceAll(`${root}/`, '${CLAUDE_PLUGIN_ROOT}/');
        }
        if (rewritten !== original) fs.writeFileSync(target, rewritten, 'utf8');
      }
    }
  }
}

function pruneUndeclaredPackagedSkills(pluginDir, declaredSkills) {
  if (!declaredSkills) return;
  const skillsRoot = path.join(pluginDir, 'skills');
  if (!fs.existsSync(skillsRoot)) return;
  const allowed = new Set(declaredSkills);
  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && !allowed.has(entry.name)) {
      fs.rmSync(path.join(skillsRoot, entry.name), { recursive: true, force: true });
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const skillId = path.basename(entry.name, '.md');
      if (allowed.has(skillId)) {
        const skillDir = path.join(skillsRoot, skillId);
        fs.mkdirSync(skillDir, { recursive: true });
        fs.renameSync(path.join(skillsRoot, entry.name), path.join(skillDir, 'SKILL.md'));
      } else {
        fs.rmSync(path.join(skillsRoot, entry.name), { force: true });
      }
    }
  }
}


export function rewritePublishedLinks(pluginDir, payloadRoot = pluginDir) {
  for (const entry of fs.readdirSync(pluginDir, { withFileTypes: true })) {
    const target = path.join(pluginDir, entry.name);
    if (entry.isDirectory()) rewritePublishedLinks(target, payloadRoot);
    else if (entry.isFile() && entry.name.endsWith('.md')) {
      const body = fs.readFileSync(target, 'utf8');
      const rewritten = rewritePublishedMarkdown(body, target, payloadRoot, ROOT_DIR);
      if (rewritten !== body) fs.writeFileSync(target, rewritten);
    }
  }
}

// Clean plugin directory (except .claude-plugin)
function cleanPlugin(pluginDir) {
  if (!fs.existsSync(pluginDir)) return;

  const entries = fs.readdirSync(pluginDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.endsWith('-plugin') || entry.name === 'clawhub.json') continue;

    const fullPath = path.join(pluginDir, entry.name);
    if (entry.isDirectory()) {
      fs.rmSync(fullPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(fullPath);
    }
  }
}

// Package a single plugin
function packagePlugin(name, config, options) {
  console.log(`\n📦 Packaging ${config.displayName}...`);

  const pluginDir = path.join(options.pluginsDir || PLUGINS_DIR, name);

  if (options.clean) {
    console.log('  🧹 Cleaning existing files...');
    if (!options.dryRun) {
      cleanPlugin(pluginDir);
    }
  }

  // Copy a complete manifest-backed component so cached plugins retain every
  // referenced script/template/schema. Curated legacy bundles continue to use
  // their explicit source maps below.
  if (config.sourceRoot) {
    console.log(`  📁 Copying self-contained source from ${config.sourceRoot}...`);
    const count = copyDir(config.sourceRoot, pluginDir, options.dryRun);
    console.log(`     ${count} files`);
    if (!options.dryRun) {
      rewritePackagedSelfReferences(pluginDir, config.selfReferenceRoots);
      pruneUndeclaredPackagedSkills(pluginDir, config.declaredSkills);
    }
  }

  // Copy sources
  for (const [type, srcPath] of Object.entries(config.sources || {})) {
    const destPath = path.join(pluginDir, type);
    console.log(`  📁 Copying ${type}...`);

    const filter = type === 'agents' && config.agentFilter ? config.agentFilter : null;
    const count = copyDir(srcPath, destPath, options.dryRun, filter);
    console.log(`     ${count} files`);
  }

  // Copy extra files
  for (const extra of config.extraCopy || []) {
    const destPath = path.join(pluginDir, extra.to);
    console.log(`  📁 Copying ${extra.to}...`);
    const sourcePath = path.join(ROOT_DIR, extra.from);
    let count;
    if (fs.statSync(sourcePath).isFile()) {
      count = 1;
      if (!options.dryRun) {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(sourcePath, destPath);
      }
    } else {
      count = copyDir(extra.from, destPath, options.dryRun);
    }
    console.log(`     ${count} files`);
  }

  for (const rewrite of config.rewrites || []) {
    if (options.dryRun) continue;
    const target = path.join(pluginDir, rewrite.file);
    const body = fs.readFileSync(target, 'utf8');
    if (!body.includes(rewrite.from)) {
      throw new Error(`${name}: rewrite source not found in ${rewrite.file}`);
    }
    fs.writeFileSync(target, body.replaceAll(rewrite.from, rewrite.to), 'utf8');
  }

  // Write README
  if (config.readme && !options.dryRun) {
    const readmePath = path.join(pluginDir, 'README.md');
    fs.writeFileSync(readmePath, config.readme);
    console.log('  📄 Created README.md');
  }

  if (!options.dryRun) {
    const manifestDir = path.join(pluginDir, '.claude-plugin');
    fs.mkdirSync(manifestDir, { recursive: true });
    fs.writeFileSync(path.join(manifestDir, 'plugin.json'), `${JSON.stringify({
      name: config.name,
      // Claude caches pinned marketplace plugins by version. AIWG publishes
      // these generated bundles with the repository release, so their
      // distribution version must advance with package.json even when the
      // canonical component's internal schema/API version does not.
      version: RELEASE_VERSION,
      description: config.description,
      author: { name: 'AIWG Contributors', email: 'support@aiwg.io' },
      homepage: 'https://aiwg.io',
      repository: 'https://github.com/jmagly/aiwg',
      license: 'MIT',
      keywords: config.keywords || [],
    }, null, 2)}\n`);
  }

  if (!options.dryRun) rewritePublishedLinks(pluginDir);

  console.log(`  ✅ ${config.displayName} packaged successfully`);
}

function writeClaudeMarketplaceManifest(options) {
  const existingPath = path.join(ROOT_DIR, '.claude-plugin', 'marketplace.json');
  const existing = JSON.parse(fs.readFileSync(existingPath, 'utf8'));
  const external = existing.plugins
    .filter((plugin) => typeof plugin.source !== 'string')
    .map((plugin) => ({
      ...plugin,
      source: plugin.source?.type === 'github'
        ? {
            source: 'github',
            repo: plugin.source.repo,
            ...(plugin.source.branch ? { ref: plugin.source.branch } : {}),
          }
        : plugin.source,
    }));
  const local = Object.entries(PLUGIN_CONFIGS)
    .filter(([, config]) => config.pluginType !== 'codex')
    .map(([name, config]) => ({
      name,
      source: `./agentic/code/plugins/${name}`,
      description: config.description,
      version: RELEASE_VERSION,
      author: { name: 'AIWG Contributors' },
      license: 'MIT',
      category: config.category || 'productivity',
      keywords: config.keywords || [],
    }));
  const manifest = {
    name: existing.name,
    owner: existing.owner,
    description: existing.metadata?.description || existing.description,
    // The marketplace itself is a release artifact and must stay in lockstep
    // with package.json. Preserving the previous manifest value silently
    // leaves stale metadata after a release bump.
    version: RELEASE_VERSION,
    plugins: [...local, ...external],
  };
  if (options.dryRun) {
    console.log(`\n[dry-run] Would write Claude marketplace: ${existingPath}`);
    console.log(`  ${manifest.plugins.length} plugins`);
    return;
  }
  const outputPath = options.marketplacePath || existingPath;
  fs.writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(`\n✓ Wrote Claude marketplace: ${outputPath} (${manifest.plugins.length} plugins)`);
}

// Runtime delegates are generated after copying sources, so regeneration cannot
// replace canonical routing with a checkout-relative implementation copy.
export function writeCanonicalScriptWrappers(pluginDir, wrappers, repoRoot = ROOT_DIR) {
  for (const wrapper of wrappers || []) {
    const target = path.join(pluginDir, wrapper.file);
    const relativeSource = path.relative(path.dirname(target), path.join(repoRoot, wrapper.source)).split(path.sep).join('/');
    const source = JSON.stringify(wrapper.source);
    fs.writeFileSync(target, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const candidates = [
  new URL(${JSON.stringify(relativeSource)}, import.meta.url),
  pathToFileURL(path.resolve(process.cwd(), ${source})),
  pathToFileURL(path.resolve(process.cwd(), 'node_modules/aiwg', ${source})),
];
const source = candidates.find(candidate => fs.existsSync(candidate));
if (!source) throw new Error('Unable to locate the canonical AIWG threat-assessment wrapper');
const canonical = await import(source.href);

${wrapper.exports.map(name => `export const ${name} = canonical.${name};`).join('\n')}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) runCli();
`);
  }
}

// Package a Codex-format plugin (generates .codex-plugin/plugin.json + marketplace.json)
async function packageCodexPlugin(name, config, options) {
  console.log(`\n📦 Packaging ${config.displayName} (Codex plugin format)...`);

  const { generatePluginBundle } = await import(
    path.join(ROOT_DIR, 'tools/agents/providers/codex.mjs')
  );

  generatePluginBundle(ROOT_DIR, {
    dryRun: options.dryRun,
    srcRoot: ROOT_DIR
  });

  const pluginDir = path.join(PLUGINS_DIR, name);

  if (options.clean) {
    console.log('  🧹 Cleaning existing files...');
    if (!options.dryRun) {
      cleanPlugin(pluginDir);
    }
  }

  // Copy sources into the plugin directory for self-containment
  for (const [type, srcPath] of Object.entries(config.sources || {})) {
    const destPath = path.join(pluginDir, type);
    console.log(`  📁 Copying ${type}...`);
    const count = copyDir(srcPath, destPath, options.dryRun);
    console.log(`     ${count} files`);
  }

  // Write README
  if (config.readme && !options.dryRun) {
    const readmePath = path.join(pluginDir, 'README.md');
    fs.writeFileSync(readmePath, config.readme);
    console.log('  📄 Created README.md');
  }

  console.log(`  ✅ ${config.displayName} packaged successfully`);
}

// Package a plugin for a generic provider that exposes generatePluginBundle().
// Used for cursor, factory, openclaw. The provider's generator writes the
// manifest (e.g. .cursor-plugin/plugin.json, .factory-plugin/plugin.json,
// clawhub.json) and this function copies the framework sources alongside.
async function packageProviderPlugin(name, config, options, provider) {
  console.log(`\n📦 Packaging ${config.displayName} (${provider} plugin format)...`);

  const providerModule = await import(
    path.join(ROOT_DIR, `tools/agents/providers/${provider}.mjs`)
  );

  if (typeof providerModule.generatePluginBundle !== 'function') {
    throw new Error(`Provider '${provider}' does not export generatePluginBundle()`);
  }

  const pluginDir = path.join(PLUGINS_DIR, name);

  if (options.clean) {
    console.log('  🧹 Cleaning existing files...');
    if (!options.dryRun) {
      cleanPlugin(pluginDir);
    }
  }

  providerModule.generatePluginBundle(pluginDir, {
    dryRun: options.dryRun,
    srcRoot: ROOT_DIR,
    name: `aiwg-${name}`,
    description: config.description,
  });

  // Copy sources into the plugin directory
  for (const [type, srcPath] of Object.entries(config.sources || {})) {
    const destPath = path.join(pluginDir, type);
    console.log(`  📁 Copying ${type}...`);
    const count = copyDir(srcPath, destPath, options.dryRun);
    console.log(`     ${count} files`);
  }

  // Write README
  if (config.readme && !options.dryRun) {
    const readmePath = path.join(pluginDir, 'README.md');
    fs.writeFileSync(readmePath, config.readme);
    console.log('  📄 Created README.md');
  }

  console.log(`  ✅ ${config.displayName} packaged successfully (${provider})`);
}

// Write a root Codex marketplace.json that aggregates all plugins with
// Codex pluginType. This is the project-level manifest Codex looks for
// when it opens the project.
function writeCodexMarketplaceManifest(options) {
  const codexPlugins = Object.entries(PLUGIN_CONFIGS)
    .filter(([, config]) => config.pluginType === 'codex' || config.supportsCodex !== false)
    .map(([pluginName, config]) => ({
      name: pluginName,
      source: { source: 'local', path: `./agentic/code/plugins/${pluginName}` },
      policy: {
        installation: 'AVAILABLE',
        authentication: 'ON_INSTALL',
      },
      category: config.category || 'Productivity',
      description: config.description,
    }));

  const manifest = {
    name: 'aiwg',
    interface: { displayName: 'AIWG Framework' },
    plugins: codexPlugins,
  };

  const manifestDir = path.join(ROOT_DIR, '.agents', 'plugins');
  const manifestPath = path.join(manifestDir, 'marketplace.json');

  if (options.dryRun) {
    console.log(`\n[dry-run] Would write Codex marketplace: ${manifestPath}`);
    console.log(`  ${codexPlugins.length} plugins`);
    return;
  }

  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  console.log(`\n✓ Wrote Codex project marketplace: ${manifestPath} (${codexPlugins.length} plugins)`);
}

// Compare the same generation logic used by --all, including manifests,
// rewrites and skill pruning. Only default Claude-owned paths are checked:
// provider-native metadata and separately maintained templates are preserved.
export function checkPackagedPlugins({ pluginsDir = PLUGINS_DIR,
  marketplacePath = path.join(ROOT_DIR, '.claude-plugin/marketplace.json') } = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-plugin-check-'));
  const differences = [];
  function files(root) {
    if (!fs.existsSync(root)) return [];
    if (!fs.statSync(root).isDirectory()) return [''];
    return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => (
      files(path.join(root, entry.name)).map(file => path.join(entry.name, file))
    ));
  }
  function compare(expected, actual, label) {
    const paths = new Set([...files(expected), ...files(actual)]);
    for (const file of [...paths].sort()) {
      const generated = path.join(expected, file);
      const checkedIn = path.join(actual, file);
      const name = file ? `${label}/${file}` : label;
      if (!fs.existsSync(generated)) differences.push(`Unexpected: ${name}`);
      else if (!fs.existsSync(checkedIn)) differences.push(`Missing: ${name}`);
      else if (fs.statSync(generated).isDirectory() !== fs.statSync(checkedIn).isDirectory()) differences.push(`Changed type: ${name}`);
      else if (!fs.readFileSync(generated).equals(fs.readFileSync(checkedIn))) differences.push(`Changed: ${name}`);
    }
  }
  try {
    const options = { pluginsDir: path.join(temporary, 'plugins'),
      marketplacePath: path.join(temporary, 'marketplace.json') };
    for (const [name, config] of Object.entries(PLUGIN_CONFIGS)) {
      if (config.pluginType && config.pluginType !== 'claude') continue;
      packagePlugin(name, config, options);
      const generated = path.join(options.pluginsDir, name);
      const actual = path.join(pluginsDir, name);
      const label = `agentic/code/plugins/${name}`;
      if (config.sourceRoot) {
        // Entire manifest-backed addon is generated, except other providers'
        // metadata retained by cleanPlugin().
        const roots = new Set([...fs.readdirSync(generated), ...files(actual).map(file => file.split(path.sep)[0])]);
        for (const root of [...roots].sort()) {
          if ((root.endsWith('-plugin') && root !== '.claude-plugin') || root === 'clawhub.json') continue;
          compare(path.join(generated, root), path.join(actual, root), `${label}/${root}`);
        }
      } else {
        const roots = [...Object.keys(config.sources || {}),
          ...(config.extraCopy || []).map(extra => extra.to), '.claude-plugin/plugin.json'];
        if (config.readme) roots.push('README.md');
        for (const root of roots) compare(path.join(generated, root), path.join(actual, root), `${label}/${root}`);
      }
    }
    writeClaudeMarketplaceManifest(options);
    compare(options.marketplacePath, marketplacePath, '.claude-plugin/marketplace.json');
    return differences;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

// Main function
async function main() {
  const options = parseArgs();

  if (options.check) {
    if (!options.all || options.plugin || options.provider || options.source || options.output || options.clean || options.dryRun || options.checkLinks) {
      throw new Error('--check requires --all and cannot be combined with other packaging options');
    }
    const differences = checkPackagedPlugins();
    if (differences.length) {
      throw new Error(`Generated plugin copies are stale:\n${differences.join('\n')}\nRun npm run package-plugins and review the diff.`);
    }
    console.log('✓ All generated Claude plugin copies match canonical sources.');
    return;
  }

  if (!options.all && !options.plugin) {
    console.log('Please specify --all or --plugin NAME');
    console.log('Use --help for more information');
    process.exit(1);
  }

  console.log('🚀 AIWG Plugin Packager');
  console.log(`   Root: ${ROOT_DIR}`);
  console.log(`   Output: ${PLUGINS_DIR}`);

  if (options.dryRun) {
    console.log('   Mode: DRY RUN (no files will be changed)');
  }

  if (options.plugin && !options.all && !options.checkLinks) {
    const { packageStandalonePlugin } = await importImpl(import.meta.url, 'plugins/standalone-packager.js');
    const standalone = await packageStandalonePlugin({
      cwd: process.cwd(),
      name: options.plugin,
      source: options.source,
      output: options.output,
      provider: options.provider,
      clean: options.clean,
      dryRun: options.dryRun,
    });
    if (standalone) {
      console.log(`   Source: ${standalone.sourceRoot}`);
      for (const plan of standalone.plans) {
        console.log(`   ${options.dryRun ? 'Would write' : 'Wrote'} ${plan.provider}: ${plan.archivePath}`);
      }
      console.log('\n✨ Done!');
      return;
    }
    if (options.source) {
      throw new Error(`Standalone plugin source not found: ${options.source}`);
    }
  }

  // Resolve provider selection
  const PROVIDER_PLUGIN_FORMATS = ['claude', 'codex', 'cursor', 'factory', 'openclaw'];
  const requestedProvider = options.provider || 'claude';
  let providersToRun;

  if (requestedProvider === 'all') {
    providersToRun = PROVIDER_PLUGIN_FORMATS;
  } else if (PROVIDER_PLUGIN_FORMATS.includes(requestedProvider)) {
    providersToRun = [requestedProvider];
  } else {
    console.error(`Unknown provider: ${requestedProvider}`);
    console.log(`Available providers: ${PROVIDER_PLUGIN_FORMATS.join(', ')}, all`);
    process.exit(1);
  }

  console.log(`   Providers: ${providersToRun.join(', ')}`);

  // Determine which plugins to package
  const pluginsToPackage = options.plugin
    ? [[options.plugin, PLUGIN_CONFIGS[options.plugin]]].filter(([, c]) => c)
    : Object.entries(PLUGIN_CONFIGS);

  if (options.plugin && !PLUGIN_CONFIGS[options.plugin]) {
    console.error(`Unknown plugin: ${options.plugin}`);
    console.log(`Available plugins: ${Object.keys(PLUGIN_CONFIGS).join(', ')}`);
    process.exit(1);
  }

  if (options.checkLinks) {
    let count = 0;
    for (const [name] of pluginsToPackage) {
      count += reportPluginLinks(path.join(PLUGINS_DIR, name)).length;
    }
    if (count) process.exitCode = 1;
    return;
  }

  // Package for each (provider, plugin) combination
  for (const provider of providersToRun) {
    for (const [name, config] of pluginsToPackage) {
      // Provider-specific bundles are not part of another provider's catalog.
      if (provider === 'claude' && config.pluginType && config.pluginType !== 'claude') {
        continue;
      }
      const effectiveProvider = provider;

      if (effectiveProvider === 'claude') {
        packagePlugin(name, config, options);
      } else if (effectiveProvider === 'codex') {
        await packageCodexPlugin(name, config, options);
      } else {
        // cursor, factory, openclaw — generic provider plugin bundle
        await packageProviderPlugin(name, config, options, effectiveProvider);
      }
      if (!options.dryRun) {
        const pluginDir = path.join(PLUGINS_DIR, name);
        // Claude already copied extras; other providers need the same docs.
        if (provider !== 'claude') {
          for (const extra of config.extraCopy || []) {
            const destination = path.join(pluginDir, extra.to);
            fs.mkdirSync(path.dirname(destination), { recursive: true });
            fs.cpSync(path.join(ROOT_DIR, extra.from), destination, { recursive: true });
          }
        }
        if (provider !== 'claude') {
          writeCanonicalScriptWrappers(pluginDir, config.scriptWrappers);
          rewritePublishedLinks(pluginDir);
        }
        reportPluginLinks(pluginDir);
      }
    }

    if (provider === 'claude') {
      writeClaudeMarketplaceManifest(options);
    }

    // After packaging for Codex, also write the root marketplace.json
    if (provider === 'codex') {
      writeCodexMarketplaceManifest(options);
    }
  }

  console.log('\n✨ Done!');
  console.log('\nTo test locally:');
  console.log('  /plugin marketplace add ./agentic/code/plugins  # Claude Code');
  console.log('  /plugin install sdlc@aiwg');
  console.log('\nFor other providers:');
  console.log('  aiwg use sdlc --provider codex            # Codex (reads .agents/plugins/marketplace.json)');
  console.log('  aiwg use sdlc --provider cursor           # Cursor (manual install from .cursor-plugin/)');
  console.log('  aiwg use sdlc --provider factory          # Factory (git-URL install from .factory-plugin/)');
  console.log('  aiwg use sdlc --provider openclaw         # OpenClaw (ClawHub publish pending)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
