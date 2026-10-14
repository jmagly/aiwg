/**
 * Scanned-page vision extraction (#1507) — provider-neutral orchestration.
 *
 * @source @src/artifacts/corpus-tools/vision-extract.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildPrompt,
  resolveAdapter,
  extractPages,
  pdftoppmAvailable,
  type VisionAdapter,
} from '../../../src/artifacts/corpus-tools/vision-extract.js';

let root: string;
let imageDir: string;
let outDir: string;

function pages(n: number): void {
  for (let i = 1; i <= n; i++) writeFileSync(join(imageDir, `page-${String(i).padStart(3, '0')}.png`), 'PNG');
}
/** Fake adapter: transcribes to `# Page N` unless the page is in `failPages`. */
function fake(failPages: number[] = []): VisionAdapter {
  return {
    name: 'fake',
    transcribe(_img, _prompt, ctx) {
      if (failPages.includes(ctx.page)) return { ok: false };
      return { ok: true, text: `# Page ${ctx.page}\n\nbody of page ${ctx.page}` };
    },
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'aiwg-vision-'));
  imageDir = join(root, 'images');
  outDir = join(root, 'out');
  mkdirSync(imageDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('buildPrompt (#1507)', () => {
  it('encodes the `# Page N` start contract', () => {
    const p = buildPrompt(7, 'Some Book');
    expect(p).toContain('Start exactly with: "# Page 7"');
    expect(p).toContain('Some Book');
    expect(p).toContain('[unreadable]');
  });
});

describe('resolveAdapter (#1507)', () => {
  it('defaults to codex', () => {
    expect(resolveAdapter().name).toBe('codex');
  });
  it('command provider requires a template', () => {
    expect(() => resolveAdapter({ provider: 'command' })).toThrow(/requires --command/);
    expect(resolveAdapter({ provider: 'command', command: 'x {image} {out}' }).name).toBe('command');
  });
  it('quotes image, prompt and output paths literally in shell templates (141)', () => {
    const marker = join(root, 'pwned');
    const backtickMarker = join(root, 'backtick-pwned');
    // A slash-free relative marker lets the payload appear in a directory name.
    // The command intentionally starts in root so an unsafe substitution touches it.
    const dir = join(root, "images {prompt_file} {out} $(touch pwned) `touch backtick-pwned` 'single' \\ \"double\"");
    mkdirSync(dir);
    const image = join(dir, 'page-001.png');
    writeFileSync(image, 'literal image');
    const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
    const adapter = resolveAdapter({ provider: 'command', command:
      `cd ${quote(root)} && cat {image} {prompt_file} > {out}` });
    const result = adapter.transcribe(image, '# Page 1\nPrompt', { root, page: 1, timeoutSec: 10 });
    expect(result).toEqual({ ok: true, text: 'literal image# Page 1\nPrompt' });
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(backtickMarker)).toBe(false);
    expect(existsSync(join(dir, '.vision-prompt-1.txt'))).toBe(false);
    expect(existsSync(join(dir, '.vision-out-1.txt'))).toBe(false);
  });
  it('rejects an unknown provider', () => {
    expect(() => resolveAdapter({ provider: 'bogus' })).toThrow(/unknown vision provider/);
  });
  it.each(['"{image}"', "$'{image}'", "'{prompt_file}'", '`{out}`', '\\{image}'])('rejects unsafe placeholder context %s (141)', (placeholder) => {
    const dir = join(root, '$(touch pwned)');
    mkdirSync(dir);
    const image = join(dir, 'page-001.png');
    writeFileSync(image, 'PNG');
    expect(() => {
      const adapter = resolveAdapter({ provider: 'command', command: `cd "${root}" && cat ${placeholder}` });
      adapter.transcribe(image, '# Page 1', { root, page: 1, timeoutSec: 10 });
    }).toThrow(/placeholders must/);
    expect(existsSync(join(root, 'pwned'))).toBe(false);
  });
});

describe('extractPages orchestration (#1507)', () => {
  it('transcribes pages → per-page + combined Markdown with complete markers', async () => {
    pages(3);
    const r = await extractPages({ imageDir, outDir, adapter: fake(), title: 'Test Book' });
    expect(r).toMatchObject({ processed: 3, completed: 3, failed: 0 });
    const p1 = readFileSync(join(outDir, 'pages', 'page-001.md'), 'utf8');
    expect(p1.startsWith('<!-- extraction-status: complete -->')).toBe(true);
    expect(p1).toContain('# Page 1');
    // Combined MD + stripped txt.
    const md = readFileSync(join(outDir, 'out.vision.md'), 'utf8');
    expect(md).toContain('# Test Book');
    expect(md).toContain('# Page 1');
    expect(md).toContain('# Page 3');
    const txt = readFileSync(join(outDir, 'out.vision.txt'), 'utf8');
    expect(txt).not.toContain('extraction-status'); // comment markers stripped
  });

  it('is resumable — a second run skips already-complete pages', async () => {
    pages(2);
    await extractPages({ imageDir, outDir, adapter: fake() });
    // An adapter that would FAIL every page; resume must not call it for complete pages.
    let calls = 0;
    const counting: VisionAdapter = { name: 'count', transcribe: (_i, _p, ctx) => { calls++; return { ok: true, text: `# Page ${ctx.page}` }; } };
    const r = await extractPages({ imageDir, outDir, adapter: counting });
    expect(calls).toBe(0); // both pages already complete → adapter never invoked
    expect(r.completed).toBe(2);
  });

  it('--force re-transcribes complete pages', async () => {
    pages(1);
    await extractPages({ imageDir, outDir, adapter: fake() });
    let calls = 0;
    const counting: VisionAdapter = { name: 'count', transcribe: (_i, _p, ctx) => { calls++; return { ok: true, text: `# Page ${ctx.page}` }; } };
    await extractPages({ imageDir, outDir, adapter: counting, force: true });
    expect(calls).toBe(1);
  });

  it('writes a failed marker when transcription fails after retries', async () => {
    pages(2);
    const r = await extractPages({ imageDir, outDir, adapter: fake([2]), retries: 1, sleep: () => {} });
    expect(r).toMatchObject({ completed: 1, failed: 1 });
    expect(readFileSync(join(outDir, 'pages', 'page-002.md'), 'utf8')).toContain('<!-- extraction-status: failed -->');
  });

  it('rejects output that does not start with the `# Page N` contract', async () => {
    pages(1);
    const wrong: VisionAdapter = { name: 'wrong', transcribe: () => ({ ok: true, text: 'garbage without the page header' }) };
    const r = await extractPages({ imageDir, outDir, adapter: wrong, sleep: () => {} });
    expect(r.failed).toBe(1);
  });

  it('honors --start / --end page filtering', async () => {
    pages(5);
    const r = await extractPages({ imageDir, outDir, adapter: fake(), start: 2, end: 3 });
    expect(r.processed).toBe(2);
    expect(existsSync(join(outDir, 'pages', 'page-002.md'))).toBe(true);
    expect(existsSync(join(outDir, 'pages', 'page-001.md'))).toBe(false);
  });
});

describe('pdftoppm availability (#1507 rasterize)', () => {
  it('reports a boolean (true in this env)', () => {
    expect(typeof pdftoppmAvailable()).toBe('boolean');
  });
});
