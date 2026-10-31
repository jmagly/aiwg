// Select only Flue's conventional database module and preserve operator modules.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const directory = file => exists(file) && fs.lstatSync(file).isDirectory();
const databaseFiles = () => ['.flue', 'src', ''].flatMap(dir => ['ts', 'mts', 'js', 'mjs'].map(ext => path.join(dir, `db.${ext}`)));
export function flueDeploymentFiles(target) {
  const source = ['.flue', 'src'].find(dir => directory(path.join(target, dir))) || 'src';
  // Snapshot config and conventional entries too: deployment reads a staged project.
  return [...new Set([path.join(source, 'db.ts'), '.gitignore', 'src/aiwg/tools.ts', 'src/aiwg/specialists.ts',
    'flue.config.ts', ...databaseFiles()])];
}
function explicitDatabase(target) {
  const config = path.join(target, 'flue.config.ts');
  if (!exists(config)) return false;
  // Static tokens only; comments and string/template contents cannot become keys.
  const tokens = fs.readFileSync(config, 'utf8').match(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g) || [];
  const code = tokens.filter(token => !token.startsWith('//') && !token.startsWith('/*'));
  return code.some((token, index) => ['db', '"db"', "'db'"].includes(token)
    && ['{', ','].includes(code[index - 1]) && code[index + 1] === ':');
}
export function claimRecordedFile(target, file, opts) {
  if (!exists(file)) return false;
  let record;
  try { record = JSON.parse(fs.readFileSync(path.join(target, '.aiwg/.aiwg-manifest.json'), 'utf8')).managed?.[path.relative(target, file).split(path.sep).join('/')]; }
  catch { return false; }
  const hash = `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
  if (!record?.filePreimage || record.hash !== hash) return false;
  opts.writtenFiles?.push(file);
  return true;
}
export function deployFlueDatabase(target, opts) {
  if (explicitDatabase(target)) {
    console.warn('Flue (experimental): keeping explicit db entry in flue.config.ts; verify the operator module selects durable SQLite at .flue-state/state.db.');
    return;
  }
  const relative = opts.flueDatabaseFile || flueDeploymentFiles(target)[0];
  const file = path.join(target, relative);
  // All conventional operator database formats take precedence over generation.
  const operator = databaseFiles().map(name => path.join(target, name))
    .find(exists);
  if (operator && !claimRecordedFile(target, operator, opts)) console.warn(`Flue (experimental): keeping existing database module ${opts.logicalOutputPath?.(operator) || operator}; verify it selects durable SQLite at .flue-state/state.db.`);
  else if (!operator && !opts.dryRun) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const state = path.relative(path.dirname(file), path.join(target, '.flue-state/state.db')).split(path.sep).join('/');
    fs.writeFileSync(file, `import { sqlite } from '@flue/runtime/node';\nimport { fileURLToPath } from 'node:url';\n\nexport default sqlite(fileURLToPath(new URL(${JSON.stringify(state)}, import.meta.url)));\n`);
  }
  const ignore = path.join(target, '.gitignore');
  claimRecordedFile(target, ignore, opts);
  const before = exists(ignore) ? fs.readFileSync(ignore, 'utf8') : '';
  if (!before.split(/\r?\n/).some(line => line.trim().replace(/^\//, '').replace(/\/(?:\*)?$/, '') === '.flue-state') && !opts.dryRun) {
    fs.writeFileSync(ignore, `${before}${before && !before.endsWith('\n') ? '\n' : ''}.flue-state/\n`);
  }
}
