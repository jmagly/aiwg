// Stream bounded Zstandard JSONL without materializing a plaintext file.
import { createReadStream } from 'node:fs';
import { createZstdDecompress } from 'node:zlib';
import { SessionContractError } from './contracts.js';
import { assertImportByteLimit, DEFAULT_IMPORT_BYTE_LIMITS, type ImportByteLimits } from './import-limits.js';

export async function* streamZstdLines(path: string, options: {
  start?: number; end?: number; limits?: ImportByteLimits;
}): AsyncGenerator<{ line: string; byteLength: number }> {
  const source = createReadStream(path);
  const decoder = createZstdDecompress();
  // Forward input failures and let async iteration own decoder failures.
  source.on('error', error => decoder.destroy(error));
  source.pipe(decoder);
  const limits = options.limits ?? DEFAULT_IMPORT_BYTE_LIMITS;
  let fragments: Buffer[] = [];
  let length = 0;
  let offset = 0;
  let total = options.start ?? 0;
  try {
    for await (const raw of decoder) {
      const chunk = raw as Buffer;
      const from = Math.max(0, (options.start ?? 0) - offset);
      const until = Math.min(chunk.length, (options.end ?? Infinity) - offset + 1);
      offset += chunk.length;
      let start = from;
      while (start < until) {
        const newline = chunk.indexOf(10, start);
        const end = newline < 0 || newline >= until ? until : newline + 1;
        const part = chunk.subarray(start, end);
        length += part.length;
        total += part.length;
        assertImportByteLimit('maxRecordBytes', limits, length);
        assertImportByteLimit('maxTotalBytes', limits, total);
        fragments.push(part);
        start = end;
        if (newline >= 0 && newline < until) {
          yield { line: Buffer.concat(fragments, length).toString('utf8'), byteLength: length };
          fragments = [];
          length = 0;
        }
      }
      if (options.end !== undefined && offset > options.end) break;
    }
    if (length) yield { line: Buffer.concat(fragments, length).toString('utf8'), byteLength: length };
  } catch (error) {
    if (error instanceof SessionContractError) throw error;
    throw new SessionContractError('MALFORMED_SOURCE', 'Zstandard session stream is damaged or unreadable; coverage is incomplete');
  } finally {
    source.destroy();
    decoder.destroy();
  }
}
