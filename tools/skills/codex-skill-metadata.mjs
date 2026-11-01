// Update Codex's generated metadata with the same integrity receipts as skill payloads.
import fs from 'node:fs';
import path from 'node:path';
import { contentHash, readSidecarManifest, writeSidecarManifest } from '../agents/providers/base-files.mjs';
export function writeCodexSkillMetadata(skillDir, content) {
  const relative = 'agents/openai.yaml';
  const file = path.join(skillDir, relative);
  const receipt = readSidecarManifest(skillDir) || { managed: {} };
  const record = receipt.managed?.[relative];
  if (fs.existsSync(file)) {
    const current = fs.readFileSync(file, 'utf8');
    if (record?.hash ? record.hash !== `sha256:${contentHash(current)}` : current !== content) {
      console.warn(`${file}: kept (operator-edited or unrecorded metadata)`);
      return;
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  receipt.managed ??= {};
  receipt.managed[relative] = { ...record, hash: `sha256:${contentHash(content)}` };
  writeSidecarManifest(skillDir, receipt, false);
}
