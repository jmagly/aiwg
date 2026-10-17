import { mkdtemp } from '../../helpers/temp-dir.js';
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";
import {
  createFortemiQualificationReceipt,
  endpointFingerprint,
  resolveFortemiQualificationSource,
  verifyFortemiQualificationReceipt,
  writeFortemiQualificationReceipt,
} from "../../../src/storage/fortemi-qualification-receipt.js";

const base = () => ({
  report: {
    schema: "aiwg.fortemi-live-qualification/v1" as const,
    compatible: false,
    mutationAttempted: false,
    server: { name: "fortemi", version: "2026.9.1" },
    namespace: "aiwg-qualification-123e4567-e89b-42d3-a456-426614174000",
    operations: [
      {
        operation: "read",
        tool: "get_note",
        compatible: false,
        code: "FORTEMI_TOOL_SCHEMA_DRIFT",
        detail: "secret-bearing detail must be omitted",
      },
      ...["write", "update", "list", "query"].map((operation) => ({
        operation,
        tool: `${operation}_tool`,
        compatible: true,
        code: "FORTEMI_TOOL_SCHEMA_COMPATIBLE",
        detail: "compatible",
      })),
    ],
  },
  endpointUrl: "https://user:password@titan.example/mcp?token=secret#fragment",
  toolSchemas: { get_note: { required: ["id"] } },
  aiwgCommit: "a".repeat(40),
  aiwgRef: "refs/heads/main",
  contractRevision: "2026-07-06",
  startedAt: "2026-09-04T12:00:00Z",
  endedAt: "2026-09-04T12:00:01Z",
  timeoutMs: 5000,
  networkAttempts: 2,
});

describe("Fortemi durable live qualification receipt", () => {
  it("binds evidence while excluding raw endpoint and diagnostic detail", () => {
    const input = base();
    const receipt = createFortemiQualificationReceipt(input);
    const serialized = JSON.stringify(receipt);
    expect(receipt.bindings.endpointFingerprint).toBe(
      endpointFingerprint(input.endpointUrl),
    );
    expect(receipt.outcome).toBe("failed");
    expect(receipt.bindings.toolSchemaDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(receipt.resources).toEqual({
      timeoutMs: 5000,
      durationMs: 1000,
      networkAttempts: 2,
      toolCount: 5,
    });
    expect(serialized).not.toContain("titan.example");
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("secret-bearing");
    expect(verifyFortemiQualificationReceipt(receipt)).toEqual([]);
  });

  it("writes atomically with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aiwg-fortemi-receipt-"));
    const path = join(directory, "receipt.json");
    const receipt = createFortemiQualificationReceipt(base());
    await writeFortemiQualificationReceipt(path, receipt);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(receipt);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(
      writeFortemiQualificationReceipt(path, receipt),
    ).rejects.toMatchObject({
      code: "EEXIST",
    });
  });

  it("detects tampering", () => {
    const receipt = createFortemiQualificationReceipt(base());
    receipt.observed.serverVersion = "2026.9.2";
    expect(verifyFortemiQualificationReceipt(receipt)).toContain(
      "FORTEMI_RECEIPT_DIGEST_MISMATCH",
    );
    const outcomeTamper = createFortemiQualificationReceipt(base());
    outcomeTamper.outcome = "passed";
    expect(verifyFortemiQualificationReceipt(outcomeTamper)).toEqual(
      expect.arrayContaining([
        "FORTEMI_RECEIPT_DIGEST_MISMATCH",
        "FORTEMI_RECEIPT_OUTCOME_INVALID",
      ]),
    );
  });

  it("uses validated CI source bindings without invoking git", () => {
    expect(
      resolveFortemiQualificationSource({
        AIWG_STORAGE_QUALIFICATION_COMMIT: "b".repeat(40),
        AIWG_STORAGE_QUALIFICATION_BRANCH: "qualification",
      }),
    ).toEqual({
      aiwgCommit: "b".repeat(40),
      aiwgRef: "refs/heads/qualification",
    });
  });
});
