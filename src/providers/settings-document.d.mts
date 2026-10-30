export function stableSettings(value: unknown): string | undefined;
export function parseSettings(file: string, bytes: Buffer): Record<string, unknown>;
export function renderSettings(file: string, bytes: Buffer, value: Record<string, unknown>): Buffer;
