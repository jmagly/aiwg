// Resolve the shipped agents through real generated skill modules and local runtime doubles.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
// @ts-expect-error provider tool module
import { generateFlueSkills } from '../../../tools/agents/providers/flue-skills.mjs';

const repository = path.resolve(import.meta.dirname, '../../..');
const skill = '---\nname: sdlc-quickref\ndescription: Synthetic quickref\n---\nSynthetic SDLC instructions.\n';
let scratch: string;
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-flue-example-'));
  vi.stubEnv('AIWG_ROOT', '');
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(scratch, { recursive: true, force: true }); });

it.each(['flue-node', 'flue-cloudflare'].flatMap(example => [false, true].map(fluePackage => ({ example, fluePackage }))))(
  'imports and mounts the shipped $example skill (package=$fluePackage)', ({ example, fluePackage }) => {
    const project = path.join(scratch, 'app');
    const source = path.join(scratch, 'corpus/agentic/code/frameworks/sdlc-complete');
    write(path.join(source, 'manifest.json'), '{}');
    write(path.join(source, 'skills/sdlc-quickref/SKILL.md'), skill);
    write(path.join(project, 'package.json'), '{"type":"module"}');
    const runtime = path.join(project, 'node_modules/@flue/runtime');
    write(path.join(runtime, 'package.json'), JSON.stringify({ type: 'module', exports: {
      '.': './index.mjs', './cloudflare': './cloudflare.mjs',
    } }));
    write(path.join(runtime, 'index.mjs'), `export const mounted = [];
export const useSkill = skill => mounted.push(skill);
export const useModel = () => {}, useTool = () => {}, useSubagent = () => {}, useMcpConnection = () => {};
`);
    write(path.join(runtime, 'cloudflare.mjs'), 'export const getCloudflareContext = () => ({ env: {} });');
    // Only tools and delegates are doubled; preserve the agent and generated skill imports byte-for-byte.
    write(path.join(project, 'src/aiwg/tools.ts'), `export const aiwg_discover = {}, aiwg_show = {}, aiwg_artifact_write = {};
export const aiwgConnection = () => ({}), bindRemoteSpecialist = definition => definition;
`);
    write(path.join(project, 'src/aiwg/specialists.ts'), 'export const codeReviewer = {}; export const useAiwgSpecialists = () => {};');
    if (fluePackage) {
      const packaged = path.join(project, 'node_modules/@aiwg/flue');
      write(path.join(packaged, 'package.json'), JSON.stringify({ name: '@aiwg/flue', type: 'module', exports: {
        './skills/sdlc-quickref/SKILL.md': './skills/sdlc-quickref/SKILL.md',
      } }));
      write(path.join(packaged, 'skills/sdlc-quickref/SKILL.md'), skill);
    } else {
      write(path.join(project, '.agents/skills/sdlc-quickref/SKILL.md'), skill);
    }
    const generated = generateFlueSkills(project, { srcRoot: source, mode: 'sdlc', fluePackage });
    expect(generated).toContain(`import sdlcQuickref from '${fluePackage ? '@aiwg/flue/skills' : '../../.agents/skills'}/sdlc-quickref/SKILL.md'`);
    write(path.join(project, 'src/aiwg/skills.ts'), generated);
    const agent = path.join(project, 'src/agents/assistant.ts');
    write(agent, fs.readFileSync(path.join(repository, 'examples', example, 'src/agents/assistant.ts'), 'utf8'));
    const probe = path.join(project, 'probe.mjs');
    fs.copyFileSync(path.join(repository, 'test/fixtures/providers/flue/skill-import-probe.mjs'), probe);
    const home = path.join(scratch, 'home'); fs.mkdirSync(home);
    const result = spawnSync(process.execPath, [probe, agent], {
      cwd: scratch, encoding: 'utf8', timeout: 30_000,
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: scratch,
        XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_DATA_HOME: home, XDG_STATE_HOME: home },
    });
    expect(result.status, `${result.stdout}\n${result.stderr}\n${result.error || ''}`).toBe(0);
    expect(result.stdout).toContain('PASS agent skill import and mount');
    expect(fs.existsSync(path.join(project, '.agents/skills'))).toBe(!fluePackage);
  },
);
