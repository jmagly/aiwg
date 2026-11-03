// Exercise the real prepared UseHandler and its embedded/subprocess addon passes.
import { useHandler } from '../../../dist/src/cli/handlers/use.js';

globalThis.fetch = () => { throw new Error('Network is forbidden in deployment fixtures'); };
const args = ['sdlc', '--yes'];
const result = await useHandler.execute({ cwd: process.cwd(), frameworkRoot: process.env.AIWG_ROOT,
  rawArgs: ['use', ...args], args });
console.log(JSON.stringify(result));
process.exitCode = result.exitCode;
