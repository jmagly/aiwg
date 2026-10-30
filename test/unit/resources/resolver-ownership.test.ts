import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const pathname = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...walk(pathname));
    } else if (entry.isFile() && pathname.endsWith(".ts")) {
      found.push(pathname);
    }
  }
  return found;
}

describe("AIWG resource resolver ownership", () => {
  it("keeps verified web raw-resource reads inside resolver-owned modules", () => {
    const allowed = new Set([
      "src/resources/resolver.ts",
      "src/resources/web-release.ts",
      // #3306: `aiwg show --resource` reads a verified companion file for the card.
      "src/artifacts/query-engine-show-card.ts",
    ]);
    const offenders = walk(path.join(REPO_ROOT, "src"))
      .filter((pathname) => !allowed.has(path.relative(REPO_ROOT, pathname).replace(/\\/g, "/")))
      .filter((pathname) => fs.readFileSync(pathname, "utf8").includes("fetchVerifiedRawResource"))
      .map((pathname) => path.relative(REPO_ROOT, pathname).replace(/\\/g, "/"));

    expect(offenders).toEqual([]);
  });
});
