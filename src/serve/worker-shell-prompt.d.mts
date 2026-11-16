/** Private prompt staging shared by shell rendering and its runtime envelope. */
export function shellWorkerPromptPath(finalPath: string): string;
export const shellWorkerArtifactsRefusal: string;
export function stageShellWorkerPrompt(root: string, briefPath: string, briefDigest: string, finalPath: string): Promise<string>;
export function frameShellWorkerPrompt(root: string, args: string[]): Promise<Buffer>;
export function frameShellWorkerJson(root: string, args: string[]): Promise<string>;
