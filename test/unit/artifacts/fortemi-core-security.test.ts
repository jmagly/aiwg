import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

const STATIC_BACKEND_FILES = [
  "src/artifacts/fortemi-core-sync.ts",
  "src/artifacts/fortemi-core-query-adapter.ts",
  "src/artifacts/browser-export.ts",
  "src/artifacts/query-engine.ts",
  "src/artifacts/query-engine-corpus.ts",
  "src/artifacts/query-engine-discover-output.ts",
  "src/artifacts/query-engine-discover.ts",
  "src/artifacts/query-engine-entries.ts",
  "src/artifacts/query-engine-index.ts",
  "src/artifacts/query-engine-matching.ts",
  "src/artifacts/query-engine-options.ts",
  "src/artifacts/query-engine-rules.ts",
  "src/artifacts/query-engine-scoring.ts",
  "src/artifacts/query-engine-show-card.ts",
  "src/artifacts/query-engine-show-load.ts",
  "src/artifacts/query-engine-show.ts",
  "src/artifacts/dep-graph.ts",
  "src/artifacts/graph-query.ts",
  "src/artifacts/index-status.ts",
  "src/research/query-cli.ts",
];

const DIRECT_NETWORK_PATTERNS = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\bWebSocket\b/,
  /\bEventSource\b/,
  /\baxios\b/,
  /\bundici\b/,
  /\bnode-fetch\b/,
  /\bgot\b/,
  /\brequest\s*\(/,
];

const SECRET_PATTERNS = [
  /\bAuthorization\b/i,
  /\bBearer\b/i,
  /\bapi[_-]?key\b/i,
  /\baccess[_-]?token\b/i,
  /\bclient[_-]?secret\b/i,
  /\bpassword\b/i,
];

describe("Fortemi Core static backend security gate", () => {
  it("keeps required static backend code free of direct network clients and credential hooks", () => {
    const findings: string[] = [];

    for (const file of STATIC_BACKEND_FILES) {
      const text = fs.readFileSync(path.resolve(file), "utf-8");
      for (const pattern of [...DIRECT_NETWORK_PATTERNS, ...SECRET_PATTERNS]) {
        if (pattern.test(text)) {
          findings.push(`${file}: ${pattern}`);
        }
      }
    }

    expect(findings).toEqual([]);
  });
});
