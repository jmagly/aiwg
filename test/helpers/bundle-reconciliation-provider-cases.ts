// Run the same ownership assertions for each provider in its own deployment shard.
import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { sdlcSetup, voiceSetup } from './bundle-reconciliation-cli.js';

export function registerProviderReconciliation(provider: 'claude' | 'codex') {
  it.each([false, true].map(declared => ({ provider, declared })))(
    'preserves edited voice bytes and original ownership across updates ($provider, declared=$declared)', ({ provider, declared }) => {
      // Keep the real framework, voice additive pass and all 19 kernel skills.
      // The complete addon/extension corpus is covered by the cases below.
      const fixture = sdlcSetup(provider);
      const { project, command, readConfig, writeConfig } = fixture;
      expect(readConfig().installed.sdlc.deployedTo[provider].skills).toBe(19);
      voiceSetup(provider, fixture);
      const skills = provider === 'codex' ? '.agents/skills' : '.claude/.aiwg/skills';
      const file = path.join(project, skills, 'voice-create/SKILL.md');
      const unchanged = path.join(project, skills, 'voice-apply/SKILL.md');
      const receipt = () => JSON.parse(fs.readFileSync(path.join(path.dirname(file), '.aiwg-manifest.json'), 'utf8')).managed['SKILL.md'];
      const originalHash = receipt().hash;
      const edited = fs.readFileSync(file, 'utf8') + '\n# operator note\n';
      fs.writeFileSync(file, edited);
      const update = () => {
        const output = command('update', '--skip-check', '--provider', provider);
        expect(fs.existsSync(file), output).toBe(true);
        expect(fs.readFileSync(file, 'utf8')).toBe(edited);
        expect(receipt().hash).toBe(originalHash);
        expect(receipt().owners).toEqual(['voice-framework']);
        expect(readConfig().installed.sdlc.deployedTo[provider].skills).toBe(19);
        expect(output).toMatch(/voice-create.*(?:operator-edited|modified or unverifiable)/);
      };
      if (declared) { update(); update(); }
      const config = readConfig(); delete config.installed['voice-framework']; writeConfig(config);
      update();
      expect(fs.existsSync(unchanged)).toBe(false);
      update();
      expect(fs.existsSync(unchanged)).toBe(false);
    }, 600_000,
  );
  it.each([provider])('keeps every additive owner after real use sdlc for %s', provider => {
    const { plans, readConfig, snapshot } = sdlcSetup(provider, true);
    expect(Object.keys(readConfig().installed)).toEqual(['sdlc']);
    const before = snapshot();
    for (const output of plans(provider)) {
      expect(output).not.toMatch(/Would remove|Removing \S+ for|stale AIWG-managed files/);
      expect(output).toContain(`aiwg use sdlc --provider ${provider}`);
    }
    expect(snapshot()).toEqual(before);
  }, 600_000);
  it.each([provider])('prunes only unchanged utils after a recorded --no-utils deploy (%s)', provider => {
    const { project, command, plans, readConfig, writeConfig } = sdlcSetup(provider, true);
    const skills = provider === 'codex' ? '.agents/skills' : '.claude/skills';
    const unchanged = path.join(project, skills, 'aiwg-help/SKILL.md');
    const edited = path.join(project, skills, 'aiwg-status/SKILL.md');
    const framework = path.join(project, skills, 'sdlc-quickref/SKILL.md');
    const frameworkBytes = fs.readFileSync(framework, 'utf8');
    fs.writeFileSync(edited, fs.readFileSync(edited, 'utf8') + '\nOperator note\n');
    const editedBytes = fs.readFileSync(edited, 'utf8');
    command('use', 'sdlc', '--provider', provider, '--no-project-local', '--no-utils', '--yes');
    expect(readConfig().installed.sdlc.deployedTo[provider]).toMatchObject({ skipUtils: true, kernelOnly: false });
    expect(fs.existsSync(unchanged)).toBe(true);
    const known = readConfig();
    const unknown = structuredClone(known);
    delete unknown.installed.sdlc.deployedTo[provider].skipUtils;
    delete unknown.installed.sdlc.deployedTo[provider].kernelOnly;
    writeConfig(unknown);
    for (const output of plans(provider)) expect(output).not.toContain(`Would remove aiwg-utils for ${provider}`);
    expect(fs.existsSync(unchanged)).toBe(true);
    writeConfig(known);
    for (const output of plans(provider)) expect(output).toContain(`Would remove aiwg-utils for ${provider}`);
    for (const [action, flag] of [['update', '--skip-check'], ['refresh', '--skip-update']]) {
      command(action, flag, '--provider', provider);
      expect(fs.existsSync(unchanged)).toBe(false);
      expect(fs.readFileSync(edited, 'utf8')).toBe(editedBytes);
      expect(fs.readFileSync(framework, 'utf8')).toBe(frameworkBytes);
      expect(readConfig().installed.sdlc.deployedTo[provider].skipUtils).toBe(true);
    }
  }, 600_000);
}
