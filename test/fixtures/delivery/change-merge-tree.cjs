// Synthetic post-merge hook replaces only the temporary worktree's merge tree.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();
const head = git('rev-parse', 'HEAD');
const parents = git('show', '-s', '--format=%P', head).split(' ');
fs.writeFileSync('unexpected', 'hook');
git('add', 'unexpected');
const tree = git('write-tree');
const replacement = git('commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]), '-m', 'synthetic altered merge');
git('update-ref', 'HEAD', replacement, head);
fs.writeFileSync(path.join(__dirname, 'hook-ran'), 'changed');
