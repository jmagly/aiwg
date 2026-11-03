// Sample the project and actual CLI request filesystems before rendering a worker.
import path from 'node:path';
import { readLiveHostResources, type HostResourceReaders } from '../../config/host-resource-runtime.mjs';
import { parseWorkerCommandArgs } from '../../serve/worker-command-request.js';
import type { HandlerContext } from './types.js';

export function sampleWorkerHostResources(ctx: Pick<HandlerContext, 'cwd' | 'args'>, readers?: HostResourceReaders) {
  const request = ctx.args[0] === 'resolve' ? parseWorkerCommandArgs(ctx.args.slice(1)) : undefined;
  const paths = request ? [ctx.cwd, request.workdir, path.dirname(request.final_output)] : [ctx.cwd];
  return readLiveHostResources({ ...readers, paths, workspace: request?.workdir ?? ctx.cwd });
}
