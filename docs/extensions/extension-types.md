# Extension Types Reference

Complete reference for all AIWG extension types and their metadata schemas.

**Source:** @src/extensions/types.ts

---

## Extension Type Discriminator

```typescript
type ExtensionType =
  | 'agent'        // AI personas with defined roles
  | 'command'      // CLI and slash commands
  | 'skill'        // Natural language workflows
  | 'hook'         // Lifecycle event handlers
  | 'tool'         // External CLI utilities
  | 'mcp-server'   // MCP protocol servers
  | 'framework'    // Complete workflow bundles
  | 'addon'        // Feature extension packs
  | 'template'     // Document templates
  | 'prompt'       // Reusable prompts
  | 'soul'         // Agent identity and character
  | 'behavior'     // Reactive capabilities with hooks
  | 'team';        // Multi-agent team compositions
```

---

## Agent Extensions

Specialized AI personas with defined roles, tools, and workflows.

### AgentMetadata

```typescript
interface AgentMetadata {
  type: 'agent';

  role: string;                     // Agent's primary role

  model: {
    tier: 'haiku' | 'sonnet' | 'opus';
    override?: string;              // Specific model ID override
  };

  tools: string[];                  // Available tools (Read, Write, Bash, etc.)

  template?: string;                // Complexity template
  maxTools?: number;                // Tool count limit
  canDelegate?: boolean;            // Can call other agents
  readOnly?: boolean;               // No Write/Bash allowed

  workflow?: string[];              // Step-by-step process
  expertise?: string[];             // Areas of expertise
  responsibilities?: string[];      // What agent does
}
```

### Model Tiers

| Tier | When to Use | Example Models |
|------|-------------|----------------|
| **haiku** | Simple, repetitive tasks | claude-haiku-4-5 |
| **sonnet** | Most tasks, balanced | claude-sonnet-5 |
| **opus** | Complex reasoning, critical decisions | claude-opus-5 |

### Example

```typescript
{
  id: 'api-designer',
  type: 'agent',
  name: 'API Designer',
  description: 'Defines API styles, endpoints, and data contracts',
  version: '1.0.0',
  capabilities: ['api-design', 'interface-contracts', 'rest'],
  keywords: ['api', 'rest', 'contracts', 'interfaces'],
  category: 'sdlc/architecture',
  platforms: {
    claude: 'full',
    factory: 'full',
    cursor: 'full',
    generic: 'full'
  },
  deployment: {
    pathTemplate: '.{platform}/agents/{id}.md',
    core: false
  },
  requires: ['sdlc-complete'],
  metadata: {
    type: 'agent',
    role: 'API Design and Contract Definition',
    model: {
      tier: 'sonnet'
    },
    tools: ['Read', 'Write', 'Glob', 'Grep'],
    template: 'complex',
    canDelegate: true,
    readOnly: false,
    workflow: [
      'Define interface contracts',
      'Specify data models',
      'Design error handling',
      'Define versioning strategy',
      'Review with stakeholders'
    ],
    expertise: [
      'REST API design',
      'OpenAPI/Swagger specifications',
      'Data contract modeling',
      'API versioning strategies',
      'Performance optimization'
    ],
    responsibilities: [
      'Author interface and data contract cards',
      'Define error models, versioning, and compatibility policy',
      'Review performance, security, and observability for interfaces',
      'Coordinate with Test Engineer on integration tests'
    ]
  }
}
```

---

## Command Extensions

CLI and slash commands with argument parsing and execution logic.

### CommandMetadata

```typescript
interface CommandMetadata {
  type: 'command';

  template: 'utility' | 'transformation' | 'orchestration';

  arguments?: CommandArgument[];
  options?: CommandOption[];
  argumentHint?: string;            // For help display, e.g., "<file-path>"

  allowedTools?: string[];          // Tools this command uses
  model?: string;                   // Preferred model

  executionSteps?: string[];        // What it does
  successCriteria?: string[];       // How to verify success
}

interface CommandArgument {
  name: string;
  description: string;
  required: boolean;
  type: 'string' | 'number' | 'boolean';
  default?: string | number | boolean;
  position?: number;
}

interface CommandOption {
  name: string;
  description: string;
  type: 'string' | 'boolean' | 'number' | 'array';
  default?: string | boolean | number;
  short?: string;                   // e.g., "-f"
  long?: string;                    // e.g., "--fix"
}
```

### Command Templates

| Template | Purpose | Examples |
|----------|---------|----------|
| **utility** | Simple operations | status, version, doctor |
| **transformation** | Data processing | prefill-cards, validate-metadata |
| **orchestration** | Complex workflows | use, ralph, migrate-workspace |

### Example

```typescript
{
  id: 'use',
  type: 'command',
  name: 'Use',
  description: 'Install and deploy framework',
  version: '1.0.0',
  capabilities: ['cli', 'framework', 'deployment'],
  keywords: ['framework', 'install', 'deploy', 'use'],
  category: 'framework',
  platforms: {
    claude: 'full',
    copilot: 'full',
    factory: 'full',
    cursor: 'full',
    generic: 'full'
  },
  deployment: {
    pathTemplate: '.{platform}/commands/{id}.md',
    core: true
  },
  metadata: {
    type: 'command',
    template: 'orchestration',
    argumentHint: '<framework>',
    allowedTools: ['Read', 'Write', 'Bash', 'Glob'],
    arguments: [
      {
        name: 'framework',
        description: 'Framework to deploy',
        required: true,
        type: 'string',
        position: 0
      }
    ],
    options: [
      {
        name: 'provider',
        description: 'Target platform',
        type: 'string',
        default: 'claude',
        long: 'provider'
      },
      {
        name: 'force',
        description: 'Overwrite existing files',
        type: 'boolean',
        default: false,
        long: 'force'
      }
    ],
    executionSteps: [
      'Validate framework name',
      'Check dependencies',
      'Deploy framework files',
      'Register in framework registry',
      'Deploy platform-specific adaptations'
    ]
  }
}
```

---

## Skill Extensions

Natural language workflows triggered by phrases or conditions.

### Required SKILL.md Frontmatter

Every SKILL.md file MUST include these fields in its YAML frontmatter:

| Field | Required | Notes |
|-------|----------|-------|
| `name:` | **Yes** | Kebab-case slug; used for discovery and command generation. |
| `description:` | **Yes (non-empty)** | Used by Claude Code for natural-language invocation. **Codex rejects any SKILL.md without a non-empty `description:` field.** Never leave blank. |
| `version:` | Recommended | Semver (`1.0.0`) or CalVer (`2026.1.5`). |
| `namespace:` | Recommended | `aiwg` for AIWG-owned skills; drives collision avoidance. |
| `platforms:` | Optional | Target platform list (e.g. `[all]`, `[claude, codex]`). |

This table describes canonical AIWG skill-source conventions. Portable Agent
Skills require only `name` and `description`; AIWG-only fields such as
`namespace` and `platforms` are accepted by the compatible profile and moved
outside strict provider frontmatter. See
[Agent Skills import and deployment](../skills/agent-skills.md) for the
complete field mapping and provider lifecycle.

Missing or empty `description:` will cause deployment to fail on Codex and
degrade discoverability on every platform. The `aiwg add-skill` scaffolder,
the SkillSmith generator, and the Codex deployer all enforce this at runtime.

### SkillMetadata

```typescript
interface SkillMetadata {
  type: 'skill';

  namespace?: string;               // Package/vendor identifier (e.g., 'aiwg')
                                    // Canonical slug: '{namespace}-{name}'
                                    // See adr-skill-namespace-strategy.md

  triggerPhrases: string[];         // Natural language triggers
  autoTrigger?: boolean;            // Auto-activate on conditions
  autoTriggerConditions?: string[]; // When to auto-activate

  tools?: string[];                 // Tools this skill uses
  references?: SkillReference[];    // Reference materials

  inputRequirements?: string[];     // What input is needed
  outputFormat?: string;            // Expected output format
}

interface SkillReference {
  filename: string;
  description: string;
  path: string;
}
```

### Example

```typescript
{
  id: 'project-awareness',
  type: 'skill',
  name: 'Project Awareness',
  description: 'Comprehensive project context detection',
  version: '1.0.0',
  capabilities: ['context-awareness', 'project-detection', 'phase-tracking'],
  keywords: ['project', 'context', 'awareness', 'status', 'phase', 'sdlc'],
  category: 'sdlc/management',
  platforms: {
    claude: 'full',
    factory: 'full',
    cursor: 'experimental'
  },
  deployment: {
    pathTemplate: '.{platform}/skills/aiwg/{name}/SKILL.md',  // namespaced subdir
    additionalFiles: ['references/phase-guide.md'],
    core: true,
    autoInstall: true
  },
  requires: ['aiwg-utils'],
  metadata: {
    type: 'skill',
    namespace: 'aiwg',               // Canonical invocation: /aiwg-project-awareness
    triggerPhrases: [
      'what project is this',
      'project context',
      'what phase are we in',
      'where are we?',
      "what's next?",
      'project status'
    ],
    autoTrigger: true,
    autoTriggerConditions: ['session-start'],
    tools: ['Read', 'Bash', 'Glob'],
    references: [
      {
        filename: 'phase-guide.md',
        description: 'SDLC phase descriptions and gate criteria',
        path: 'references/phase-guide.md'
      }
    ]
  }
}
```

### Skill Namespace Strategy

All AIWG-owned skills declare `namespace: aiwg` in their SKILL.md frontmatter. This drives collision avoidance and ownership attribution.

**Canonical invocation slug:** `{namespace}-{name}` → e.g., `aiwg-sync`, `aiwg-run`

**Deployment layout:**

```
.claude/skills/aiwg/aiwg-sync/SKILL.md    ← canonical (unlimited-recursion platforms)
.windsurf/skills/aiwg-sync/SKILL.md       ← Windsurf (1-level limit; no subdir)
.agents/skills/aiwg/aiwg-sync/SKILL.md    ← universal cross-platform path
```

**Frontmatter example:**

```yaml
name: sync
namespace: aiwg
description: Sync to latest version and re-deploy all frameworks
type: skill
```

Short aliases (`/sync`) are opt-in via `aiwg use sdlc --aliases` and suppressed when a conflict is detected. See `.aiwg/architecture/adr-skill-namespace-strategy.md` for the full decision record.

---

## Hook Extensions

Lifecycle event handlers for session, command, and tool events.

### HookMetadata

```typescript
interface HookMetadata {
  type: 'hook';

  event: HookEvent;                 // When to trigger
  priority?: number;                // Execution order (lower = earlier)
  canModify?: boolean;              // Can change execution context
  canBlock?: boolean;               // Can prevent execution

  configSchema?: Record<string, unknown>;
}

type HookEvent =
  | 'pre-session'     // Session start
  | 'post-session'    // Session end
  | 'pre-command'     // Before command runs
  | 'post-command'    // After command completes
  | 'pre-agent'       // Before agent invocation
  | 'post-agent'      // After agent completes
  | 'pre-write'       // Before file write
  | 'post-write'      // After file write
  | 'pre-bash'        // Before bash execution
  | 'post-bash';      // After bash completes
```

### Event Timing

| Event | Timing | Can Block | Common Uses |
|-------|--------|-----------|-------------|
| `pre-session` | Session start | No | Load context, setup state |
| `post-session` | Session end | No | Cleanup, save state |
| `pre-command` | Before command | Yes | Validation, permission checks |
| `post-command` | After command | No | Logging, notifications |
| `pre-agent` | Before agent invocation | Yes | Context injection, authorization |
| `post-agent` | After agent completes | No | Result validation, logging |
| `pre-write` | Before file write | Yes | Format checking, security review |
| `post-write` | After file write | No | Git operations, notifications |
| `pre-bash` | Before bash execution | Yes | Security checks, sandboxing |
| `post-bash` | After bash completes | No | Result validation, cleanup |

---

## Tool Extensions

External CLI utilities with discovery and verification.

### ToolMetadata

```typescript
interface ToolMetadata {
  type: 'tool';

  category: 'core' | 'languages' | 'utilities' | 'custom';
  executable: string;               // Command name

  verificationStatus?: 'verified' | 'unverified';
  lastVerified?: string;            // ISO 8601 date

  manPage?: string;                 // Manual page content
  aliases?: string[];               // Alternative names
  relatedTools?: string[];          // Similar tools

  platformNotes?: Record<string, string>;
  installHint?: string;             // How to install if missing
}
```

### Tool Categories

| Category | Purpose | Examples |
|----------|---------|----------|
| **core** | Essential tools | bash, sh, zsh |
| **languages** | Language toolchains | node, python, ruby, go |
| **utilities** | Helper tools | git, jq, curl, grep |
| **custom** | Project-specific tools | custom scripts, domain tools |

---

## MCP Server Extensions

Model Context Protocol servers with capabilities and tools.

### MCPServerMetadata

```typescript
interface MCPServerMetadata {
  type: 'mcp-server';

  mcpVersion: string;               // e.g., "1.0"
  transport: 'stdio' | 'http';
  port?: number;                    // For HTTP transport

  capabilities: {
    tools: boolean;
    resources: boolean;
    prompts: boolean;
    sampling: boolean;
    logging: boolean;
  };

  sourceType: 'cli' | 'api' | 'catalog' | 'nl' | 'extension';
  sourceCommand?: string;           // For CLI source
  sourceBaseUrl?: string;           // For API source

  workingDirectory?: string;
  environment?: Record<string, string>;

  tools?: MCPToolSummary[];
  resources?: string[];
  prompts?: string[];
}

interface MCPToolSummary {
  name: string;
  description: string;
  dangerous: boolean;
}
```

---

## Framework Extensions

Complete workflows that bundle multiple extensions.

### FrameworkMetadata

```typescript
interface FrameworkMetadata {
  type: 'framework';

  domain: string;                   // e.g., "sdlc", "marketing", "security"

  includes: {
    agents?: string[];              // Included agent IDs
    commands?: string[];            // Included command IDs
    skills?: string[];              // Included skill IDs
    hooks?: string[];               // Included hook IDs
    templates?: string[];           // Included template IDs
    prompts?: string[];             // Included prompt IDs
  };

  configSchema?: Record<string, unknown>;
  defaultConfig?: Record<string, unknown>;
}
```

### memory field (optional, top-level)

Frameworks that create `.aiwg/` paths should declare them in a top-level `memory` field. This makes those paths "normalized" — safe to reference from skills and agents. See [`.aiwg/` Reference Contract](../development/aiwg-dir-reference-contract.md) for full details.

```typescript
// In manifest.json (top-level, alongside id/type/name)
memory?: {
  creates?: Array<{
    path: string;        // e.g., ".aiwg/requirements/"
    description: string; // e.g., "User stories, use cases, NFRs"
  }>;
  normalizedFiles?: Array<{
    path: string;        // e.g., ".aiwg/AIWG.md"
    description: string; // e.g., "Project context entry point"
  }>;
  topology?: MemoryTopology; // Semantic memory contract (see below)
}
```

### memory.topology field (optional)

When present, declares a semantic memory topology that kernel skills (`memory-ingest`, `memory-lint`, `memory-query-capture`) can operate on. The kernel reads this contract to parameterize topology-agnostic behavior.

See [ADR-021](https://github.com/jmagly/aiwg/blob/main/.aiwg/architecture/decisions/ADR-021-semantic-memory-kernel.md) for architectural decisions.

```typescript
interface MemoryTopology {
  namespace: string;                    // Root path under .aiwg/ (e.g., ".aiwg/research")
  rawSources: string;                   // Where original sources are stored
  derivedPages: Record<string, string>; // Page category → directory path
  index: string;                        // Master index file path
  log: string;                          // JSON Lines event log path (.log.jsonl)
  crossRefStyle: CrossRefStyle;         // How pages link to each other
  pageTemplate?: string;                // Template for new derived pages
  ingestRequires?: string[];            // Capabilities required during ingest
  lintRules?: string[];                 // Lint rule IDs to apply
}

type CrossRefStyle = 'at-mention' | 'wikilink' | 'markdown-link' | 'yaml-ref';
```

| Field | Required | Description |
|-------|----------|-------------|
| `namespace` | Yes | Root `.aiwg/` path for this consumer's memory |
| `rawSources` | Yes | Directory for original/unprocessed sources |
| `derivedPages` | Yes | Map of semantic roles to storage directories |
| `index` | Yes | Path to the master index file |
| `log` | Yes | Path to the append-only `.log.jsonl` event log |
| `crossRefStyle` | Yes | Cross-reference syntax (`at-mention`, `wikilink`, `markdown-link`, `yaml-ref`) |
| `pageTemplate` | No | Template used when creating derived pages |
| `ingestRequires` | No | Capabilities checked during ingest (e.g., `"provenance"`, `"grade-quality"`) |
| `lintRules` | No | Existing rule/skill IDs composed with kernel structural checks |

**Example** (research-complete):

```json
{
  "memory": {
    "creates": [ ... ],
    "topology": {
      "namespace": ".aiwg/research",
      "rawSources": ".aiwg/research/sources",
      "derivedPages": {
        "summary": ".aiwg/research/findings",
        "entity": ".aiwg/research/knowledge/entities",
        "concept": ".aiwg/research/knowledge/concepts",
        "synthesis": ".aiwg/research/synthesis"
      },
      "index": ".aiwg/research/index.md",
      "log": ".aiwg/research/.log.jsonl",
      "crossRefStyle": "at-mention",
      "pageTemplate": "templates/research-page.md",
      "ingestRequires": ["provenance", "grade-quality"],
      "lintRules": ["citation-guard", "link-check", "mention-lint"]
    }
  }
}
```

**Cross-reference styles**:

| Style | Syntax | Used by |
|-------|--------|---------|
| `at-mention` | `@path/to/page.md` | AIWG frameworks (sdlc, research, forensics) |
| `wikilink` | `[[Page Name]]` | Obsidian / llm-wiki addon |
| `markdown-link` | `[text](path)` | Standard markdown, GitHub rendering |
| `yaml-ref` | `refs: [path]` in frontmatter | Machine-first schemas, Dataview queries |

AIWG internal tooling (`mention-wire`, `mention-lint`) uses `at-mention` exclusively regardless of consumer declaration.

```
```

### Example

```typescript
{
  id: 'sdlc-complete',
  type: 'framework',
  name: 'SDLC Complete',
  description: 'Full software development lifecycle framework',
  version: '1.0.0',
  capabilities: ['sdlc', 'agile', 'multi-agent', 'orchestration'],
  keywords: ['sdlc', 'agile', 'software', 'development'],
  category: 'sdlc',
  platforms: {
    claude: 'full',
    copilot: 'full',
    factory: 'full',
    cursor: 'full',
    generic: 'full'
  },
  deployment: {
    pathTemplate: '.aiwg/frameworks/{id}/',
    core: true
  },
  metadata: {
    type: 'framework',
    domain: 'sdlc',
    includes: {
      agents: [
        'api-designer',
        'test-engineer',
        'code-reviewer',
        // ... 35+ agents
      ],
      commands: [
        'use',
        'status',
        'prefill-cards',
        // ... all CLI commands
      ],
      skills: [
        'project-awareness',
        'phase-transition',
        'gap-detection'
      ],
      templates: [
        'use-case',
        'architecture-doc',
        'test-plan'
      ]
    }
  }
}
```

---

## Addon Extensions

Feature bundles that extend frameworks.

### AddonMetadata

```typescript
interface AddonMetadata {
  type: 'addon';

  entry: {
    agents?: string;                // Path to agent definitions
    commands?: string;              // Path to command definitions
    skills?: string;                // Path to skill definitions
    hooks?: string;                 // Path to hook definitions
    templates?: string;             // Path to template definitions
    prompts?: string;               // Path to prompt definitions
  };

  provides: {
    agents?: string[];              // IDs of provided agents
    commands?: string[];            // IDs of provided commands
    skills?: string[];              // IDs of provided skills
    hooks?: string[];               // IDs of provided hooks
    templates?: string[];           // IDs of provided templates
    prompts?: string[];             // IDs of provided prompts
  };
}
```

---

## Template Extensions

Document scaffolds with named variables and sections, used to generate
SDLC artifacts (use cases, ADRs, test plans, architecture docs, etc.).
Templates ship as markdown/YAML/JSON files with placeholder variables;
agents and skills populate the variables when generating artifacts.

### Deployment Paths

Templates are typically bundled inside frameworks rather than deployed
to per-platform paths. The framework manifest's `metadata.includes.templates`
references template IDs, and templates live under the framework's
`templates/` subdirectory. Some addons deploy templates per platform via
`pathTemplate: '.{platform}/templates/{id}.md'`.

| Platform | Path |
|----------|------|
| Bundled in framework | `agentic/code/frameworks/{framework}/templates/{id}.md` |
| Per-platform (rare) | `.{platform}/templates/{id}.md` |

### Required Fields

- `format` — Template language (`markdown`, `yaml`, `json`, `handlebars`)

### Optional Fields

- `variables` — Typed variable definitions consumed during fill-in
- `sections` — Named sections present in the template body
- `targetArtifact` — Logical artifact this template produces
  (`use-case`, `architecture-doc`, `test-plan`, etc.)

### TemplateMetadata

```typescript
interface TemplateMetadata {
  type: 'template';

  format: string;                   // e.g., "markdown", "yaml", "json"

  variables?: TemplateVariable[];
  sections?: string[];              // Section names
  targetArtifact?: string;          // e.g., "use-case", "architecture-doc"
}

interface TemplateVariable {
  name: string;
  description: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  required: boolean;
  default?: unknown;
}
```

### Example

```json
{
  "id": "use-case-template",
  "type": "template",
  "name": "Use Case Template",
  "description": "Template for documenting use cases with actors, flows, and exceptions",
  "version": "1.0.0",
  "capabilities": ["documentation", "requirements", "use-case"],
  "keywords": ["use-case", "requirements", "template"],
  "category": "sdlc/requirements",
  "platforms": { "claude": "full", "generic": "full" },
  "deployment": {
    "pathTemplate": "agentic/code/frameworks/sdlc-complete/templates/{id}.md"
  },
  "metadata": {
    "type": "template",
    "format": "markdown",
    "targetArtifact": "use-case",
    "sections": ["actors", "preconditions", "main-flow", "alternate-flows", "exceptions"],
    "variables": [
      { "name": "useCaseId", "description": "Unique use case identifier", "type": "string", "required": true },
      { "name": "actor", "description": "Primary actor", "type": "string", "required": true },
      { "name": "priority", "description": "Priority", "type": "string", "required": false, "default": "Medium" }
    ]
  }
}
```

### Related References

- `template-engine` skill — load, validate, and populate templates
- `prefill-cards` skill — auto-populate template metadata headers
- @agentic/code/frameworks/sdlc-complete/templates/ — 100+ ready-to-use templates

---

## Prompt Extensions

Reusable prompt fragments with declared purpose and required context.
Prompts are smaller than skills — a prompt is a parameterized chunk of
instructions that an agent or skill composes into a larger workflow.
Use prompts for repeated framing (review checklists, role primers,
reliability reminders) that multiple agents or skills consume.

### Deployment Paths

Prompts deploy alongside skills/commands on platforms that have a prompts
directory, and bundled inside frameworks otherwise.

| Platform | Path |
|----------|------|
| Claude Code | `.claude/prompts/{id}.md` |
| Codex | `~/.codex/prompts/{id}.md` |
| GitHub Copilot | `.github/prompts/{id}.md` |
| Bundled in framework | `agentic/code/frameworks/{framework}/prompts/{id}.md` |

### Required Fields

- `category` — Classification (`core`, `reliability`, `agents`, `review`, etc.)
- `purpose` — What this prompt accomplishes
- `useWhen` — Situations where the prompt should be composed in

### Optional Fields

- `variables` — Names of placeholder variables in the prompt body
- `requiredContext` — Context the caller must inject for the prompt to work

### PromptMetadata

```typescript
interface PromptMetadata {
  type: 'prompt';

  category: string;                 // e.g., "core", "reliability", "agents"
  purpose: string;                  // What this prompt does
  useWhen: string[];                // When to use this prompt

  variables?: string[];             // Variable names
  requiredContext?: string[];       // Required context
}
```

### Example

```json
{
  "id": "review-checklist",
  "type": "prompt",
  "name": "Code Review Checklist",
  "description": "Reusable checklist prompt for code review agents",
  "version": "1.0.0",
  "capabilities": ["code-review", "quality"],
  "keywords": ["review", "checklist", "quality"],
  "category": "review",
  "platforms": { "claude": "full", "generic": "full" },
  "deployment": {
    "pathTemplate": ".{platform}/prompts/{id}.md"
  },
  "metadata": {
    "type": "prompt",
    "category": "review",
    "purpose": "Provide a consistent review checklist that any reviewer agent can compose into its own prompt",
    "useWhen": [
      "Code review agent invocation",
      "PR-review skill execution",
      "Pre-merge gate validation"
    ],
    "variables": ["filePath", "language", "changeScope"],
    "requiredContext": ["diff", "test-results"]
  }
}
```

### Related References

- `pr-review` skill — composes review prompts into multi-perspective reviews
- `review-synthesis` skill — aggregates multi-reviewer feedback
- @agentic/code/frameworks/sdlc-complete/prompts/ — bundled review and reliability prompts

---

## Soul Extensions

Agent identity and character definitions based on the
[soul.md specification](https://github.com/aaronjmars/soul.md). A soul
declares *who* an agent is — worldview, opinions, vocabulary, boundaries —
distinct from *how* it sounds (voice profile) or *what* it does (skill /
agent definition). Souls are scoped either project-wide (one identity for
all agents) or per-agent (a specific character for one agent).

### Deployment Paths

Souls deploy as `SOUL.md` files. Project-scoped souls live at the project
root for each platform; agent-scoped souls live alongside the agent file
with a `.soul.md` companion suffix.

| Platform | Project-scoped | Agent-scoped |
|----------|----------------|--------------|
| Claude Code | `.claude/SOUL.md` | `.claude/agents/{agent}.soul.md` |
| Cursor | `.cursor/SOUL.md` | `.cursor/agents/{agent}.soul.md` |
| OpenClaw | `~/.openclaw/SOUL.md` | `~/.openclaw/agents/{agent}.soul.md` |
| Generic | `SOUL.md` (project root) | `agents/{agent}.soul.md` |

The `soul-enable` skill wires SOUL.md into platform context files;
`soul-disable` reverses it without deleting the source.

### Required Fields

- `scope` — `project` or `agent`
- `sections` — Sections present in the SOUL.md body
  (commonly `who-i-am`, `worldview`, `opinions`, `vocabulary`, `boundaries`)

### Optional Fields

- `targetAgent` — Required when `scope` is `agent`; the agent name this soul applies to
- `companions` — Related files (`STYLE.md`, `MEMORY.md`, `examples/`)
- `estimatedTokens` — Context budget estimate

### SoulMetadata

```typescript
interface SoulMetadata {
  type: 'soul';

  scope: 'project' | 'agent';      // Project-wide or agent-specific
  targetAgent?: string;              // Required when scope is 'agent'

  sections: string[];               // Sections present (who-i-am, worldview, etc.)

  companions?: {
    style?: string;                  // STYLE.md path
    memory?: string;                 // MEMORY.md path
    examples?: string;               // Examples directory path
  };

  estimatedTokens?: number;          // Context budget estimate
}
```

### Soul Sections

| Section | Purpose |
|---------|---------|
| `who-i-am` | Core identity statement |
| `worldview` | Perspective and philosophy |
| `opinions` | Held positions and stances |
| `vocabulary` | Preferred and avoided language |
| `boundaries` | What this agent will/won't do |

### Example

```typescript
{
  id: 'project-soul',
  type: 'soul',
  name: 'Project Soul',
  description: 'Project-wide AI identity and character definition',
  version: '1.0.0',
  capabilities: ['identity', 'character', 'voice'],
  keywords: ['soul', 'identity', 'character', 'personality'],
  category: 'identity',
  platforms: {
    claude: 'full',
    cursor: 'full',
    generic: 'full'
  },
  deployment: {
    pathTemplate: '.{platform}/SOUL.md',
    core: false
  },
  metadata: {
    type: 'soul',
    scope: 'project',
    sections: ['who-i-am', 'worldview', 'opinions', 'vocabulary', 'boundaries'],
    companions: {
      style: 'STYLE.md',
      memory: 'MEMORY.md'
    },
    estimatedTokens: 2000
  }
}
```

### Related References

- `soul-create`, `soul-enhance`, `soul-validate`, `soul-blend` — authoring skills
- `soul-apply` — apply a soul during content generation
- `soul-to-voice` / `voice-to-soul` — convert between soul and voice profiles
- @agentic/code/addons/voice-framework/ — voice profile companion ecosystem
- @agentic/code/frameworks/sdlc-complete/agents/*.soul.md — agent-scoped soul examples

---

## Behavior Extensions

Reactive capabilities with scripts, event hooks, and structured inputs. Behaviors extend beyond skills by subscribing to system events and reacting automatically. On platforms without hook support, behaviors degrade gracefully to skills (NLP triggers only).

### Deployment Paths

Behaviors deploy as a directory containing `BEHAVIOR.md` plus an optional
`scripts/` subdirectory. OpenClaw is the reference implementation with
native hook support; other platforms emulate via the AIWG daemon.

| Platform | Path | Hook Support |
|----------|------|--------------|
| OpenClaw | `~/.openclaw/behaviors/{id}/` | Native |
| Claude Code | `.claude/behaviors/{id}/` | Partial (via settings.json hooks) |
| Cursor | `.cursor/behaviors/{id}/` | Emulated (daemon) |
| Warp | `.warp/behaviors/{id}/` | Emulated (daemon) |
| Copilot | `.github/behaviors/{id}/` | Emulated (daemon) |
| Windsurf | `.windsurf/behaviors/{id}/` | Emulated (daemon) |
| Factory | `.factory/behaviors/{id}/` | Emulated (daemon) |
| Codex | `~/.codex/behaviors/{id}/` | Emulated (daemon) |
| OpenCode | `.opencode/behaviors/{id}/` | Emulated (daemon) |

### Required Fields

At least one of `triggerPhrases`, `hooks`, or `scripts` must be present —
a behavior with none of these has no way to activate.

### Optional Fields

- `triggerPhrases` — NLP invocation phrases (parallel to skills)
- `inputs` — Structured typed input parameters
- `hooks` — Event subscriptions (`on_file_write`, `on_schedule`, etc.)
- `scripts` — Logical name to script path map
- `manifest` — Category, runtime requires, declared outputs, composability

### BehaviorMetadata

```typescript
interface BehaviorMetadata {
  type: 'behavior';

  triggerPhrases?: string[];         // NLP invocation triggers (same as skills)

  inputs?: BehaviorInput[];          // Structured, typed input parameters

  hooks?: Partial<Record<BehaviorHookEvent, BehaviorHookAction[]>>;

  scripts?: Record<string, string>;  // Logical name → relative script path

  manifest?: {
    category?: string;               // Discovery category
    requires?: {
      bins?: string[];               // Required binaries
      env?: string[];                // Required environment variables
    };
    outputs?: Array<{
      type: string;
      path: string;
    }>;
    composable_with?: string[];      // Compatible behaviors
  };
}

interface BehaviorInput {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'path';
  required?: boolean;
  description?: string;
  default?: string | number | boolean;
  values?: string[];                 // Allowed values (for enum type)
}

interface BehaviorHookAction {
  filter?: string;                   // Glob filter for file-based events
  tool?: string;                     // Tool name filter for on_tool_complete
  cron?: string;                     // Cron expression for on_schedule
  action: 'run_script' | 'notify' | 'log';
  script?: string;                   // Script path (relative to behavior dir)
}

type BehaviorHookEvent =
  | 'on_file_write'
  | 'on_tool_complete'
  | 'on_schedule'
  | 'on_commit'
  | 'on_pr_open'
  | 'on_deploy'
  | 'on_session_start'
  | 'on_session_end';
```

### BEHAVIOR.md File Format

Behaviors are defined as directories containing a `BEHAVIOR.md` file and an optional `scripts/` subdirectory:

```
my-behavior/
  BEHAVIOR.md          # Behavior definition (YAML frontmatter + markdown body)
  scripts/
    main.sh            # Primary script
    on-write.sh        # Hook-specific scripts
```

The `BEHAVIOR.md` file uses YAML frontmatter for structured metadata and a markdown body for LLM instructions:

```yaml
---
name: security-sentinel
version: 1.0.0
description: Continuous security monitoring with reactive scanning.
platforms: [openclaw, claude-code]

triggers:
  - "run security scan"
  - "check for vulnerabilities"

inputs:
  - name: target
    type: string
    required: true
    description: File or directory to scan
  - name: severity
    type: enum
    values: [low, medium, high, critical]
    default: medium

hooks:
  on_file_write:
    - filter: "**/*.ts"
      action: run_script
      script: scripts/lint-on-write.sh
  on_schedule:
    - cron: "*/30 * * * *"
      action: run_script
      script: scripts/periodic-audit.sh

scripts:
  main: scripts/main.sh
  lint-on-write: scripts/lint-on-write.sh
  periodic-audit: scripts/periodic-audit.sh

manifest:
  category: security
  requires:
    bins: [npm, node]
  outputs:
    - type: report
      path: .aiwg/reports/security/
  composable_with: [code-review, test-runner]
---

# Security Sentinel

When triggered via NLP, run the main security scan against the specified target.
When triggered via hooks, run the event-appropriate script automatically.
```

### Behavior Lifecycle

| Phase | Description | Trigger |
|-------|-------------|---------|
| **Deploy** | Behavior directory copied to provider target | `aiwg use` |
| **Activate** | Hooks registered with platform event system | Session/daemon start |
| **Execute** | Script runs on event match or NLP invocation | Runtime trigger |
| **Deactivate** | Hooks unregistered, resources released | Session end / `aiwg remove` |

### Provider Support Matrix

| Provider | Support | Mechanism | Hooks | NLP Triggers |
|----------|---------|-----------|-------|-------------|
| OpenClaw | Native | `~/.openclaw/behaviors/` | Full | Full |
| Claude Code | Emulated | Pre/post-tool hooks in settings | Partial | Full |
| Warp | Emulated | WARP.md behavior section | None | Full |
| Cursor | Emulated | Rules-based activation | None | Full |
| Copilot | Emulated | Instructions-based activation | None | Full |
| Windsurf | Emulated | Rules-based activation | None | Full |
| Factory AI | Emulated | Rules-based activation | None | Full |
| Codex | Emulated | Rules-based activation | None | Full |
| OpenCode | Emulated | Rules-based activation | None | Full |

On platforms without hook support, behaviors degrade to skills — only the `triggers` and markdown body are used. The `hooks` section is ignored.

### Hook Events

| Event | Fires When | Common Uses |
|-------|-----------|-------------|
| `on_file_write` | A file is written/modified | Linting, format checking |
| `on_tool_complete` | A tool finishes execution | Post-build verification |
| `on_schedule` | Cron schedule matches | Periodic audits, health checks |
| `on_commit` | A git commit is created | Pre-commit validation |
| `on_pr_open` | A pull request is opened | Code review automation |
| `on_deploy` | A deployment is triggered | Pre/post-deploy checks |
| `on_session_start` | A session begins | Context loading, greeting |
| `on_session_end` | A session ends | Cleanup, state persistence |

### Graceful Degradation

Behaviors are designed for cross-platform portability:

1. **Full support** (OpenClaw): All hooks fire, scripts execute, structured inputs work
2. **Partial support** (Claude Code): File-write and tool hooks via settings.json hook system
3. **NLP-only** (all others): Behavior degrades to a skill — triggers and markdown body only

This ensures the same `BEHAVIOR.md` file works everywhere, at the highest capability level each platform supports.

### Example

```typescript
{
  id: 'build-monitor',
  type: 'behavior',
  name: 'Build Monitor',
  description: 'Track build health with reactive monitoring',
  version: '1.0.0',
  capabilities: ['build-monitoring', 'ci', 'health-check'],
  keywords: ['build', 'monitor', 'ci', 'health'],
  category: 'build',
  platforms: {
    openclaw: 'full',
    claude: 'partial',
    generic: 'partial'
  },
  deployment: {
    pathTemplate: '.{platform}/behaviors/{id}/BEHAVIOR.md',
    additionalFiles: ['scripts/main.sh', 'scripts/post-build-check.sh']
  },
  metadata: {
    type: 'behavior',
    triggerPhrases: ['monitor build', 'check build health', 'build status'],
    inputs: [
      {
        name: 'command',
        type: 'string',
        required: false,
        description: 'Build command to run',
        default: 'npm run build'
      }
    ],
    hooks: {
      on_tool_complete: [
        { tool: 'build', action: 'run_script', script: 'scripts/post-build-check.sh' }
      ],
      on_schedule: [
        { cron: '0 */4 * * *', action: 'run_script', script: 'scripts/scheduled-build.sh' }
      ]
    },
    scripts: {
      main: 'scripts/main.sh',
      'post-build-check': 'scripts/post-build-check.sh'
    },
    manifest: {
      category: 'build',
      requires: { bins: ['node'] },
      outputs: [{ type: 'report', path: '.aiwg/reports/build/' }],
      composable_with: ['test-watcher']
    }
  }
}
```

---

## Platform Compatibility

All extensions declare platform support:

```typescript
interface PlatformCompatibility {
  claude?: PlatformSupport;
  factory?: PlatformSupport;
  cursor?: PlatformSupport;
  copilot?: PlatformSupport;
  windsurf?: PlatformSupport;
  codex?: PlatformSupport;
  opencode?: PlatformSupport;
  generic?: PlatformSupport;
  openclaw?: PlatformSupport;
}

type PlatformSupport =
  | 'full'          // Fully supported with all features
  | 'partial'       // Supported with limitations
  | 'experimental'  // Experimental support
  | 'none';         // Not supported
```

---

## Deployment Configuration

```typescript
interface DeploymentConfig {
  pathTemplate: string;             // Base path with variables
  pathOverrides?: Record<string, string>;
  additionalFiles?: string[];       // Additional files to deploy
  autoInstall?: boolean;            // Auto-install on framework deployment
  core?: boolean;                   // Core extension (always available)
}
```

**Path variables:**

- `{platform}` - Target platform (claude, copilot, etc.)
- `{id}` - Extension ID
- `{type}` - Extension type

**Path examples:**

- `.{platform}/agents/{id}.md` → `.claude/agents/api-designer.md`
- `.{platform}/commands/{id}.md` → `.github/agents/use.md`
- `.{platform}/skills/{id}/SKILL.md` → `.cursor/skills/project-awareness/SKILL.md`

---

## Validation Rules

All extensions must pass validation:

```typescript
interface ValidationRules {
  required: string[];                           // Required fields
  types: Record<string, string>;               // Field type constraints
  patterns: Record<string, string>;            // Regex patterns
  constraints: Record<string, Constraint>;     // Value constraints
  crossFieldRules: CrossFieldRule[];           // Cross-field validation
  typeSpecificRules: Record<ExtensionType, ValidationRules>;
}
```

**Required fields for all extensions:**

- `id` - Unique identifier (kebab-case)
- `type` - Extension type
- `name` - Human-readable name
- `description` - Brief description (10-500 characters)
- `version` - Semantic version
- `capabilities` - At least one capability
- `keywords` - At least one keyword
- `platforms` - At least one platform
- `deployment` - Deployment configuration
- `metadata` - Type-specific metadata

---

## Team Extensions

Multi-agent team compositions that work across all AIWG providers. A team
groups 2–8 agents with assigned roles (lead, contributor, reviewer,
advisor), an execution mode (parallel, sequential, consensus), and
optional inter-agent handoffs. On Claude Code, teams invoke agents
natively via the Task tool; on all other providers, teams are emulated
via `aiwg mc` (Mission Control) orchestration.

**Source format:** JSON files in `agentic/code/frameworks/*/teams/`
**Schema:** `agentic/code/frameworks/sdlc-complete/teams/schema.json`
**CLI:** `aiwg team run|list|info`

### Deployment Paths

Teams ship as part of their parent framework rather than per-platform.
Project-local teams in `.aiwg/teams/<slug>.json` take precedence over
framework-bundled teams.

| Source | Path |
|--------|------|
| Framework-bundled | `agentic/code/frameworks/{framework}/teams/{slug}.json` |
| Project-local | `.aiwg/teams/{slug}.json` |

### Required Fields

- `name` — Human-readable team name
- `slug` — Kebab-case CLI identifier
- `description` — One-line purpose
- `agents` — 2–8 team members with `agent` and `role`

### Optional Fields

- `dispatch` — Execution mode (`parallel`, `sequential`, `consensus`)
- `use_cases` — Scenarios where this team excels
- `handoffs` — Inter-agent artifact passing with quality gates
- `sdlc_phases` — Active SDLC phases (Inception, Elaboration, etc.)
- `max_context_agents` — Context budget cap (2–4)
- `overlap_resolution` — Capability conflict resolution rules

### TeamDefinition

```typescript
interface TeamDefinition {
  name: string;                             // Human-readable team name
  slug: string;                             // CLI identifier (kebab-case)
  description: string;                      // One-line purpose
  dispatch?: 'parallel' | 'sequential' | 'consensus';  // Execution mode
  agents: TeamMember[];                     // 2-8 agents
  use_cases?: string[];                     // Scenarios where team excels
  handoffs?: TeamHandoff[];                 // Inter-agent artifact passing
  sdlc_phases?: string[];                   // Active SDLC phases
  max_context_agents?: number;              // Context budget limit (2-4)
  overlap_resolution?: Record<string, string>;  // Capability conflict resolution
}

interface TeamMember {
  agent: string;                            // Agent filename without .md
  role: 'lead' | 'contributor' | 'reviewer' | 'advisor';
  responsibilities?: string[];
}

interface TeamHandoff {
  from: string;                             // Source agent
  to: string;                               // Target agent
  artifact: string;                         // What gets passed
  gate: string;                             // Quality check before handoff
}
```

### Provider Routing

| Provider | Native Teams | Fallback |
|----------|-------------|---------|
| Claude Code | Native agent dispatch | — |
| Warp, Copilot, Cursor, Windsurf, OpenCode, Factory, Codex, OpenClaw | — | `aiwg mc` orchestration |

### Built-in Teams

| Slug | Agents | Dispatch | Purpose |
|------|--------|----------|---------|
| `api-development` | 4 | sequential | API design and implementation |
| `full-stack` | 4 | sequential | Full-stack feature delivery |
| `greenfield` | 4 | sequential | New project kickoff |
| `maintenance` | 4 | sequential | Code review and bug fixing |
| `migration` | 4 | sequential | Technology migrations |
| `sdlc-review` | 4 | parallel | Phase gate validation |
| `security-review` | 3 | sequential | Security audits |

### Deployment

Teams are deployed as part of `aiwg use <framework>`. Project-local teams can be placed in `.aiwg/teams/<slug>.json` and take precedence over framework teams.

### Example

```json
{
  "name": "API Development Team",
  "slug": "api-development",
  "description": "Design, build, test, and document production-grade APIs",
  "dispatch": "sequential",
  "agents": [
    { "agent": "api-designer", "role": "lead",
      "responsibilities": ["Define API contracts", "Establish versioning"] },
    { "agent": "test-engineer", "role": "contributor",
      "responsibilities": ["Write contract and integration tests"] },
    { "agent": "security-auditor", "role": "reviewer",
      "responsibilities": ["Review auth and rate limiting"] }
  ],
  "handoffs": [
    { "from": "api-designer", "to": "test-engineer",
      "artifact": "OpenAPI spec", "gate": "spec validates against schema" }
  ],
  "sdlc_phases": ["Elaboration", "Construction"],
  "max_context_agents": 3
}
```

### Related References

- `team` skill — `aiwg team run|list|info` orchestration
- `parallel-dispatch` skill — Mission Control fallback for non-Claude providers
- @agentic/code/frameworks/sdlc-complete/teams/schema.json — full JSON Schema
- @agentic/code/frameworks/sdlc-complete/teams/README.md — usage guide

---

## Behavior Extensions (Extended Reference)

Reactive capabilities that combine natural language invocation with event-driven hook subscriptions and shell scripts. Behaviors are what you reach for when a skill is not enough — specifically when the capability needs to react to system events (file writes, build completions, scheduled intervals, session boundaries) rather than waiting for explicit user invocation.

### Behavior vs. Agent vs. Hook vs. Skill

| Dimension | Skill | Hook | Agent | Behavior |
|-----------|-------|------|-------|----------|
| **Invoked by** | User NL request | Lifecycle event (automatic) | User or orchestrator | Both — NL request and/or event |
| **Execution model** | Single request/response | Single event reaction | Autonomous reasoning loop | Persistent reactive capability |
| **Script support** | No | No | No | Yes — ships with shell scripts |
| **Structured inputs** | No | No | No | Yes — typed input schema |
| **Composability** | Implicit | Implicit | Via teams | Explicit `composable_with` manifest |
| **Mode variants** | — | — | AI-only | `agent` (AI-driven) or `script` (shell) |

Use a **skill** when the user asks for something once. Use a **hook** when you need to intercept a single lifecycle event. Use an **agent** when reasoning and tool use are central. Use a **behavior** when a capability needs to be always-on, reactive to events, and potentially driven by shell scripts.

### BehaviorMetadata (Extended)

```typescript
interface BehaviorMetadata {
  type: 'behavior';

  triggerPhrases?: string[];          // NL invocation phrases (same as skills)

  inputs?: BehaviorInput[];           // Structured typed input parameters

  hooks?: Partial<Record<            // Event hook subscriptions
    BehaviorHookEvent,
    BehaviorHookAction[]
  >>;

  scripts?: Record<string, string>;   // Logical name → relative script path

  manifest?: {
    category?: string;                // Discovery category
    requires?: {
      bins?: string[];                // Required system binaries
      env?: string[];                 // Required environment variables
    };
    outputs?: Array<{                 // Declared output paths
      type: string;
      path: string;
    }>;
    composable_with?: string[];       // Behavior IDs this composes with
  };
}

interface BehaviorInput {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'enum' | 'path';
  required?: boolean;
  description?: string;
  default?: string | number | boolean;
  values?: string[];                  // Allowed values for enum type
}

type BehaviorHookEvent =
  | 'on_file_write'
  | 'on_tool_complete'
  | 'on_schedule'
  | 'on_commit'
  | 'on_pr_open'
  | 'on_deploy'
  | 'on_session_start'
  | 'on_session_end';

interface BehaviorHookAction {
  filter?: string;                    // Glob filter for file-based events
  tool?: string;                      // Tool name for on_tool_complete
  cron?: string;                      // Cron expression for on_schedule
  action: 'run_script' | 'notify' | 'log';
  script?: string;                    // Script path (relative to behavior directory)
}
```

### Two Modes

Behaviors come in two modes, declared at the top of the `BEHAVIOR.md` frontmatter.

#### mode: script (default)

Shell-script-driven behaviors. The behavior ships with one or more shell scripts that execute when hooks fire or when the behavior is invoked by name. The AI is not involved in execution — the scripts run directly.

Use this mode for build monitoring, test watching, scheduled audits, and any capability where deterministic script execution is more appropriate than AI reasoning.

**Example — build-monitor (script mode):**

```yaml
---
name: build-monitor
version: 1.0.0
description: Track build health by monitoring build tool completions and running scheduled build checks.
platforms: [openclaw, claude-code]

triggers:
  - "monitor build"
  - "check build health"

inputs:
  - name: command
    type: string
    required: false
    description: Build command to run
    default: "npm run build"

hooks:
  on_tool_complete:
    - tool: build
      action: run_script
      script: scripts/post-build-check.sh
  on_schedule:
    - cron: "0 */4 * * *"
      action: run_script
      script: scripts/scheduled-build.sh

scripts:
  main: scripts/main.sh
  post-build-check: scripts/post-build-check.sh
  scheduled-build: scripts/scheduled-build.sh

manifest:
  category: build
  requires:
    bins: [node]
  outputs:
    - type: report
      path: .aiwg/reports/build/
  composable_with: [test-watcher]
---
```

#### mode: agent

AI-instruction behaviors. Instead of shell scripts, the behavior body is a prompt that instructs the AI directly. The AI reads the BEHAVIOR.md body and acts as specified when triggered. No scripts are required.

Use this mode for interaction-layer behaviors (like the Concierge), routing behaviors, and capabilities where AI judgment and natural language production are central.

**Example — concierge (agent mode, abbreviated):**

```yaml
---
name: concierge
version: 1.0.0
description: >
  Persistent front-facing interface for the AIWG daemon. Routes user requests to the
  correct skill, agent, or flow while maintaining a composed, professional interaction
  register throughout.
platforms: [claude-code, openclaw, cursor, warp]

mode: agent

triggers:
  - session-start

tone:
  register: professional-warm
  verbosity: concise

routing:
  strategy: intent-first
  fallback: surface-with-context
  expose_internals: false

memory:
  session: true
  cross_session: true
  store: .aiwg/daemon/concierge-memory.json

hooks:
  on_session_start:
    action: activate
    description: Concierge greets and reads session context on daemon session open.

manifest:
  category: interaction
  scope: daemon
  composable_with: [build-monitor, security-sentinel, test-watcher]
  outputs:
    - type: memory
      path: .aiwg/daemon/concierge-memory.json
---

# Concierge

You are the AIWG Concierge — the primary front-facing interface for the AIWG persistent daemon.
[... behavior body instructs the AI ...]
```

### Lifecycle Phases

| Phase | Description |
|-------|-------------|
| **deploy** | `aiwg add-behavior <name>` writes the behavior definition to the target provider directory |
| **activate** | Daemon loads the behavior and registers its hook subscriptions; NL triggers become available |
| **execute** | A hook fires (or user invokes by NL), triggering the script or AI instruction body |
| **deactivate** | Behavior is stopped (`aiwg behavior stop <name>`) and hook subscriptions are removed |

### Provider Support

| Provider | Behaviors | Mode | Notes |
|----------|-----------|------|-------|
| **OpenClaw** | Native | script + agent | First provider with native behavior support. Deploys to `~/.openclaw/behaviors/`. Reference implementation. |
| **Claude Code** | Emulated | agent (via hooks) | Hook events map to Claude Code's `pre-session`, `post-write`, `post-bash` lifecycle hooks. Script mode runs hooks as bash calls. |
| **Cursor** | Emulated | agent | Hook subscriptions emulated via AIWG daemon event routing. |
| **Warp** | Emulated | agent | Emulated via daemon. Behaviors appear in `WARP.md` for context loading. |
| **Copilot** | Emulated | agent | Emulated via daemon. No native hook support. |
| **Windsurf** | Emulated | agent | Emulated via daemon. No native hook support. |
| **Factory AI** | Emulated | agent | Emulated via daemon. |
| **Codex** | Emulated | agent | Emulated via daemon. |
| **OpenCode** | Emulated | agent | Emulated via daemon. |

On platforms without native hook support, AIWG emulates behavior execution through the daemon's automation engine. The daemon subscribes to equivalent file-system and schedule events and routes them to the behavior's script or AI body. NL triggers work identically across all platforms. Hook-driven execution is the only path where native vs. emulated behavior differs.

### BEHAVIOR.md File Format

Behaviors are defined as a single BEHAVIOR.md file. The frontmatter is machine-readable; the body (below the closing `---`) is the AI instruction content for `mode: agent` behaviors, or human-readable documentation for `mode: script` behaviors.

```
agentic/code/behaviors/<name>/
├── BEHAVIOR.md          # Behavior definition (frontmatter + body)
└── scripts/             # Shell scripts (mode: script only)
    ├── main.sh
    └── post-build-check.sh
```

**Frontmatter fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Behavior identifier (kebab-case) |
| `version` | Yes | CalVer or semver |
| `description` | Yes | One-line purpose |
| `platforms` | Yes | List of supported providers |
| `mode` | No | `script` (default) or `agent` |
| `triggers` | No | NL phrases or event names |
| `inputs` | No | Typed input parameter definitions |
| `hooks` | No | Event hook subscriptions |
| `scripts` | No | Logical name → script path map |
| `tone` | No | Tone profile (agent mode) |
| `routing` | No | Routing configuration (agent mode) |
| `memory` | No | Memory persistence configuration |
| `manifest` | No | Richer metadata: category, requires, outputs, composable_with |

### CLI

```bash
# Create a new behavior
aiwg add-behavior <name>

# Deploy behavior to a specific provider
aiwg add-behavior <name> --provider openclaw

# List active behaviors
aiwg behavior list

# Run a behavior manually
aiwg behavior run <name>

# Stop an active behavior
aiwg behavior stop <name>
```

---

## See Also

- [Extension System Overview](overview.md)
- [Creating Extensions](creating-extensions.md)
- [Concierge Guide](../concierge-guide.md) — User guide for the agent-mode concierge behavior
- [Daemon Guide](../daemon-guide.md) — Daemon architecture that behaviors integrate with
- @src/extensions/types.ts - Full type definitions
- @.aiwg/architecture/unified-extension-schema.md - Complete schema
- @docs/cli/reference.md - CLI command reference
