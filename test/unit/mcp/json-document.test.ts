// JSONC-tolerant settings parsing shared by the Muse MCP config and deployment ownership.
import { describe, expect, it } from 'vitest';
// @ts-expect-error shipped JavaScript module
import { parseJson } from '../../../src/mcp/json-document.mjs';

describe('parseJson', () => {
  it('parses plain JSON unchanged', () => {
    expect(parseJson('{"a":1,"b":[true,null]}')).toEqual({ a: 1, b: [true, null] });
  });

  it('drops line and block comments outside strings', () => {
    expect(parseJson('{\n  // a line comment\n  "a": 1, /* block */ "b": 2\n}')).toEqual({ a: 1, b: 2 });
  });

  it('keeps // and /* that appear inside strings', () => {
    expect(parseJson('{"url":"https://example.com/x","glob":"src/**/*.ts"}'))
      .toEqual({ url: 'https://example.com/x', glob: 'src/**/*.ts' });
  });

  it('handles escaped quotes inside strings', () => {
    expect(parseJson('{"q":"say \\"hi\\" // not a comment"}')).toEqual({ q: 'say "hi" // not a comment' });
  });

  it('treats an unterminated block comment as running to the end', () => {
    expect(() => parseJson('{"a":1} /* never closed')).not.toThrow();
    expect(parseJson('{"a":1} /* never closed')).toEqual({ a: 1 });
  });

  it('accepts a Buffer-like input via String()', () => {
    expect(parseJson(Buffer.from('{"a":2}'))).toEqual({ a: 2 });
  });

  it('still rejects invalid JSON', () => {
    expect(() => parseJson('{"a":}')).toThrow();
    expect(() => parseJson('{"a":1 // unterminated object')).toThrow();
  });
});
