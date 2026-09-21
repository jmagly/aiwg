export function renderGrokMcpServer(server: any): string;
export function mergeGrokMcpServers(text: string, servers: any[]): string;
export function removeGrokMcpServers(text: string, names: string[]): { text: string; removed: string[] };
export function manageGrokBuildMcp(configPath: string, servers: any[], options?: any): Promise<any>;
export function unmanageGrokBuildMcp(configPath: string, names: string[], options?: any): Promise<any>;
export function inspectGrokBuildNative(options?: any): Promise<any>;
