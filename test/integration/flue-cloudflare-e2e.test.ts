// Release-slow local workerd qualification of the shipped package-mode example.
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe } from 'vitest';
import { launchHttp } from '../fixtures/mcp/http-service.mjs';
import { prepareCloudflare, buildCloudflare, verifyCloudflareDependencies } from '../helpers/flue-cloudflare.mjs';

import { registerCloudflareCases, type CloudflareContext } from '../helpers/flue-cloudflare-cases.js';

const state = {} as CloudflareContext;
const example = path.resolve(import.meta.dirname, '../../examples/flue-cloudflare');
const dependencyProject = process.env.AIWG_FLUE_CF_DEPENDENCIES || example;
let app: Awaited<ReturnType<typeof prepareCloudflare>>;
let service: Awaited<ReturnType<typeof launchHttp>>;
let origin: string, artifact: string, buildLog: string, buildMs: number;
function vars(token: string) {
  // Only generated tokens enter the temp project's ignored local binding file.
  fs.writeFileSync(path.join(app.project, '.dev.vars'), [
    `AIWG_MCP_URL=${JSON.stringify(service.url)}`, `AIWG_MCP_TOKEN=${JSON.stringify(token)}`,
    'FLUE_MODEL="aiwg-cf-test/scripted"', `AIWG_EXPECTED_ARTIFACT=${JSON.stringify(artifact)}`, '',
  ].join('\n'), { mode: 0o600 });
}

describe('Flue Cloudflare local emulation', () => {
  beforeAll(async () => {
    verifyCloudflareDependencies(dependencyProject);
    app = await prepareCloudflare(dependencyProject);
    service = await launchHttp();
    artifact = path.join(service.project, '.aiwg/reviews/cloudflare.md');
    vars(service.token);
    ({ buildLog, buildMs } = await buildCloudflare(app));
    origin = await app.start();
    Object.assign(state, { app, service, origin, artifact, buildLog, buildMs });
  }, 600_000);
  afterAll(async () => { await app?.close(); await service?.close(); }, 30_000);
  Object.assign(state, {
    async restart() { await app.stop(); origin = await app.start(); state.origin = origin; },
    async setToken(token: string) { await app.stop(); vars(token); origin = await app.start(); state.origin = origin; },
    failureDetails: () => app.logs(),
  });
  registerCloudflareCases(state);
});
