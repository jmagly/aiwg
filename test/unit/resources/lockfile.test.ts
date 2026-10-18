import { mkdtempSync } from '../../helpers/temp-dir.js';
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RESOURCE_LOCK_KEY,
  RESOURCE_LOCKFILE_NAME,
  RESOURCE_LOCKFILE_SCHEMA,
  readResourceLockfile,
  releaseToLockedWebResource,
  resourceLockfilePath,
  writeWebResourceLock,
} from "../../../src/resources/lockfile.js";
import { createWebResourceReleaseFixture } from "../../fixtures/web-resource-release.js";
import { resolveWebRelease } from "../../../src/resources/web-release.js";

describe("resource lockfile", () => {
  let projectDir: string;
  let cacheRoot: string;
  let fixture: ReturnType<typeof createWebResourceReleaseFixture>;
  let previousArtifactsPath: string | undefined;

  beforeEach(async () => {
    projectDir = mkdtempSync(path.join(os.tmpdir(), "aiwg-resource-lock-project-"));
    cacheRoot = mkdtempSync(path.join(os.tmpdir(), "aiwg-resource-lock-cache-"));
    fixture = createWebResourceReleaseFixture();
    await fixture.start();
    previousArtifactsPath = process.env.AIWG_ARTIFACTS_PATH;
    delete process.env.AIWG_ARTIFACTS_PATH;
  });

  afterEach(async () => {
    if (previousArtifactsPath === undefined) delete process.env.AIWG_ARTIFACTS_PATH;
    else process.env.AIWG_ARTIFACTS_PATH = previousArtifactsPath;
    await fixture.stop();
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(cacheRoot, { recursive: true, force: true });
  });

  async function release() {
    const published = fixture.publishRelease();
    fixture.publishChannel("stable", 4, published);
    return resolveWebRelease({
      selector: "stable",
      baseUrl: fixture.baseUrl,
      cacheRoot,
      publicKeyPem: fixture.publicKeyPem,
      allowInsecureLoopbackHttp: true,
    });
  }

  it("writes the default framework web resource lock entry", async () => {
    const resolved = await release();
    const result = writeWebResourceLock(projectDir, resolved, { now: new Date("2026-07-24T12:00:00.000Z") });

    expect(result.path).toBe(path.join(projectDir, ".aiwg", RESOURCE_LOCKFILE_NAME));
    expect(result.entry).toMatchObject({
      source: "web",
      selector: "stable",
      selectorKind: "channel",
      version: resolved.version,
      manifestUrl: `${fixture.baseUrl}/resources/${resolved.version}/manifest.json`,
      manifestSha256: resolved.manifestDigest,
      channelSequence: 4,
      lockedAt: "2026-07-24T12:00:00.000Z",
    });
    expect(result.entry.fortemiCore.exportSha256).toBe(resolved.fortemiExportSha256);

    const lockfile = readResourceLockfile(projectDir);
    expect(lockfile?.schemaVersion).toBe(RESOURCE_LOCKFILE_SCHEMA);
    expect(lockfile?.resources[DEFAULT_RESOURCE_LOCK_KEY]).toEqual(result.entry);
  });

  it("preserves other lock entries while updating the selected resource key", async () => {
    const resolved = await release();
    fs.mkdirSync(path.join(projectDir, ".aiwg"), { recursive: true });
    fs.writeFileSync(resourceLockfilePath(projectDir), JSON.stringify({
      schemaVersion: RESOURCE_LOCKFILE_SCHEMA,
      generatedAt: "2026-07-23T12:00:00.000Z",
      resources: {
        custom: releaseToLockedWebResource(resolved, new Date("2026-07-23T12:00:00.000Z")),
      },
    }, null, 2) + "\n");

    const result = writeWebResourceLock(projectDir, resolved, {
      key: "framework",
      now: new Date("2026-07-24T12:00:00.000Z"),
    });

    expect(Object.keys(result.lockfile.resources).sort()).toEqual(["custom", "framework"]);
    expect(result.lockfile.resources.framework.lockedAt).toBe("2026-07-24T12:00:00.000Z");
    expect(result.lockfile.resources.custom.lockedAt).toBe("2026-07-23T12:00:00.000Z");
  });

  it("honors the configured project artifact root", async () => {
    const resolved = await release();
    const externalAiwg = mkdtempSync(path.join(os.tmpdir(), "aiwg-resource-lock-external-"));
    process.env.AIWG_ARTIFACTS_PATH = externalAiwg;

    const result = writeWebResourceLock(projectDir, resolved);

    expect(result.path).toBe(path.join(path.resolve(externalAiwg), RESOURCE_LOCKFILE_NAME));
    expect(fs.existsSync(path.join(projectDir, ".aiwg", RESOURCE_LOCKFILE_NAME))).toBe(false);
    expect(readResourceLockfile(projectDir)?.resources.framework.version).toBe(resolved.version);
  });

  it("rejects malformed lockfiles", () => {
    fs.mkdirSync(path.join(projectDir, ".aiwg"), { recursive: true });
    fs.writeFileSync(resourceLockfilePath(projectDir), JSON.stringify({
      schemaVersion: "not-the-schema",
      resources: {},
    }));

    expect(() => readResourceLockfile(projectDir)).toThrow(/unsupported schemaVersion/);
  });
});
