// Explicit manual counterpart of the local workerd suite, using a disposable real Worker.
import fs from 'node:fs';
import { afterAll, beforeAll, describe } from 'vitest';
import { deployedCheck } from '../helpers/flue-cloudflare-deployed.mjs';
import { registerCloudflareCases, type CloudflareContext } from '../helpers/flue-cloudflare-cases.js';

describe('Flue Cloudflare deployed (manual only)', () => {
  const check = deployedCheck();
  if (process.env.AIWG_FLUE_CF_CONTROL) fs.writeFileSync(process.env.AIWG_FLUE_CF_CONTROL, JSON.stringify({ pid: process.pid }), { mode: 0o600 });
  const state = { record: check.record, redact: check.redact } as CloudflareContext;
  beforeAll(async () => { Object.assign(state, await check.start()); }, 600_000);
  afterAll(async () => { await check.close(); }, 120_000);
  registerCloudflareCases(state);
});
