// Diagnose inherited ACL masks using metadata only; never read artifact or credential contents.
import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { importImpl } from '../_resolve-impl.mjs';
const { readAcl } = await importImpl(import.meta.url, 'utils/workspace-permissions.mjs');

export async function inspectWorkspaceAclMasks(root) {
  const findings = [];
  async function visit(directory) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const parentAcl = readAcl(directory);
    const defaultMask = /^default:mask::([rwx-]{3})$/m.exec(parentAcl ?? '')?.[1];
    for (const entry of entries) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && defaultMask && defaultMask !== '---'
        && /^mask::---$/m.test(readAcl(file) ?? '')) {
        findings.push({ path: file, reason: 'acl-mask-collapsed',
          repair: `For a non-sensitive artifact, restore its reviewed mask with setfacl -m m::<mask> -- <file> (data files normally rw-; parent ${dirname(file)} defaults to ${defaultMask}). Keep credentials and secrets at 0600.` });
      }
    }
  }
  await visit(root);
  return findings;
}

export async function checkWorkspaceAclMasks(root, check) {
  try {
    const findings = await inspectWorkspaceAclMasks(root);
    for (const finding of findings) check('Workspace ACL mask', 'warn', `${finding.path}: mask::---. ${finding.repair}`);
  } catch (error) { check('Workspace ACL mask', 'warn', `Cannot inspect ACL masks: ${error.message}`); }
}
