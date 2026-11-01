// Run only fake children so unit tests can interrupt an in-flight disposable upload.
import fs from 'node:fs';
import { deployedCheck } from '../../../helpers/flue-cloudflare-deployed.mjs';
import { fakeDeployedOptions } from './cloudflare-deployed-fixture.mjs';
const check = deployedCheck(fakeDeployedOptions(process.env.FAKE_CF_SCRATCH || process.argv[2], 'wait'));
if (process.env.AIWG_FLUE_CF_CONTROL) fs.writeFileSync(process.env.AIWG_FLUE_CF_CONTROL, JSON.stringify({ pid: process.pid }));
try { await check.start(); } catch { /* signal handler owns the exit code */ }
