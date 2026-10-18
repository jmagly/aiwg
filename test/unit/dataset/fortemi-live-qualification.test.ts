import { mkdtemp } from '../../helpers/temp-dir.js';
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  qualifyFortemiDatasetLivePreflight,
  verifyFortemiDatasetExecutionQualification,
  verifyFortemiDatasetLiveReceipt,
  writeFortemiDatasetLiveReceipt,
} from "../../../src/dataset/fortemi-live-qualification.js";
import { fortemiReceiptDigest } from "../../../src/storage/fortemi-qualification-receipt.js";
import { fortemiDatasetDigest } from "../../../src/dataset/fortemi-run-receipt.js";

const commit = "a".repeat(40);
const compatibleTools = [{
  name: "manage_dataset_execution",
  inputSchema: { type: "object", required: ["action"], properties: {
    action: { type: "string", enum: ["capabilities", "preview", "execute", "status", "checkpoint", "cancel", "resume", "retry", "verify", "archive"] },
    request: { type: "object" }, runId: { type: "string" }, receipt: { type: "object" },
  } },
}];

describe("Fortemi dataset live preflight", () => {
  it("records an absent server contract as pending without invoking tools", async () => {
    const callTool = vi.fn();
    const close = vi.fn();
    const receipt = await qualifyFortemiDatasetLivePreflight({
      client: {
        listTools: async () => ({
          tools: [{ name: "search", inputSchema: { type: "object" } }],
        }),
        callTool,
        close,
        serverVersion: () => ({ name: "fortemi", version: "2026.9.1" }),
      },
      endpointUrl:
        "https://user:secret@fortemi.invalid/mcp?tenant=private#fragment",
      aiwgCommit: commit,
    });

    expect(receipt).toMatchObject({
      outcome: "pending",
      diagnostic: "CONFORMANCE_FORTEMI_DATASET_CONTRACT_UNAVAILABLE",
      observed: { serverName: "fortemi", serverVersion: "2026.9.1" },
      mutation: { authorized: false, attempted: false },
      resources: { networkAttempts: 1, toolCalls: 0 },
    });
    expect(JSON.stringify(receipt)).not.toContain("secret");
    expect(JSON.stringify(receipt)).not.toContain("private");
    expect(callTool).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
    expect(verifyFortemiDatasetLiveReceipt(receipt)).toEqual([]);
  });

  it("recognizes strict discovery but does not claim execution parity", async () => {
    const callTool = vi.fn();
    const receipt = await qualifyFortemiDatasetLivePreflight({
      client: {
        listTools: async () => ({ tools: compatibleTools }),
        callTool,
      },
      endpointUrl: "https://fortemi.invalid/mcp",
      aiwgCommit: commit,
    });

    expect(receipt.outcome).toBe("supported");
    expect(receipt.diagnostic).toBe(
      "CONFORMANCE_FORTEMI_DATASET_PREFLIGHT_SUPPORTED",
    );
    expect(receipt.mutation.attempted).toBe(false);
    expect(callTool).not.toHaveBeenCalled();
    expect(verifyFortemiDatasetLiveReceipt(receipt)).toEqual([]);
  });

  it("rejects hollow or duplicate advertised tool schemas", async () => {
    for (const tools of [
      compatibleTools.map((tool) => ({
        ...tool,
        inputSchema: { ...tool.inputSchema, properties: {} },
      })),
      [...compatibleTools, compatibleTools[0]],
    ]) {
      const receipt = await qualifyFortemiDatasetLivePreflight({
        client: { listTools: async () => ({ tools }), callTool: vi.fn() },
        endpointUrl: "https://fortemi.invalid/mcp",
        aiwgCommit: commit,
      });
      expect(receipt.outcome).toBe("pending");
    }
  });

  it("rejects non-finite bounds and sanitizes untrusted server metadata", async () => {
    await expect(
      qualifyFortemiDatasetLivePreflight({
        client: { listTools: async () => ({ tools: [] }), callTool: vi.fn() },
        endpointUrl: "https://fortemi.invalid/mcp",
        aiwgCommit: commit,
        maxDurationMs: Number.NaN,
      }),
    ).rejects.toThrow("CONFORMANCE_INVALID_RESOURCE_BOUND");
    const receipt = await qualifyFortemiDatasetLivePreflight({
      client: {
        listTools: async () => ({ tools: [] }),
        callTool: vi.fn(),
        serverVersion: () => ({
          name: "authorization=leaked",
          version: "bad value",
        }),
      },
      endpointUrl: "https://fortemi.invalid/mcp",
      aiwgCommit: commit,
    });
    expect(receipt.observed).toEqual({
      serverName: "unreported",
      serverVersion: "unreported",
    });
    expect(JSON.stringify(receipt)).not.toContain("leaked");
  });

  it("fails closed when discovery exceeds the tool inventory envelope", async () => {
    await expect(
      qualifyFortemiDatasetLivePreflight({
        client: {
          listTools: async () => ({
            tools: Array.from({ length: 257 }, (_, index) => ({
              name: `tool-${index}`,
              inputSchema: { type: "object" },
            })),
          }),
          callTool: vi.fn(),
        },
        endpointUrl: "https://fortemi.invalid/mcp",
        aiwgCommit: commit,
      }),
    ).rejects.toThrow("CONFORMANCE_RESOURCE_ENVELOPE_EXCEEDED");
  });

  it("rejects malformed and semantically forged receipts", async () => {
    expect(verifyFortemiDatasetLiveReceipt({})).toEqual([
      "CONFORMANCE_RECEIPT_SHAPE_INVALID",
    ]);
    expect(
      verifyFortemiDatasetLiveReceipt({
        bindings: {},
        observed: {},
        mutation: {},
        resources: {},
        operations: [null],
      }),
    ).toEqual(["CONFORMANCE_RECEIPT_SHAPE_INVALID"]);
    const receipt = await qualifyFortemiDatasetLivePreflight({
      client: {
        listTools: async () => ({ tools: compatibleTools }),
        callTool: vi.fn(),
      },
      endpointUrl: "https://fortemi.invalid/mcp",
      aiwgCommit: commit,
    });
    const material = {
      ...receipt,
      operations: [receipt.operations[0], receipt.operations[0]],
    };
    const { receiptDigest: _discarded, ...unsigned } = material;
    const forged = {
      ...unsigned,
      receiptDigest: fortemiReceiptDigest(unsigned),
    };
    expect(verifyFortemiDatasetLiveReceipt(forged)).toContain(
      "CONFORMANCE_RECEIPT_OPERATION_INVALID",
    );
    const leakedMaterial = {
      ...receipt,
      rawEndpoint: "https://sensitive.invalid/mcp",
    };
    const { receiptDigest: _oldDigest, ...leakedUnsigned } = leakedMaterial;
    const leaked = {
      ...leakedUnsigned,
      receiptDigest: fortemiReceiptDigest(leakedUnsigned),
    };
    expect(verifyFortemiDatasetLiveReceipt(leaked)).toContain(
      "CONFORMANCE_RECEIPT_SHAPE_INVALID",
    );
  });

  it("keeps catalog fixtures aligned with semantic verification", async () => {
    const valid = JSON.parse(
      await readFile(
        "test/fixtures/dataset/fortemi-live-qualification-receipt.valid.json",
        "utf8",
      ),
    );
    const invalid = JSON.parse(
      await readFile(
        "test/fixtures/dataset/fortemi-live-qualification-receipt.invalid.json",
        "utf8",
      ),
    );
    expect(verifyFortemiDatasetLiveReceipt(valid)).toEqual([]);
    expect(verifyFortemiDatasetLiveReceipt(invalid).length).toBeGreaterThan(0);
  });

  it("rejects tampered maturity evidence", async () => {
    const receipt = await qualifyFortemiDatasetLivePreflight({
      client: { listTools: async () => ({ tools: [] }), callTool: vi.fn() },
      endpointUrl: "https://fortemi.invalid/mcp",
      aiwgCommit: commit,
    });
    const forged = { ...receipt, outcome: "supported" as const };
    expect(verifyFortemiDatasetLiveReceipt(forged)).toEqual(
      expect.arrayContaining([
        "CONFORMANCE_RECEIPT_OUTCOME_INVALID",
        "CONFORMANCE_RECEIPT_DIGEST_MISMATCH",
      ]),
    );
  });

  it("durably writes private, non-overwriting evidence", async () => {
    const receipt = await qualifyFortemiDatasetLivePreflight({
      client: { listTools: async () => ({ tools: [] }), callTool: vi.fn() },
      endpointUrl: "https://fortemi.invalid/mcp",
      aiwgCommit: commit,
    });
    const directory = await mkdtemp(join(tmpdir(), "aiwg-dataset-live-"));
    const path = join(directory, "receipt.json");
    await writeFortemiDatasetLiveReceipt(path, receipt);
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(receipt);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(
      writeFortemiDatasetLiveReceipt(path, receipt),
    ).rejects.toThrow();
  });
});

describe("Fortemi dataset execution qualification evidence", () => {
  async function validEvidence() {
    const fixture = JSON.parse(await readFile(
      "test/fixtures/dataset/fortemi-run-receipt/degraded-run-receipt.json",
      "utf8",
    ));
    const { receiptDigest: _oldDigest, ...payload } = {
      ...fixture,
      bindings: { ...fixture.bindings, sourceRevision: commit },
    };
    const runReceipt = { ...payload, receiptDigest: fortemiDatasetDigest(payload) };
    const qualification = {
      schemaVersion: "fortemi.lane-b.dataset-live-qualification.v1",
      status: "PASS",
      boundedUnit: "fortemi-local-test-1000-018fd1a0-0000-7000-8000-000000001128.service",
      source: commit,
      release: "v2026.9.10",
      executableSha256: "b".repeat(64),
      checks: [
        "published API identity and clean migrated destination",
        "MCP initialize and capability discovery agree",
        "schema-bound preview has no side effects",
        "execute commits one synthetic record with valid redacted receipt",
        "status, checkpoint, resume, and exact in-process replay are stable",
        "fresh MCP process reconstructs byte-equivalent durable replay receipt",
        "namespace-scoped archive cleanup is complete and idempotent",
      ],
      mcpSessions: [
        { label: "initial", pid: 1001, stderrBytes: 0, closed: true },
        { label: "restart", pid: 1002, stderrBytes: 0, closed: true },
      ],
      boundary: "Synthetic single-record Community dataset execution against a private ephemeral PostgreSQL destination. No shared Fortemi, vLLM, Ollama, GPU, personal container, or persistent data is used.",
      apiPid: 1000,
      health: { status: "healthy", version: "2026.9.10", git_sha: commit, lifecycle: { ready: true } },
      migrations: 160,
      descriptorSha256: "c".repeat(64),
      run: {
        runId: runReceipt.runId,
        namespaceId: runReceipt.namespaceId,
        requestDigest: runReceipt.requestDigest,
        receiptDigest: runReceipt.receiptDigest,
        state: runReceipt.state,
        verification: "verified",
        checkpointSequence: 1,
        archive: { namespaceId: runReceipt.namespaceId, archived: 1, alreadyArchived: 0, unresolved: [], complete: true, reasonCodes: [] },
        contentSha256: `sha256:${"d".repeat(64)}`,
        sourceContentRetained: false,
      },
      finalDatabase: { visibleNotes: 0, archivedNotes: 1 },
      apiExit: { code: 0, signal: null },
      apiPidAbsent: true,
      apiOutputBytes: 100,
      apiOutputSha256: "e".repeat(64),
      scratchRemoved: true,
    };
    return { qualification, runReceipt };
  }

  it("binds the strong qualification to its canonical run receipt", async () => {
    const { qualification, runReceipt } = await validEvidence();
    expect(verifyFortemiDatasetExecutionQualification({
      qualification,
      runReceipt,
      expectedFortemiCommit: commit,
    })).toEqual([]);
  });

  it("rejects a wrapper whose cleanup or receipt binding was altered", async () => {
    const { qualification, runReceipt } = await validEvidence();
    qualification.scratchRemoved = false;
    runReceipt.bindings.sourceRevision = "f".repeat(40);
    expect(verifyFortemiDatasetExecutionQualification({
      qualification,
      runReceipt,
      expectedFortemiCommit: commit,
    })).toEqual(expect.arrayContaining([
      "CONFORMANCE_FORTEMI_EXECUTION_RECEIPT_MISMATCH",
      "CONFORMANCE_FORTEMI_EXECUTION_CLEANUP_INVALID",
      "CONFORMANCE_FORTEMI_RUN_RECEIPT_INVALID",
    ]));
  });

  it("rejects hollow evidence before it can promote the live cell", () => {
    expect(verifyFortemiDatasetExecutionQualification({
      qualification: { status: "PASS" },
      runReceipt: {},
      expectedFortemiCommit: commit,
    })).toEqual(expect.arrayContaining([
      "CONFORMANCE_FORTEMI_EXECUTION_EVIDENCE_SHAPE_INVALID",
      "CONFORMANCE_FORTEMI_RUN_RECEIPT_INVALID",
    ]));
  });
});
