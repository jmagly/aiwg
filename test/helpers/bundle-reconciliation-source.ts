// Keep real SDLC, voice, kernels and the final extension in an isolated CLI corpus.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function bundleReconciliationSource(root: string, fullCorpus = false): string {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aiwg-bundle-source-'));
  try {
    fs.cpSync(path.join(root, 'agentic/code'), path.join(fixture, 'agentic/code'), { recursive: true, verbatimSymlinks: true });
    const hasKernelSkill = (dir: string): boolean => fs.existsSync(dir) && fs.readdirSync(dir, { withFileTypes: true }).some(entry => {
      const file = path.join(dir, entry.name);
      return entry.isDirectory() ? hasKernelSkill(file)
        : entry.name === 'SKILL.md' && /^kernel:\s*true\s*$/m.test(fs.readFileSync(file, 'utf8'));
    });
    // Preserve the full deployment's final rule projector and extension ownership.
    const extensions = path.join(fixture, 'agentic/code/extensions');
    const finalExtension = fs.readdirSync(extensions).filter(name => name !== 'api-adapter' && fs.existsSync(path.join(extensions, name, 'manifest.json'))).at(-1);
    // Keep every binding target readable. Only deployment eligibility is reduced.
    for (const group of fullCorpus ? [] : ['addons', 'extensions']) {
      const directory = path.join(fixture, 'agentic/code', group);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const manifestFile = path.join(directory, entry.name, 'manifest.json');
        if (!fs.existsSync(manifestFile)) continue;
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        const keep = entry.name === 'voice-framework' || manifest.core && manifest.autoInstall
          || group === 'extensions' && entry.name === finalExtension
          || hasKernelSkill(path.join(directory, entry.name, 'skills'));
        if (keep) continue;
        if (group === 'addons') fs.writeFileSync(manifestFile, JSON.stringify({ ...manifest, explicitInstall: true }, null, 2) + '\n');
        else fs.renameSync(manifestFile, manifestFile + '.inactive');
      }
    }
    fs.copyFileSync(path.join(root, 'package.json'), path.join(fixture, 'package.json'));
    fs.mkdirSync(path.join(fixture, '.git')); // Match the edge/source identity guard.
    // Execute this checkout's real compiled implementation and helper scripts.
    // The deployer's default source is relative to its own file, so copy tools.
    fs.cpSync(path.join(root, 'tools'), path.join(fixture, 'tools'), { recursive: true, verbatimSymlinks: true });
    // Ownership cases assert deployment, not doctor diagnostics. Keep the real
    // refresh path but avoid repeating its discovery smoke probes per case.
    // Real doctor dispatch/probes remain covered by the refresh and doctor suites.
    fs.writeFileSync(path.join(fixture, 'tools/cli/doctor.mjs'),
      "console.log('Reconciliation fixture: doctor covered separately');\n");
    for (const name of ['bin', 'dist', 'src', 'node_modules', 'schemas', 'docs']) fs.symlinkSync(path.join(root, name), path.join(fixture, name), 'dir');
    if (fullCorpus) fs.symlinkSync(path.join(root, 'prebuilt'), path.join(fixture, 'prebuilt'), 'dir');
    return fixture;
  } catch (error) {
    fs.rmSync(fixture, { recursive: true, force: true });
    throw error;
  }
}
