// Resolve adapters from the pinned peer's own graph, including nested npm layouts.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const runtimeRequire = createRequire(import.meta.resolve('@flue/runtime'));
const load = name => import(pathToFileURL(runtimeRequire.resolve(name)).href);
export const v = await load('valibot');
export const { Client } = await load('@modelcontextprotocol/client');
export const { StdioClientTransport, getDefaultEnvironment } = await load('@modelcontextprotocol/client/stdio');
