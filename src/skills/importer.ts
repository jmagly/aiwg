/**
 * Secure Agent Skills import boundary.
 *
 * Sources are materialized as inert bytes, validated in staging, and promoted
 * atomically into the project AIWG artifact root. No source script is loaded or
 * executed by this module.
 *
 * @implements #1877
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { projectAiwgPath } from '../config/project-artifacts.js';
import {
  listProviderDefinitions,
  resolveProviderPathValue,
} from '../providers/provider-definitions.js';
import {
  AGENT_SKILLS_BASELINE,
} from './agent-skills.js';
import { validateAgentSkillContent } from './validator.js';
import type {
  AgentSkillImportDiagnostic,
  AgentSkillImportLimits,
  AgentSkillImportOptions,
  AgentSkillImportResult,
  AgentSkillImportSource,
} from './types.js';

export const DEFAULT_AGENT_SKILL_IMPORT_LIMITS: Readonly<AgentSkillImportLimits> =
  Object.freeze({
    maxFiles: 1_000,
    maxFileBytes: 5 * 1024 * 1024,
    maxTotalBytes: 20 * 1024 * 1024,
    maxDepth: 20,
    maxGitRepositoryBytes: 100 * 1024 * 1024,
  });

interface TreeDirectory {
  kind: 'directory';
  path: string;
}

interface TreeFile {
  kind: 'file';
  path: string;
  bytes: Buffer;
}

type TreeEntry = TreeDirectory | TreeFile;

interface MaterializedSource {
  entries: TreeEntry[];
  source: AgentSkillImportResult['source'];
  directoryName: string;
}

interface StoredAgentSkillRecord {
  schemaVersion: 1;
  name: string;
  description: string;
  digest: string;
  source: AgentSkillImportResult['source'];
  validationProfile: AgentSkillImportResult['validationProfile'];
  diagnostics: AgentSkillImportDiagnostic[];
  trust: AgentSkillImportResult['trust'];
  importedAt: string;
  aiwgVersion: string;
  sourceDirectory: 'source';
  fileCount: number;
  totalBytes: number;
}

interface ParsedImport {
  name: string;
  description: string;
  diagnostics: AgentSkillImportDiagnostic[];
}

export class AgentSkillImportError extends Error {
  readonly code: string;
  readonly diagnostics: AgentSkillImportDiagnostic[];

  constructor(
    code: string,
    message: string,
    diagnostics: AgentSkillImportDiagnostic[] = [],
  ) {
    super(message);
    this.name = 'AgentSkillImportError';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

function diagnostic(
  code: string,
  file: string,
  yamlPath: string,
  message: string,
  remediation: string,
  severity: AgentSkillImportDiagnostic['severity'] = 'error',
): AgentSkillImportDiagnostic {
  return {
    code,
    severity,
    file,
    yamlPath,
    message,
    upstreamBaseline: AGENT_SKILLS_BASELINE.revision,
    remediation,
  };
}

function fail(
  code: string,
  message: string,
  file = '.',
  remediation = 'Correct the source and retry the import.',
): never {
  throw new AgentSkillImportError(code, message, [
    diagnostic(code, file, '$', message, remediation),
  ]);
}

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === ''
    || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizedLimits(
  overrides: Partial<AgentSkillImportLimits> | undefined,
): AgentSkillImportLimits {
  const limits = {
    ...DEFAULT_AGENT_SKILL_IMPORT_LIMITS,
    ...overrides,
  };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AgentSkillImportError(
        'AS_IMPORT_LIMIT_INVALID',
        `${key} must be a positive safe integer`,
      );
    }
  }
  return limits;
}

function validateRelativePath(relativePath: string): string {
  if (
    relativePath.length === 0
    || /[\u0000-\u001f\u007f]/.test(relativePath)
    || relativePath.includes('\\')
    || path.posix.isAbsolute(relativePath)
  ) {
    fail(
      'AS_IMPORT_PATH_INVALID',
      `unsafe source path "${relativePath}"`,
      relativePath || '.',
      'Use non-empty relative POSIX paths without backslashes or control characters.',
    );
  }
  const normalized = path.posix.normalize(relativePath);
  if (
    normalized !== relativePath
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    fail(
      'AS_IMPORT_PATH_TRAVERSAL',
      `source path escapes or changes under normalization: "${relativePath}"`,
      relativePath,
      'Remove traversal and redundant path segments.',
    );
  }
  return normalized;
}

function enforceFileLimits(
  file: TreeFile,
  files: number,
  totalBytes: number,
  limits: AgentSkillImportLimits,
): void {
  if (files > limits.maxFiles) {
    fail(
      'AS_IMPORT_FILE_COUNT',
      `source exceeds the ${limits.maxFiles}-file limit`,
      file.path,
      'Reduce the resource tree or raise the explicit import limit.',
    );
  }
  if (file.bytes.length > limits.maxFileBytes) {
    fail(
      'AS_IMPORT_FILE_SIZE',
      `"${file.path}" exceeds the ${limits.maxFileBytes}-byte file limit`,
      file.path,
      'Reduce the file or raise the explicit import limit.',
    );
  }
  if (totalBytes > limits.maxTotalBytes) {
    fail(
      'AS_IMPORT_TOTAL_SIZE',
      `source exceeds the ${limits.maxTotalBytes}-byte total limit`,
      file.path,
      'Reduce the resource tree or raise the explicit import limit.',
    );
  }
}

function collectLocalTree(
  sourceRoot: string,
  limits: AgentSkillImportLimits,
): TreeEntry[] {
  const rootStat = fs.lstatSync(sourceRoot);
  if (rootStat.isSymbolicLink()) {
    fail(
      'AS_IMPORT_SYMLINK',
      'the import root cannot be a symbolic link',
      sourceRoot,
      'Import from a real directory whose tree contains no symbolic links.',
    );
  }
  if (!rootStat.isDirectory()) {
    fail(
      'AS_IMPORT_SOURCE_TYPE',
      'the local import source must be a directory',
      sourceRoot,
      'Pass a directory containing SKILL.md.',
    );
  }

  const realRoot = fs.realpathSync.native(sourceRoot);
  const entries: TreeEntry[] = [];
  let fileCount = 0;
  let totalBytes = 0;

  const walk = (current: string, relativeDirectory: string): void => {
    const children = fs.readdirSync(current, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relativePath = validateRelativePath(
        relativeDirectory
          ? `${relativeDirectory}/${child.name}`
          : child.name,
      );
      const depth = relativePath.split('/').length;
      if (depth > limits.maxDepth) {
        fail(
          'AS_IMPORT_DEPTH',
          `"${relativePath}" exceeds the ${limits.maxDepth}-level depth limit`,
          relativePath,
          'Flatten the resource tree or raise the explicit import limit.',
        );
      }

      const fullPath = path.join(current, child.name);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) {
        fail(
          'AS_IMPORT_SYMLINK',
          `symbolic links are not permitted: "${relativePath}"`,
          relativePath,
          'Replace the link with an in-tree regular file or directory.',
        );
      }
      if (stat.isDirectory()) {
        const realDirectory = fs.realpathSync.native(fullPath);
        if (!pathContains(realRoot, realDirectory)) {
          fail(
            'AS_IMPORT_PATH_ESCAPE',
            `directory escapes the source root: "${relativePath}"`,
            relativePath,
            'Keep every imported resource inside the source directory.',
          );
        }
        entries.push({ kind: 'directory', path: relativePath });
        walk(fullPath, relativePath);
        continue;
      }
      if (!stat.isFile()) {
        fail(
          'AS_IMPORT_SPECIAL_FILE',
          `special files are not permitted: "${relativePath}"`,
          relativePath,
          'Remove sockets, devices, FIFOs, and other non-regular files.',
        );
      }

      let descriptor: number | undefined;
      try {
        descriptor = fs.openSync(
          fullPath,
          fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0),
        );
        const openedStat = fs.fstatSync(descriptor);
        if (!openedStat.isFile()) {
          fail(
            'AS_IMPORT_SPECIAL_FILE',
            `source changed to a non-regular file: "${relativePath}"`,
            relativePath,
          );
        }
        if (openedStat.size > limits.maxFileBytes) {
          fail(
            'AS_IMPORT_FILE_SIZE',
            `"${relativePath}" exceeds the ${limits.maxFileBytes}-byte file limit`,
            relativePath,
            'Reduce the file or raise the explicit import limit.',
          );
        }
        const bytes = fs.readFileSync(descriptor);
        const file: TreeFile = { kind: 'file', path: relativePath, bytes };
        fileCount += 1;
        totalBytes += bytes.length;
        enforceFileLimits(file, fileCount, totalBytes, limits);
        entries.push(file);
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
      }
    }
  };

  walk(realRoot, '');
  return entries;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  return {
    ...environment,
    GIT_ALLOW_PROTOCOL: 'file:git:http:https:ssh',
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
  };
}

function runGit(
  args: string[],
  options: {
    encoding?: BufferEncoding | null;
    maxBuffer?: number;
  } = {},
): string | Buffer {
  const result = spawnSync('git', args, {
    encoding: options.encoding === null ? null : (options.encoding ?? 'utf8'),
    env: gitEnvironment(),
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    killSignal: 'SIGKILL',
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new AgentSkillImportError(
        'AS_IMPORT_GIT_TIMEOUT',
        'git invocation exceeded the 120-second import timeout',
      );
    }
    throw new AgentSkillImportError(
      'AS_IMPORT_GIT_UNAVAILABLE',
      `git invocation failed: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8')
      : String(result.stderr ?? '');
    throw new AgentSkillImportError(
      'AS_IMPORT_GIT_FAILED',
      stderr.trim() || `git exited with status ${result.status}`,
    );
  }
  return result.stdout ?? (options.encoding === null ? Buffer.alloc(0) : '');
}

function directorySize(root: string): number {
  let total = 0;
  const walk = (current: string): void => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        total += fs.statSync(fullPath).size;
      }
    }
  };
  walk(root);
  return total;
}

function normalizeGitSubpath(subpath: string): string {
  if (
    subpath.length === 0
    || /[\u0000-\u001f\u007f]/.test(subpath)
    || subpath.includes('\\')
    || path.posix.isAbsolute(subpath)
  ) {
    fail(
      'AS_IMPORT_GIT_SUBPATH',
      'Git skill subpath must be a non-empty relative POSIX directory',
      subpath || '.',
      'Pass an explicit repository-relative skill directory.',
    );
  }
  const normalized = path.posix.normalize(subpath.replace(/\/+$/, ''));
  if (
    normalized === '.'
    || normalized === '..'
    || normalized.startsWith('../')
    || normalized !== subpath.replace(/\/+$/, '')
  ) {
    fail(
      'AS_IMPORT_GIT_SUBPATH',
      `unsafe Git skill subpath "${subpath}"`,
      subpath,
      'Pass a normalized repository-relative skill directory, not the repository root.',
    );
  }
  return normalized;
}

function validateGitLocator(url: string, revision: string): void {
  if (
    url.length === 0
    || revision.length === 0
    || /[\u0000-\u001f\u007f]/.test(url)
    || /[\u0000-\u001f\u007f]/.test(revision)
    || url.startsWith('-')
    || revision.startsWith('-')
  ) {
    fail(
      'AS_IMPORT_GIT_ARGUMENT',
      'Git URL and revision must be explicit non-option arguments',
      '.',
      'Pass a URL and pinned revision that do not begin with "-".',
    );
  }
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(revision)
    || revision.includes('..')
    || revision.includes('//')
    || revision.endsWith('/')
    || revision.endsWith('.lock')
  ) {
    fail(
      'AS_IMPORT_GIT_REVISION',
      `unsafe Git revision "${revision}"`,
      '.',
      'Use a commit ID, tag, or refs/... name without refspec or revision operators.',
    );
  }
  let parsed: URL | undefined;
  try {
    parsed = new URL(url);
  } catch {
    // SCP-style URLs and local repository paths are valid Git locators.
  }
  if (parsed?.username || parsed?.password) {
    fail(
      'AS_IMPORT_GIT_CREDENTIALS',
      'credential-bearing Git URLs are not stored as provenance',
      '.',
      'Use an SSH agent, credential helper, or credential-free URL.',
    );
  }
  if (parsed && !['file:', 'git:', 'http:', 'https:', 'ssh:'].includes(parsed.protocol)) {
    fail(
      'AS_IMPORT_GIT_PROTOCOL',
      `unsupported Git URL protocol "${parsed.protocol}"`,
      '.',
      'Use file, git, HTTP(S), SSH, SCP-style SSH, or a local repository path.',
    );
  }
  if (!parsed && url.includes('::')) {
    fail(
      'AS_IMPORT_GIT_PROTOCOL',
      'Git remote-helper command syntax is not permitted',
      '.',
      'Use a direct repository URL or local path.',
    );
  }
}

function decodeGitOutput(bytes: Buffer, context: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(
      'AS_IMPORT_PATH_ENCODING',
      `${context} contains a non-UTF-8 path`,
      '.',
      'Use UTF-8 resource paths.',
    );
  }
}

function collectGitTree(
  source: Extract<AgentSkillImportSource, { kind: 'git' }>,
  limits: AgentSkillImportLimits,
): MaterializedSource {
  validateGitLocator(source.url, source.revision);
  const subpath = normalizeGitSubpath(source.subpath);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-skill-git-'));
  const gitDir = path.join(tempRoot, 'repo.git');

  try {
    runGit(['init', '--bare', '--quiet', gitDir]);
    const common = [
      '-c', 'core.hooksPath=/dev/null',
      '-c', 'protocol.file.allow=always',
      '-c', 'submodule.recurse=false',
      '-c', 'fetch.fsckObjects=true',
      `--git-dir=${gitDir}`,
    ];
    runGit([
      ...common,
      'fetch',
      '--quiet',
      '--no-tags',
      '--depth=1',
      '--',
      source.url,
      source.revision,
    ]);
    if (directorySize(gitDir) > limits.maxGitRepositoryBytes) {
      fail(
        'AS_IMPORT_GIT_SIZE',
        `Git staging data exceeds ${limits.maxGitRepositoryBytes} bytes`,
        '.',
        'Use a smaller pinned source or raise the explicit Git staging limit.',
      );
    }

    const resolvedRevision = String(runGit([
      ...common,
      'rev-parse',
      '--verify',
      'FETCH_HEAD^{commit}',
    ])).trim();
    const treeBytes = runGit([
      ...common,
      'ls-tree',
      '--full-tree',
      '-r',
      '-z',
      resolvedRevision,
      '--',
      subpath,
    ], {
      encoding: null,
      maxBuffer: Math.max(16 * 1024 * 1024, limits.maxFiles * 512),
    }) as Buffer;

    const records = decodeGitOutput(treeBytes, 'Git tree')
      .split('\0')
      .filter(Boolean);
    const files: TreeFile[] = [];
    const directories = new Set<string>();
    let totalBytes = 0;

    for (const record of records) {
      const match = /^([0-9]{6}) ([a-z]+) ([0-9a-f]+)\t([\s\S]+)$/.exec(record);
      if (!match) {
        fail(
          'AS_IMPORT_GIT_TREE',
          'Git returned an unrecognized tree entry',
          '.',
          'Verify the pinned revision and repository integrity.',
        );
      }
      const [, mode, objectType, objectId, repositoryPath] = match;
      if (
        repositoryPath !== subpath
        && !repositoryPath.startsWith(`${subpath}/`)
      ) {
        fail(
          'AS_IMPORT_PATH_ESCAPE',
          `Git path escapes the requested subpath: "${repositoryPath}"`,
          repositoryPath,
        );
      }
      const relativePath = validateRelativePath(
        repositoryPath.slice(subpath.length + 1),
      );
      const depth = relativePath.split('/').length;
      if (depth > limits.maxDepth) {
        fail(
          'AS_IMPORT_DEPTH',
          `"${relativePath}" exceeds the ${limits.maxDepth}-level depth limit`,
          relativePath,
        );
      }
      if (mode === '120000') {
        fail(
          'AS_IMPORT_SYMLINK',
          `Git symbolic links are not permitted: "${relativePath}"`,
          relativePath,
          'Replace the link with an in-tree regular file.',
        );
      }
      if (
        objectType !== 'blob'
        || (mode !== '100644' && mode !== '100755')
      ) {
        fail(
          'AS_IMPORT_SPECIAL_FILE',
          `unsupported Git tree entry ${mode} ${objectType}: "${relativePath}"`,
          relativePath,
          'Use only regular files and directories; remove submodules and special entries.',
        );
      }

      const size = Number(String(runGit([
        ...common,
        'cat-file',
        '-s',
        objectId,
      ])).trim());
      if (!Number.isSafeInteger(size) || size < 0) {
        fail(
          'AS_IMPORT_GIT_BLOB',
          `invalid Git blob size for "${relativePath}"`,
          relativePath,
        );
      }
      if (size > limits.maxFileBytes) {
        fail(
          'AS_IMPORT_FILE_SIZE',
          `"${relativePath}" exceeds the ${limits.maxFileBytes}-byte file limit`,
          relativePath,
        );
      }
      const bytes = runGit([
        ...common,
        'cat-file',
        'blob',
        objectId,
      ], {
        encoding: null,
        maxBuffer: limits.maxFileBytes + 64 * 1024,
      }) as Buffer;
      if (bytes.length !== size) {
        fail(
          'AS_IMPORT_GIT_BLOB',
          `Git blob size changed while reading "${relativePath}"`,
          relativePath,
        );
      }

      const file: TreeFile = { kind: 'file', path: relativePath, bytes };
      totalBytes += bytes.length;
      enforceFileLimits(file, files.length + 1, totalBytes, limits);
      files.push(file);

      let parent = path.posix.dirname(relativePath);
      while (parent !== '.') {
        directories.add(parent);
        parent = path.posix.dirname(parent);
      }
    }

    if (files.length === 0) {
      fail(
        'AS_IMPORT_GIT_SUBPATH_MISSING',
        `Git subpath "${subpath}" contains no files at the resolved revision`,
        subpath,
        'Pass a subpath that contains SKILL.md.',
      );
    }

    const entries: TreeEntry[] = [
      ...[...directories]
        .sort((left, right) => (
          left.split('/').length - right.split('/').length
          || left.localeCompare(right)
        ))
        .map<TreeDirectory>((directoryPath) => ({
          kind: 'directory',
          path: directoryPath,
        })),
      ...files.sort((left, right) => left.path.localeCompare(right.path)),
    ];
    return {
      entries,
      source: {
        kind: 'git',
        locator: source.url,
        subpath,
        requestedRevision: source.revision,
        resolvedRevision,
      },
      directoryName: path.posix.basename(subpath),
    };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function materializeSource(
  source: AgentSkillImportSource,
  projectDir: string,
  limits: AgentSkillImportLimits,
): MaterializedSource {
  if (source.kind === 'git') return collectGitTree(source, limits);

  const sourceRoot = path.resolve(projectDir, source.path);
  const managedStore = projectAiwgPath(projectDir, 'skills', 'imported');
  if (
    pathContains(sourceRoot, managedStore)
    || pathContains(managedStore, sourceRoot)
  ) {
    fail(
      'AS_IMPORT_RECURSIVE_SOURCE',
      'the local source and managed import store cannot contain one another',
      sourceRoot,
      'Import from a source directory outside the managed store.',
    );
  }
  if (!fs.existsSync(sourceRoot)) {
    fail(
      'AS_IMPORT_SOURCE_MISSING',
      `local import source does not exist: "${sourceRoot}"`,
      sourceRoot,
      'Pass an existing directory containing SKILL.md.',
    );
  }
  return {
    entries: collectLocalTree(sourceRoot, limits),
    source: {
      kind: 'directory',
      locator: fs.realpathSync.native(sourceRoot),
    },
    directoryName: path.basename(sourceRoot),
  };
}

function parseImportedSkill(
  entries: TreeEntry[],
  directoryName: string,
  profile: AgentSkillImportResult['validationProfile'],
): ParsedImport {
  const skillFile = entries.find(
    (entry): entry is TreeFile => (
      entry.kind === 'file' && entry.path === 'SKILL.md'
    ),
  );
  if (!skillFile) {
    fail(
      'AS_IMPORT_SKILL_MISSING',
      'the source root must contain SKILL.md',
      'SKILL.md',
      'Select the skill directory itself, not its parent or a nested resource.',
    );
  }

  let content: string;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(skillFile.bytes);
  } catch {
    fail(
      'AS_IMPORT_ENCODING',
      'SKILL.md must be valid UTF-8',
      'SKILL.md',
      'Encode SKILL.md as UTF-8 without invalid byte sequences.',
    );
  }
  const validation = validateAgentSkillContent(content, {
    profile,
    file: 'SKILL.md',
    directoryName,
  });
  const diagnostics = validation.diagnostics;
  const errors = diagnostics.filter((item) => item.severity === 'error');
  if (errors.length > 0) {
    throw new AgentSkillImportError(
      'AS_IMPORT_VALIDATION',
      `Agent Skill validation failed with ${errors.length} error(s)`,
      diagnostics,
    );
  }

  return {
    name: validation.frontmatter?.['name'] as string,
    description: validation.frontmatter?.['description'] as string,
    diagnostics,
  };
}

function computeTreeDigest(entries: TreeEntry[]): string {
  const hash = createHash('sha256');
  hash.update('aiwg-agent-skill-tree-v1\0');
  for (const entry of [...entries].sort((left, right) => (
    left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind)
  ))) {
    hash.update(entry.kind);
    hash.update('\0');
    hash.update(entry.path);
    hash.update('\0');
    if (entry.kind === 'file') {
      hash.update(String(entry.bytes.length));
      hash.update('\0');
      hash.update(entry.bytes);
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

function detectAiwgVersion(): string {
  let current = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const packagePath = path.join(current, 'package.json');
    if (fs.existsSync(packagePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(packagePath, 'utf8')) as {
          name?: string;
          version?: string;
        };
        if (
          parsed.name === 'aiwg'
          && typeof parsed.version === 'string'
          && parsed.version.length > 0
        ) {
          return parsed.version;
        }
      } catch {
        // Continue toward the package root.
      }
    }
    current = path.dirname(current);
  }
  return 'unknown';
}

function resolveImportedAt(value: string | undefined): string {
  if (value === undefined) return new Date().toISOString();
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new AgentSkillImportError(
      'AS_IMPORT_TIME_INVALID',
      'importedAt must be an exact ISO-8601 timestamp',
    );
  }
  return value;
}

function readStoredRecord(skillRoot: string): StoredAgentSkillRecord | undefined {
  const manifestPath = path.join(skillRoot, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return undefined;
  try {
    const rootStat = fs.lstatSync(skillRoot);
    const manifestStat = fs.lstatSync(manifestPath);
    if (
      rootStat.isSymbolicLink()
      || !rootStat.isDirectory()
      || manifestStat.isSymbolicLink()
      || !manifestStat.isFile()
      || !pathContains(
        fs.realpathSync.native(skillRoot),
        fs.realpathSync.native(manifestPath),
      )
    ) {
      throw new Error('manifest must be a regular file inside the managed skill');
    }
    const record = JSON.parse(
      fs.readFileSync(manifestPath, 'utf8'),
    ) as StoredAgentSkillRecord;
    if (
      record.schemaVersion !== 1
      || typeof record.name !== 'string'
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.name)
      || typeof record.description !== 'string'
      || typeof record.digest !== 'string'
      || !/^[0-9a-f]{64}$/.test(record.digest)
      || (
        record.source?.kind !== 'directory'
        && record.source?.kind !== 'git'
      )
      || typeof record.source.locator !== 'string'
      || (
        record.source.kind === 'git'
        && (
          typeof record.source.subpath !== 'string'
          || typeof record.source.requestedRevision !== 'string'
          || typeof record.source.resolvedRevision !== 'string'
        )
      )
      || (
        record.validationProfile !== 'strict'
        && record.validationProfile !== 'compatible'
      )
      || !Array.isArray(record.diagnostics)
      || (
        record.trust?.state !== 'trusted'
        && record.trust?.state !== 'untrusted'
      )
      || (
        record.trust?.activation !== 'active'
        && record.trust?.activation !== 'inactive'
      )
      || typeof record.importedAt !== 'string'
      || typeof record.aiwgVersion !== 'string'
      || record.sourceDirectory !== 'source'
      || !Number.isSafeInteger(record.fileCount)
      || record.fileCount < 1
      || !Number.isSafeInteger(record.totalBytes)
      || record.totalBytes < 0
    ) {
      throw new Error('unsupported manifest shape');
    }
    return record;
  } catch (error) {
    throw new AgentSkillImportError(
      'AS_IMPORT_MANIFEST_INVALID',
      `managed import manifest is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function managedTreeMatches(
  skillRoot: string,
  record: StoredAgentSkillRecord,
): boolean {
  const sourceRoot = path.join(skillRoot, record.sourceDirectory);
  if (!fs.existsSync(sourceRoot)) return false;
  try {
    return computeTreeDigest(
      collectLocalTree(sourceRoot, { ...DEFAULT_AGENT_SKILL_IMPORT_LIMITS }),
    ) === record.digest;
  } catch {
    return false;
  }
}

function resultFromRecord(
  record: StoredAgentSkillRecord,
  skillRoot: string,
  status: AgentSkillImportResult['status'],
  dryRun: boolean,
): AgentSkillImportResult {
  const integrityMatches = (
    dryRun
    || !fs.existsSync(skillRoot)
    || managedTreeMatches(skillRoot, record)
  );
  const diagnostics = integrityMatches
    ? record.diagnostics
    : [
        ...record.diagnostics,
        diagnostic(
          'AS_IMPORT_MANAGED_DRIFT',
          path.join(skillRoot, record.sourceDirectory),
          '$.digest',
          'managed source bytes no longer match the imported digest',
          'Review the managed tree, then restore it with an explicit forced import.',
        ),
      ];
  return {
    schemaVersion: 1,
    status,
    dryRun,
    name: record.name,
    description: record.description,
    digest: record.digest,
    source: record.source,
    validationProfile: record.validationProfile,
    diagnostics,
    trust: integrityMatches
      ? record.trust
      : { state: 'untrusted', activation: 'inactive' },
    importedAt: record.importedAt,
    aiwgVersion: record.aiwgVersion,
    managedLocation: path.join(skillRoot, record.sourceDirectory),
    fileCount: record.fileCount,
    totalBytes: record.totalBytes,
  };
}

function higherPrecedenceCollision(
  name: string,
  projectDir: string,
  managedStore: string,
): { origin: 'project' | 'user'; path: string } | undefined {
  const candidates = new Map<string, 'project' | 'user'>();
  for (const definition of listProviderDefinitions()) {
    const namespace = definition.skillNamespace;
    const basePath = namespace.pathType === 'home-dir'
      ? `~/${namespace.skillsBaseDir}`
      : namespace.skillsBaseDir;
    const resolved = resolveProviderPathValue(basePath, projectDir);
    candidates.set(
      path.join(resolved, name),
      namespace.pathType === 'home-dir' ? 'user' : 'project',
    );
  }
  candidates.set(path.join(projectDir, '.agents', 'skills', name), 'project');
  candidates.set(
    path.join(projectDir, '.claude', '.aiwg', 'skills', name),
    'project',
  );

  const match = [...candidates.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .find(([candidate]) => {
      if (pathContains(managedStore, candidate)) return false;
      return (
        fs.existsSync(path.join(candidate, 'SKILL.md'))
        && !fs.existsSync(path.join(candidate, '.aiwg-managed'))
      );
    });
  return match ? { path: match[0], origin: match[1] } : undefined;
}

function writeTree(root: string, entries: TreeEntry[]): void {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const directories = entries
    .filter((entry): entry is TreeDirectory => entry.kind === 'directory')
    .sort((left, right) => (
      left.path.split('/').length - right.path.split('/').length
      || left.path.localeCompare(right.path)
    ));
  for (const entry of directories) {
    fs.mkdirSync(path.join(root, ...entry.path.split('/')), {
      recursive: false,
      mode: 0o700,
    });
  }
  for (const entry of entries
    .filter((item): item is TreeFile => item.kind === 'file')
    .sort((left, right) => left.path.localeCompare(right.path))) {
    const target = path.join(root, ...entry.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, entry.bytes, { flag: 'wx', mode: 0o600 });
  }
}

function lockOwnerIsActive(lockPath: string): boolean {
  try {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
      pid?: number;
      createdAt?: string;
    };
    if (Number.isSafeInteger(lock.pid) && (lock.pid ?? 0) > 0) {
      try {
        process.kill(lock.pid!, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
      }
    }
    const age = Date.now() - fs.statSync(lockPath).mtimeMs;
    return age < 10 * 60 * 1_000;
  } catch {
    return false;
  }
}

function recoverInterruptedPromotion(
  importedStore: string,
  name: string,
): void {
  if (!fs.existsSync(importedStore)) return;
  const entries = fs.readdirSync(importedStore)
    .filter((entry) => (
      entry.startsWith(`.${name}.staging-`)
      || entry.startsWith(`.${name}.backup-`)
    ))
    .sort();
  const staging = entries.filter((entry) => entry.includes('.staging-'));
  const backups = entries.filter((entry) => entry.includes('.backup-'));
  const finalRoot = path.join(importedStore, name);

  for (const entry of staging) {
    fs.rmSync(path.join(importedStore, entry), {
      recursive: true,
      force: true,
    });
  }
  if (fs.existsSync(finalRoot)) {
    for (const entry of backups) {
      fs.rmSync(path.join(importedStore, entry), {
        recursive: true,
        force: true,
      });
    }
    return;
  }
  if (backups.length > 1) {
    throw new AgentSkillImportError(
      'AS_IMPORT_RECOVERY_AMBIGUOUS',
      `multiple interrupted backups exist for "${name}"`,
    );
  }
  if (backups.length === 1) {
    fs.renameSync(path.join(importedStore, backups[0]), finalRoot);
  }
}

function acquireImportLock(
  importedStore: string,
  name: string,
): () => void {
  fs.mkdirSync(importedStore, { recursive: true, mode: 0o700 });
  const lockPath = path.join(importedStore, `.${name}.lock`);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
        })}\n`);
      } finally {
        fs.closeSync(descriptor);
      }
      return () => fs.rmSync(lockPath, { force: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      if (lockOwnerIsActive(lockPath)) {
        throw new AgentSkillImportError(
          'AS_IMPORT_BUSY',
          `another import is active for "${name}"`,
        );
      }
      fs.rmSync(lockPath, { force: true });
    }
  }
  throw new AgentSkillImportError(
    'AS_IMPORT_BUSY',
    `could not acquire the import lock for "${name}"`,
  );
}

function recoverInterruptedImportForRead(
  importedStore: string,
  name: string,
): void {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return;
  const lockPath = path.join(importedStore, `.${name}.lock`);
  if (fs.existsSync(lockPath) && lockOwnerIsActive(lockPath)) return;
  const hasRecoveryState = fs.existsSync(lockPath)
    || fs.readdirSync(importedStore).some((entry) => (
      entry.startsWith(`.${name}.staging-`)
      || entry.startsWith(`.${name}.backup-`)
    ));
  if (!hasRecoveryState) return;

  if (fs.existsSync(lockPath)) fs.rmSync(lockPath, { force: true });
  const release = acquireImportLock(importedStore, name);
  try {
    recoverInterruptedPromotion(importedStore, name);
  } finally {
    release();
  }
}

function promoteAtomically(
  entries: TreeEntry[],
  record: StoredAgentSkillRecord,
  importedStore: string,
  finalRoot: string,
): void {
  fs.mkdirSync(importedStore, { recursive: true, mode: 0o700 });
  const stagingRoot = fs.mkdtempSync(
    path.join(importedStore, `.${record.name}.staging-`),
  );
  let backupRoot: string | undefined;
  try {
    writeTree(path.join(stagingRoot, record.sourceDirectory), entries);
    fs.writeFileSync(
      path.join(stagingRoot, 'manifest.json'),
      `${JSON.stringify(record, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );

    if (fs.existsSync(finalRoot)) {
      backupRoot = path.join(
        importedStore,
        `.${record.name}.backup-${randomUUID()}`,
      );
      fs.renameSync(finalRoot, backupRoot);
    }
    try {
      fs.renameSync(stagingRoot, finalRoot);
    } catch (error) {
      if (backupRoot && fs.existsSync(backupRoot)) {
        fs.renameSync(backupRoot, finalRoot);
        backupRoot = undefined;
      }
      throw error;
    }
    if (backupRoot) {
      fs.rmSync(backupRoot, { recursive: true, force: true });
      backupRoot = undefined;
    }
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    if (backupRoot && fs.existsSync(backupRoot) && !fs.existsSync(finalRoot)) {
      fs.renameSync(backupRoot, finalRoot);
    }
  }
}

function sameSource(
  left: StoredAgentSkillRecord['source'],
  right: AgentSkillImportResult['source'],
): boolean {
  return (
    left.kind === right.kind
    && left.locator === right.locator
    && (
      left.kind !== 'git'
      || right.kind !== 'git'
      || left.subpath === right.subpath
    )
  );
}

export async function importAgentSkill(
  source: AgentSkillImportSource,
  options: AgentSkillImportOptions,
): Promise<AgentSkillImportResult> {
  const projectDir = path.resolve(options.projectDir);
  const profile = options.profile ?? 'strict';
  if (profile !== 'strict' && profile !== 'compatible') {
    throw new AgentSkillImportError(
      'AS_IMPORT_PROFILE',
      `unsupported import validation profile "${String(profile)}"`,
    );
  }
  if (options.activate && !options.trust) {
    throw new AgentSkillImportError(
      'AS_IMPORT_TRUST_REQUIRED',
      'activation requires explicit trust for this source and digest',
      [
        diagnostic(
          'AS_IMPORT_TRUST_REQUIRED',
          '.',
          '$.trust',
          'activation requires explicit trust for this source and digest',
          'Repeat the operation with both trust and activation explicitly enabled.',
        ),
      ],
    );
  }

  const limits = normalizedLimits(options.limits);
  const materialized = materializeSource(source, projectDir, limits);
  const parsed = parseImportedSkill(
    materialized.entries,
    materialized.directoryName,
    profile,
  );
  const digest = computeTreeDigest(materialized.entries);
  const importedStore = projectAiwgPath(projectDir, 'skills', 'imported');
  const finalRoot = path.join(importedStore, parsed.name);
  const collision = higherPrecedenceCollision(
    parsed.name,
    projectDir,
    importedStore,
  );
  if (collision) {
    throw new AgentSkillImportError(
      'AS_IMPORT_COLLISION',
      `${collision.origin}-owned skill "${parsed.name}" already exists at ${collision.path}`,
      [
        diagnostic(
          'AS_IMPORT_COLLISION',
          collision.path,
          '$.name',
          `${collision.origin}-owned skill "${parsed.name}" has higher precedence`,
          'Rename the imported skill or remove the higher-precedence collision explicitly.',
        ),
      ],
    );
  }

  const releaseLock = options.dryRun
    ? undefined
    : acquireImportLock(importedStore, parsed.name);
  try {
    if (releaseLock) recoverInterruptedPromotion(importedStore, parsed.name);

    let existing: StoredAgentSkillRecord | undefined;
    if (fs.existsSync(finalRoot)) {
      existing = readStoredRecord(finalRoot);
      if (!existing) {
        throw new AgentSkillImportError(
          'AS_IMPORT_MANIFEST_MISSING',
          `managed skill "${parsed.name}" exists without manifest.json`,
        );
      }
    }
    const existingTreeMatches = existing
      ? managedTreeMatches(finalRoot, existing)
      : true;
    if (existing && !existingTreeMatches && !options.force) {
      throw new AgentSkillImportError(
        'AS_IMPORT_MANAGED_DRIFT',
        `managed source bytes for "${parsed.name}" do not match its recorded digest`,
        [
          diagnostic(
            'AS_IMPORT_MANAGED_DRIFT',
            path.join(finalRoot, existing.sourceDirectory),
            '$.digest',
            `managed source bytes no longer match ${existing.digest}`,
            'Review the managed tree, then restore it with an explicit forced import.',
          ),
        ],
      );
    }
    const requestedTrust = options.trust === true || options.activate === true;
    const trust: AgentSkillImportResult['trust'] = requestedTrust
      ? {
          state: options.trust ? 'trusted' : 'untrusted',
          activation: options.activate ? 'active' : 'inactive',
        }
      : existing?.digest === digest
        ? existing.trust
        : {
            state: 'untrusted',
            activation: 'inactive',
          };

    if (
      existing
      && existingTreeMatches
      && existing.digest === digest
      && existing.validationProfile === profile
      && existing.trust.state === trust.state
      && existing.trust.activation === trust.activation
    ) {
      return resultFromRecord(existing, finalRoot, 'unchanged', Boolean(options.dryRun));
    }

    let status: AgentSkillImportResult['status'] = 'imported';
    if (existing) {
      const trustOnlyChange = (
        existing.digest === digest
        && existing.validationProfile === profile
        && requestedTrust
      );
      if (!trustOnlyChange) {
        if (!options.force && !(options.update && sameSource(existing.source, materialized.source))) {
          throw new AgentSkillImportError(
            'AS_IMPORT_COLLISION',
            options.update
              ? `source drift for "${parsed.name}" requires --force`
              : `imported skill "${parsed.name}" already exists with different content`,
            [
              diagnostic(
                'AS_IMPORT_COLLISION',
                path.join(finalRoot, 'manifest.json'),
                '$.digest',
                `managed digest ${existing.digest} differs from ${digest}`,
                options.update
                  ? 'Use force only after reviewing the changed source locator.'
                  : 'Use update for the same source or force for an intentional source replacement.',
              ),
            ],
          );
        }
      }
      status = 'updated';
    }

    const files = materialized.entries.filter(
      (entry): entry is TreeFile => entry.kind === 'file',
    );
    const importedAt = resolveImportedAt(options.importedAt);
    const record: StoredAgentSkillRecord = {
      schemaVersion: 1,
      name: parsed.name,
      description: parsed.description,
      digest,
      source: materialized.source,
      validationProfile: profile,
      diagnostics: parsed.diagnostics,
      trust,
      importedAt,
      aiwgVersion: options.aiwgVersion ?? detectAiwgVersion(),
      sourceDirectory: 'source',
      fileCount: files.length,
      totalBytes: files.reduce((total, file) => total + file.bytes.length, 0),
    };
    if (options.dryRun) {
      return resultFromRecord(record, finalRoot, 'planned', true);
    }

    promoteAtomically(materialized.entries, record, importedStore, finalRoot);
    return resultFromRecord(record, finalRoot, status, false);
  } finally {
    releaseLock?.();
  }
}

export function listImportedAgentSkills(
  projectDir: string,
): AgentSkillImportResult[] {
  const importedStore = projectAiwgPath(path.resolve(projectDir), 'skills', 'imported');
  if (!fs.existsSync(importedStore)) return [];
  const recoverableNames = new Set(
    fs.readdirSync(importedStore)
      .map((entry) => /^\.(.+)\.(?:lock|staging-|backup-)/.exec(entry)?.[1])
      .filter((name): name is string => Boolean(name)),
  );
  for (const name of [...recoverableNames].sort()) {
    recoverInterruptedImportForRead(importedStore, name);
  }
  return fs.readdirSync(importedStore, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const skillRoot = path.join(importedStore, entry.name);
      const record = readStoredRecord(skillRoot);
      return record
        ? [resultFromRecord(record, skillRoot, 'imported', false)]
        : [];
    });
}

export function getImportedAgentSkill(
  projectDir: string,
  name: string,
): AgentSkillImportResult | undefined {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) return undefined;
  const importedStore = projectAiwgPath(
    path.resolve(projectDir),
    'skills',
    'imported',
  );
  if (fs.existsSync(importedStore)) {
    recoverInterruptedImportForRead(importedStore, name);
  }
  const skillRoot = projectAiwgPath(
    path.resolve(projectDir),
    'skills',
    'imported',
    name,
  );
  if (!fs.existsSync(skillRoot)) return undefined;
  const record = readStoredRecord(skillRoot);
  return record
    ? resultFromRecord(record, skillRoot, 'imported', false)
    : undefined;
}
