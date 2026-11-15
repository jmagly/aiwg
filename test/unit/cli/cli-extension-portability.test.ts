// Portable registries retain project confinement when copied between checkouts.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cp, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerCliCommands, tryExecuteCliExtension, writeRegistry } from '../../../src/cli/cli-extension-loader.js';
import { cliExtensionSourceWarnings } from '../../../src/cli/cli-extension-paths.js';
import { buildProjectLocalDoctorSection } from '../../../src/extensions/project-local-doctor.js';

let root: string;
let project: string;
const subcommands = { ping: { file: 'ping.mjs', description: 'Ping' } };
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'aiwg-portable-cli-'));
  project = path.join(root, 'project');
  await mkdir(path.join(project, 'commands'), { recursive: true });
  await writeFile(path.join(project, 'commands/ping.mjs'), 'export default (args, ctx) => ({ exitCode: 0, message: ctx.cwd });');
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe('CLI source portability (#4185)', () => {
  it('writes relative in-project sources through the registration used by use, and survives relocation', async () => {
    await registerCliCommands(project, 'demo', 'Demo', path.join(project, 'commands'), subcommands);
    const registry = JSON.parse(await readFile(path.join(project, '.aiwg/cli-extensions.json'), 'utf8'));
    expect(registry.demo.source).toBe('commands');
    const clone = path.join(root, 'clone');
    await cp(project, clone, { recursive: true });
    expect(await tryExecuteCliExtension('demo', ['ping'], clone, root)).toEqual({ exitCode: 0, message: clone });
    expect(await cliExtensionSourceWarnings(clone)).toEqual([]);
  });

  it('keeps relative sources project-root-based when the registry uses an external artifact root', async () => {
    const artifacts = path.join(root, 'artifacts');
    await mkdir(artifacts);
    await writeFile(path.join(project, '.aiwg-location'), artifacts + '\n');
    await registerCliCommands(project, 'demo', 'Demo', path.join(project, 'commands'), subcommands);
    const registry = JSON.parse(await readFile(path.join(artifacts, 'cli-extensions.json'), 'utf8'));
    expect(registry.demo.source).toBe('commands');
    expect(await tryExecuteCliExtension('demo', ['ping'], project, root)).toEqual({ exitCode: 0, message: project });
    expect(await cliExtensionSourceWarnings(project)).toEqual([]);
  });

  it('retains and loads external absolute sources', async () => {
    const external = path.join(root, 'external');
    await cp(path.join(project, 'commands'), external, { recursive: true });
    await registerCliCommands(project, 'demo', 'Demo', external, subcommands);
    const registry = JSON.parse(await readFile(path.join(project, '.aiwg/cli-extensions.json'), 'utf8'));
    expect(registry.demo.source).toBe(external);
    expect(await tryExecuteCliExtension('demo', ['ping'], project, root)).toEqual({ exitCode: 0, message: project });
  });

  it.each(['../outside', 'commands/../../outside', 'commands/../commands', '..\\outside', ''])('rejects unsafe relative source %s', async source => {
    await expect(registerCliCommands(project, 'demo', 'Demo', source, subcommands)).rejects.toThrow('Unsafe');
    await writeRegistry(project, { demo: { source, description: 'Demo', subcommands } });
    expect((await tryExecuteCliExtension('demo', ['ping'], project, root))?.exitCode).toBe(1);
  });

  it('rejects source and module symlink escapes even in an edited registry', async () => {
    await symlink(root, path.join(project, 'escape'));
    await expect(registerCliCommands(project, 'demo', 'Demo', 'escape', subcommands)).rejects.toThrow('symlink');
    await writeRegistry(project, { demo: { source: 'escape', description: 'Demo', subcommands } });
    expect((await tryExecuteCliExtension('demo', ['ping'], project, root))?.exitCode).toBe(1);
    await writeFile(path.join(root, 'outside.mjs'), 'throw new Error("must not import");');
    await symlink(path.join(root, 'outside.mjs'), path.join(project, 'commands/linked.mjs'));
    await registerCliCommands(project, 'demo', 'Demo', 'commands', { ping: { file: 'linked.mjs', description: 'Ping' } });
    expect((await tryExecuteCliExtension('demo', ['ping'], project, root))?.message).toContain('escapes');
  });

  it('warns through doctor for missing absolute and relative sources with no bundles', async () => {
    await writeRegistry(project, {
      old: { source: path.join(root, 'missing'), description: 'Old', subcommands },
      local: { source: 'missing', description: 'Local', subcommands },
    });
    expect(await cliExtensionSourceWarnings(project)).toHaveLength(2);
    const section = await buildProjectLocalDoctorSection({ projectDir: project, frameworkRoot: root, config: null, quiet: true });
    expect(section.output).toContain("CLI extension 'old' source");
    expect(section.output).toContain("CLI extension 'local' source");
    expect(section.output).toContain('aiwg use <bundle>');
  });
});
