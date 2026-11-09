// Render a shell-neutral Node loader that executes only the anchored, reviewed bytes.
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

export function verifiedHookCommand(root: string, relative: string, bytes: Buffer, args: string[] = [], scope?: 'project' | 'user') {
  if (relative.split('/').includes('..') || !/^[.\w/-]+\.(?:cjs|js)$/.test(relative)) throw new Error('Invalid managed hook script path');
  const paths = process.platform === 'win32' ? path.win32 : path;
  const anchor = paths.resolve(root);
  const userHome = process.platform === 'win32' ? process.env.USERPROFILE || os.homedir() : os.homedir();
  const user = scope === 'user' || (scope === undefined && anchor === paths.resolve(userHome));
  const projectEnv = !user && relative.startsWith('.claude/') ? 'CLAUDE_PROJECT_DIR' : '';
  // Encoding data avoids shell expansion of $, %, backticks, quotes and backslashes
  // in install paths under sh, cmd.exe and PowerShell. The loader itself contains
  // only single-quoted JS strings inside the shell's double-quoted argument.
  const data = Buffer.from(JSON.stringify({ anchor, relative, args, projectEnv })).toString('base64');
  const hash = createHash('sha256').update(bytes).digest('hex');
  const loader = [
    "const fs=require('node:fs'),p=require('node:path'),M=require('node:module');",
    `const c=JSON.parse(Buffer.from('${data}','base64').toString());`,
    'const root=c.projectEnv?process.env[c.projectEnv]||c.anchor:c.anchor;',
    `const script=p.resolve(root,'${relative}');`,
    "if(p.relative(fs.realpathSync(script),script)!==''||!fs.lstatSync(script).isFile())throw Error('Unsafe AIWG hook path');",
    'const bytes=fs.readFileSync(script);',
    `if(require('node:crypto').createHash('sha256').update(bytes).digest('hex')!=='${hash}')throw Error('AIWG hook changed; redeploy and review');`,
    'process.argv=[process.execPath,script,...c.args];',
    'const m=new M(script);m.filename=script;m.paths=M._nodeModulePaths(p.dirname(script));',
    "m._compile(bytes.toString('utf8'),script);",
  ].join('');
  return `node -e "${loader}"`;
}
