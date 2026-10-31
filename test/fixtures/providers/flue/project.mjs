// Prepare a synthetic project and CLI without using the operator's home or corpus.
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function prepareProject(root) {
  const project = path.join(root, 'project');
  const artifacts = path.join(root, 'artifacts');
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const corpus = path.join(root, 'corpus');
  for (const dir of [project, artifacts, home, bin, corpus]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(project, '.aiwg-location'), '../artifacts\n');
  const cli = await readFile(new URL('./cli.mjs', import.meta.url), 'utf8');
  await writeFile(path.join(bin, 'aiwg'), `#!${process.execPath}\n${cli}`, { mode: 0o755 });
  return {
    project, artifacts,
    options: {
      command: process.execPath,
      args: [fileURLToPath(new URL('./server.mjs', import.meta.url))],
      cwd: project,
      env: {
        HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'),
        PATH: [bin, path.dirname(process.execPath)].join(path.delimiter),
        AIWG_ROOT: corpus, AIWG_ARTIFACTS_PATH: '', AIWG_PROJECT_ARTIFACTS_PATH: '',
        AIWG_PROJECT_AIWG_DIR: '', TMPDIR: root,
      },
    },
  };
}
