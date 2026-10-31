// Select only Flue's conventional database module and preserve operator modules.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const exists = file => { try { fs.lstatSync(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
const directory = file => exists(file) && fs.lstatSync(file).isDirectory();
const databaseFiles = () => ['.flue', 'src', ''].flatMap(dir => ['ts', 'mts', 'js', 'mjs'].map(ext => path.join(dir, `db.${ext}`)));
// Flue 2.3.0: @flue/runtime/dist/config.mjs:91-98,113-116 (first existing wins).
const configFiles = ['ts', 'mts', 'mjs', 'js', 'cjs', 'cts'].map(ext => `flue.config.${ext}`);
export function flueDeploymentFiles(target) {
  const source = ['.flue', 'src'].find(dir => directory(path.join(target, dir))) || 'src';
  // Snapshot config and conventional entries too: deployment reads a staged project.
  return [...new Set([path.join(source, 'db.ts'), '.gitignore', 'src/aiwg/tools.ts', 'src/aiwg/specialists.ts',
    ...configFiles, ...databaseFiles()])];
}
function explicitDatabase(target) {
  const config = configFiles.find(file => exists(path.join(target, file)));
  if (!config) return;
  // Static tokens only; comments and string/template contents cannot become keys.
  const tokens = fs.readFileSync(path.join(target, config), 'utf8').match(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[A-Za-z_$][\w$]*|[^\s]/g) || [];
  const code = tokens.filter(token => !token.startsWith('//') && !token.startsWith('/*'));
  let start = code.findIndex((token, index) => token === 'export' && code[index + 1] === 'default');
  if (start >= 0) start += 2;
  else {
    start = code.findIndex((token, index) => token === 'module' && code.slice(index + 1, index + 4).join('') === '.exports=');
    if (start < 0) return;
    start += 4;
  }
  // Accept a literal default export, optionally parenthesized or wrapped in defineConfig.
  if (code[start] === 'defineConfig' && code[start + 1] === '(') start += 2;
  while (code[start] === '(') start++;
  if (code[start] !== '{') return;
  const nesting = [];
  for (let index = start; index < code.length; index++) {
    const token = code[index];
    if (nesting.length === 1 && ['db', '"db"', "'db'"].includes(token)
      && ['{', ','].includes(code[index - 1]) && code[index + 1] === ':') return config;
    if (['{', '[', '('].includes(token)) nesting.push(token);
    else if (['}', ']', ')'].includes(token)) {
      nesting.pop();
      if (!nesting.length) break;
    }
  }
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
  const config = explicitDatabase(target);
  if (config) {
    console.warn(`Flue (experimental): keeping explicit db entry in ${config}; verify the operator module selects durable SQLite at .flue-state/state.db.`);
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
  if (!before.split(/\r?\n/).some(line => line.trim().replace(/^\//, '').replace(/\/\*{0,2}$/, '') === '.flue-state') && !opts.dryRun) {
    fs.writeFileSync(ignore, `${before}${before && !before.endsWith('\n') ? '\n' : ''}.flue-state/\n`);
  }
}
