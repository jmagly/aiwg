// PR Steward opt-in is additive, boolean, and validated by schema and config loader.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Ajv from 'ajv';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyConfig, readAiwgConfig, writeAiwgConfig } from '../../../src/config/aiwg-config.js';
import { validateDeliverySettings } from '../../../src/config/delivery-validation.js';
import { main } from '../../../src/config/cli.js';

const schema = JSON.parse(fs.readFileSync('vscode-extension/schemas/aiwg.config.v1.json', 'utf8'));
const validate = new Ajv({ strict: true }).compile({
  type: 'object', properties: { delivery: schema.properties.delivery }, definitions: schema.definitions,
});
const fixture = (name: string) => JSON.parse(fs.readFileSync(`test/fixtures/providers/pr-steward/${name}.json`, 'utf8'));
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-steward-config-'));
  vi.stubEnv('HOME', path.join(root, 'home'));
  vi.stubEnv('XDG_CONFIG_HOME', path.join(root, 'home/.config'));
});
afterEach(() => { vi.unstubAllEnvs(); fs.rmSync(root, { recursive: true, force: true }); });

describe('PR Steward project config (#4383)', () => {
  it.each(fixture('valid'))('accepts additive or legacy config %j', async value => {
    expect(validate(value), JSON.stringify(validate.errors)).toBe(true);
    const config = { ...emptyConfig(), ...value };
    expect(validateDeliverySettings(config)).toEqual([]);
    await writeAiwgConfig(root, config);
    expect((await readAiwgConfig(root))?.delivery).toEqual(config.delivery);
  });
  it.each(fixture('invalid'))('rejects non-boolean opt-in %j in schema and loader', async value => {
    expect(validate(value)).toBe(false);
    expect(validateDeliverySettings(value)).toContain('delivery.pr_steward_guidance must be a boolean');
    fs.mkdirSync(path.join(root, '.aiwg'), { recursive: true });
    fs.writeFileSync(path.join(root, '.aiwg/aiwg.config'), JSON.stringify({ ...emptyConfig(), ...value }));
    await expect(readAiwgConfig(root)).rejects.toThrow('delivery.pr_steward_guidance must be a boolean');
    await expect(writeAiwgConfig(root, { ...emptyConfig(), ...value })).rejects.toThrow('delivery.pr_steward_guidance must be a boolean');
  });
  it('keeps schema and template defaults off', () => {
    expect(schema.properties.delivery.properties.pr_steward_guidance.default).toBe(false);
    expect(emptyConfig().delivery?.pr_steward_guidance).not.toBe(true);
  });
  it('sets boolean values through the existing project config CLI', async () => {
    for (const value of ['true', 'false']) {
      await main(['set', '--project', 'delivery.pr_steward_guidance', value, '--target', root]);
      expect((await readAiwgConfig(root))?.delivery?.pr_steward_guidance).toBe(value === 'true');
    }
    await expect(main(['set', '--project', 'delivery.pr_steward_guidance', 'yes', '--target', root])).rejects.toThrow(/must be 'true' or 'false'/);
  });
});
