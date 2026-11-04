// Bridge the indexed skill entrypoint to the shipped delivery source owner.
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.AIWG_ROOT ?? path.resolve(import.meta.dirname, '../../../../../../..');
const { main } = await import(pathToFileURL(path.join(root, 'dist/src/delivery/pr.js')).href);
try { process.exitCode = await main(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
