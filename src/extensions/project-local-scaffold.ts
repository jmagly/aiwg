/**
 * Project-Local Bundle Scaffolding
 *
 * Creates a complete `.aiwg/<type>/<name>/` bundle with a valid manifest,
 * a starter artifact (skill or rule), and a README that includes the
 * identical-form portability reminder.
 *
 * The output is byte-identical-shaped to upstream addon directories so
 * `aiwg promote` can graduate it without any rewrite.
 *
 * @design @.aiwg/architecture/adr-identical-form-portability.md (#1038)
 * @implements #1050
 */

import { mkdir, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import { projectAiwgPath } from '../config/project-artifacts.js';
import { PROJECT_LOCAL_TYPE_TO_DIR as TYPE_TO_DIR } from './project-local-paths.js';
import type { ProjectLocalType } from './manifest.js';

export type StarterKind = 'skill' | 'rule' | 'agent' | 'minimal';

export interface ScaffoldOptions {
  /** Bundle directory type. */
  type: ProjectLocalType;
  /** Bundle id (kebab-case, no leading/trailing hyphen). */
  name: string;
  /** Free-text human description. */
  description?: string;
  /** What starter artifact to drop in. Defaults to 'skill' for addon/extension; 'minimal' otherwise. */
  starter?: StarterKind;
  /** Project root. Defaults to process.cwd(). */
  projectDir?: string;
  /** Refuse to overwrite an existing bundle. Default true. */
  refuseOnExists?: boolean;
  /** Preview only — compute the file list without writing. Default false. */
  dryRun?: boolean;
}

export interface ScaffoldResult {
  /** Absolute path to the new bundle. */
  bundlePath: string;
  /** Files created (relative to bundle). For dry-run, files that WOULD be created. */
  filesCreated: string[];
  /** True when nothing was written because the bundle already exists. */
  alreadyExists: boolean;
  /** True when no files were written because dryRun was set. */
  dryRun?: boolean;
}

const NAME_REGEX = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function buildManifest(opts: ScaffoldOptions): Record<string, unknown> {
  const { type, name, description = `Project-local ${type} '${name}'` } = opts;
  const now = new Date();
  const base: Record<string, unknown> = {
    id: name,
    type,
    name,
    version: `${now.getUTCFullYear()}.${now.getUTCMonth() + 1}.0`,
    description,
    manifestVersion: '1',
    platforms: { claude: 'full' },
    keywords: [type, 'project-local'],
    deployment: { pathTemplate: '.{platform}/skills/{id}.md' },
  };
  if (type === 'addon') {
    const starter = opts.starter ?? 'skill';
    const kind = starter === 'agent' ? 'agents' : starter === 'rule' ? 'rules' : 'skills';
    base['core'] = false;
    base['autoInstall'] = false;
    base['agents'] = starter === 'agent' ? [name] : [];
    base['skills'] = starter === 'skill' ? [`${name}-skill`] : [];
    base['rules'] = starter === 'rule' ? [name] : [];
    base['addonConfig'] = { entry: starter === 'minimal' ? {} : { [kind]: `${kind}/` } };
  } else if (type === 'framework') {
    base['frameworkConfig'] = { path: 'src/' };
  } else if (type === 'plugin') {
    base['pluginConfig'] = { payloadType: 'addon', payloadPath: 'payload/' };
  } else if (type === 'provider') {
    base['providerConfig'] = { extends: 'claude', displayName: name };
  }
  return base;
}

function readme(opts: ScaffoldOptions): string {
  const { type, name, description = '' } = opts;
  const usage = type === 'provider'
    ? `Select this provider while deploying a framework:
\`\`\`bash
aiwg use sdlc --provider ${name}
\`\`\``
    : `Deploy to your configured providers:
\`\`\`bash
aiwg use ${name}
\`\`\``;
  const upstreamDir = type === 'provider' ? 'providers' : 'addons';
  return `# ${name}

${description || `Project-local ${type} bundle.`}

## What this is

A project-local AIWG ${type} living under \`.aiwg/${TYPE_TO_DIR[type]}/${name}/\`.
Discovered automatically by \`aiwg use\`${type === 'provider' ? ' as a provider alias.' : ' and deployed alongside upstream artifacts.'}

## Layout

\`\`\`
.aiwg/${TYPE_TO_DIR[type]}/${name}/
├── manifest.json          # Bundle metadata (validated by aiwg)
├── README.md              # This file
└── ${type === 'framework' ? 'src/' : type === 'plugin' ? 'payload/' : type === 'provider' ? 'manifest.json only' : 'skills/ or rules/'}
\`\`\`

## Usage

${usage}

Inspect health:
\`\`\`bash
aiwg doctor --project-local
\`\`\`

Remove (preserves source under \`.aiwg/\`):
\`\`\`bash
aiwg remove ${name}
\`\`\`

## Identical-form portability

This directory is shaped **byte-identical** to upstream
\`agentic/code/${upstreamDir}/${name}/\`. To graduate, run:

\`\`\`bash
aiwg promote ${name} --dry-run     # preview
aiwg promote ${name}                # copy to upstream
aiwg promote ${name} --to corpus ~/my-corpus/   # or to a private corpus
\`\`\`

Keep this directory shaped like upstream so \`aiwg promote\` works.

## Customization tips

- Edit \`manifest.json\` to set a real \`description\`, bump \`version\` to
  the next CalVer patch when changed, and add platforms beyond \`claude\` if needed.
- Add new artifacts under \`skills/\`, \`rules/\`, \`agents/\`, or \`commands/\`
  per AIWG conventions.
- Use \`@\`-references for cross-artifact links: \`@$AIWG_ROOT/...\` for
  upstream paths, \`@.aiwg/...\` for project-local references (note: the
  latter will block promotion unless \`--force\` is passed).

## See also

- \`docs/customization/project-local-quickstart.md\` — first bundle in 5 minutes
- \`docs/customization/project-local-lifecycle.md\` — full lifecycle reference
- \`docs/customization/extensions-vs-addons-vs-frameworks-vs-plugins.md\` — pick the right type
`;
}

const STARTER_SKILL = (name: string) => `---
name: ${name}-skill
description: Starter skill for the ${name} project-local bundle. Customize this.
commandHint:
  modelRole: efficiency
  modelTier: economy
---

# ${name}-skill

Replace this body with the workflow your skill performs.

## When to use

Describe the trigger conditions for this skill.

## Process

1. Step one
2. Step two

<!-- TIP: keep front-matter \`name\` matching the file basename for predictable -->
<!-- TIP: deploy paths and traceability with the SKILL.md frontmatter schema. -->
`;

const STARTER_RULE = (name: string) => `---
id: ${name}-rule
---

# ${name}-rule

Describe the rule. Keep it concise — rules are loaded into every relevant
agent context, so terseness pays off.

## Why

Explain the motivation. Future-you will thank you.

## How to apply

State when this rule fires and what action it requires.
`;

const STARTER_AGENT = (name: string) => `---
name: ${name}
description: Starter agent for the ${name} project-local bundle.
model: haiku
tools: [Read, Glob, Grep]
model-role: efficiency
model-tier: economy
---

# ${name}

You are a specialist for [domain]. Customize this body with the agent's
focus, allowed tools, and termination conditions.
`;

export async function scaffoldProjectLocalBundle(
  options: ScaffoldOptions,
): Promise<ScaffoldResult> {
  const projectDir = options.projectDir ?? process.cwd();
  const refuseOnExists = options.refuseOnExists ?? true;
  const dryRun = options.dryRun ?? false;

  if (!NAME_REGEX.test(options.name)) {
    throw new Error(
      `Invalid bundle name '${options.name}': must be kebab-case (a-z, 0-9, '-'), no leading/trailing hyphen.`,
    );
  }

  const dirName = TYPE_TO_DIR[options.type];
  const bundlePath = projectAiwgPath(projectDir, dirName, options.name);

  // Refuse to overwrite
  try {
    await stat(bundlePath);
    if (refuseOnExists) {
      return { bundlePath, filesCreated: [], alreadyExists: true, dryRun };
    }
  } catch {
    // Doesn't exist — good
  }

  if (dryRun) {
    // Compute the file list without writing anything.
    const starter: StarterKind =
      options.starter ?? (options.type === 'framework' || options.type === 'plugin' || options.type === 'provider' ? 'minimal' : 'skill');
    const filesCreated: string[] = ['manifest.json', 'README.md'];
    if (starter === 'skill') filesCreated.push(`skills/${options.name}-skill/SKILL.md`);
    else if (starter === 'rule') filesCreated.push(`rules/${options.name}.md`, 'rules/RULES-INDEX.md');
    else if (starter === 'agent') filesCreated.push(`agents/${options.name}.md`);
    if (options.type === 'framework') filesCreated.push('src/.gitkeep');
    if (options.type === 'plugin') filesCreated.push('payload/.gitkeep');
    return { bundlePath, filesCreated, alreadyExists: false, dryRun: true };
  }

  await mkdir(bundlePath, { recursive: true });
  const filesCreated: string[] = [];

  // Pick starter
  const starter: StarterKind =
    options.starter ?? (options.type === 'framework' || options.type === 'plugin' || options.type === 'provider' ? 'minimal' : 'skill');

  // manifest.json
  const manifest = buildManifest(options);
  await writeFile(
    join(bundlePath, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    'utf-8',
  );
  filesCreated.push('manifest.json');

  // README.md
  await writeFile(join(bundlePath, 'README.md'), readme(options), 'utf-8');
  filesCreated.push('README.md');

  // Starter artifact
  if (starter === 'skill') {
    const skillDir = join(bundlePath, 'skills', `${options.name}-skill`);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), STARTER_SKILL(options.name), 'utf-8');
    filesCreated.push(`skills/${options.name}-skill/SKILL.md`);
  } else if (starter === 'rule') {
    const rulesDir = join(bundlePath, 'rules');
    await mkdir(rulesDir, { recursive: true });
    await writeFile(join(rulesDir, `${options.name}.md`), STARTER_RULE(options.name), 'utf-8');
    filesCreated.push(`rules/${options.name}.md`);
    await writeFile(join(rulesDir, 'RULES-INDEX.md'), `# Rules Index\n\n- [${options.name}](${options.name}.md)\n`, 'utf-8');
    filesCreated.push('rules/RULES-INDEX.md');
  } else if (starter === 'agent') {
    const agentsDir = join(bundlePath, 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(join(agentsDir, `${options.name}.md`), STARTER_AGENT(options.name), 'utf-8');
    filesCreated.push(`agents/${options.name}.md`);
  }
  // 'minimal' = no starter artifact (operator fills it in)

  // Type-specific stub directories
  if (options.type === 'framework') {
    await mkdir(join(bundlePath, 'src'), { recursive: true });
    await writeFile(
      join(bundlePath, 'src', '.gitkeep'),
      '# Framework source files go here\n',
      'utf-8',
    );
    filesCreated.push('src/.gitkeep');
  }
  if (options.type === 'plugin') {
    await mkdir(join(bundlePath, 'payload'), { recursive: true });
    await writeFile(
      join(bundlePath, 'payload', '.gitkeep'),
      '# Plugin payload files go here\n',
      'utf-8',
    );
    filesCreated.push('payload/.gitkeep');
  }
  return { bundlePath, filesCreated, alreadyExists: false };
}
