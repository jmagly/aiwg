/**
 * Scanned-page vision extraction (#1507). TS-native, provider-neutral port of
 * section9 `scripts/corpus/codex_vision_extract_pages.sh`.
 *
 * Transcribes a directory of scanned page PNGs into per-page + combined Markdown
 * via a pluggable vision adapter (the source script hardcoded the `codex` CLI;
 * per the issue this is provider-neutral). Preserves the resumable / retry /
 * `# Page N` contract and the `<!-- extraction-status: complete -->` markers.
 * Optionally rasterizes a PDF → page PNGs first (poppler `pdftoppm`).
 *
 * Adapters:
 *  - `codex`   — `codex exec --sandbox read-only --image … --output-last-message`
 *  - `command` — a generic shell-command template (AIWG_VISION_COMMAND) with
 *                {image}/{prompt_file}/{out} placeholders → works with any vision
 *                CLI (claude, a custom script, …). Truly provider-neutral.
 *  - a caller-supplied adapter (used by tests with a fake transcriber).
 *
 * @source historical: corpus/codex_vision_extract_pages.sh
 * @tests @test/unit/artifacts/vision-extract.test.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { boundedSpawnSync, positiveTimeoutMs } from '../../process/bounded-child-process.mjs';

export interface TranscribeResult {
  ok: boolean;
  text?: string;
}

export interface VisionAdapter {
  name: string;
  /** Transcribe one image given the prompt; return `{ ok, text }`. */
  transcribe(imagePath: string, prompt: string, ctx: { root: string; page: number; timeoutSec: number; model?: string }): TranscribeResult;
}

/** Strict-transcription prompt. `title` parameterizes the corpus-specific intro. */
export function buildPrompt(page: number, title?: string): string {
  const subject = title ? `from ${title}` : 'from a scanned document';
  return [
    `You are transcribing one scanned page image ${subject}.`,
    '',
    'Task:',
    '- Extract all readable text from this image as accurately as possible.',
    '- Preserve reading order.',
    '- Keep headings, captions, labels, footnotes, marginal text, chart labels, table entries, and page numbers when readable.',
    '- If text is part of a figure or chart, include it under a short marker like "[figure text]" or "[chart labels]".',
    '- Do not summarize, interpret, modernize spelling, or add commentary.',
    '- If a word is uncertain, write the best reading followed by "[?]".',
    '- If a region is unreadable, write "[unreadable]" only for that region.',
    '- Output Markdown only.',
    `- Start exactly with: "# Page ${page}"`,
    '',
    'Accuracy is more important than preserving coordinates or line breaks.',
  ].join('\n');
}

// ── Adapters ─────────────────────────────────────────────────────────────────

const codexAdapter: VisionAdapter = {
  name: 'codex',
  transcribe(imagePath, prompt, ctx) {
    const tmp = path.join(path.dirname(imagePath), `.codex-out-${ctx.page}.txt`);
    const args = ['exec'];
    if (ctx.model) args.push('--model', ctx.model);
    args.push('--sandbox', 'read-only', '--cd', ctx.root, '--image', imagePath, '--output-last-message', tmp, '-');
    try {
      const r = spawnSync(process.env.AIWG_CODEX_BIN || 'codex', args, {
        input: prompt,
        // ctx.timeoutSec is caller-controlled (a CLI flag); clamp it so a
        // configured 0 (or anything else non-positive) can't disable the
        // bound entirely (#3062 B/C finding 8). 240s matches this
        // function's own documented default (see extractPages() below).
        timeout: positiveTimeoutMs(ctx.timeoutSec * 1000, 240_000),
        encoding: 'utf8',
        killSignal: 'SIGKILL',
      });
      if (r.status === 0 && fs.existsSync(tmp)) {
        const text = fs.readFileSync(tmp, 'utf8');
        fs.rmSync(tmp, { force: true });
        return { ok: true, text };
      }
      fs.rmSync(tmp, { force: true });
      return { ok: false };
    } catch {
      fs.rmSync(tmp, { force: true });
      return { ok: false };
    }
  },
};

/** Paths enter the shell as positional arguments, never as shell source. */
const MAX_VISION_TEMPLATE_LENGTH = 4096;

function visionCommand(template: string): string {
  const guidance = 'Use "$1"/"$2"/"$3" as data operands or move complex logic to a wrapper script';
  const reject = (construct: string): never => {
    throw new Error(`Vision command rejects ${construct}. ${guidance}`);
  };
  // Bound the checks below; a vision command template is a short command line.
  if (template.length > MAX_VISION_TEMPLATE_LENGTH) reject(`templates longer than ${MAX_VISION_TEMPLATE_LENGTH} characters`);
  // A vision template is one command line; a backslash-newline continuation can
  // join an allowed name with following text into a different variable at runtime.
  if (/\\\r?\n|\\\r/.test(template)) reject('line continuations (backslash-newline)');
  // Recognize literal command names even when quoted or backslash-escaped.
  const syntax = template.replace(/\\([^\n])/g, '$1').replace(/["']/g, '');
  if (syntax.includes('$(')) reject('command substitution ($(...))');
  if (template.includes('`')) reject('backticks');
  if (/\beval\b/.test(syntax)) reject('eval');
  if (syntax.includes('<<')) reject('here-documents and here-strings (<<)');
  // Conservatively reject a shell word together with any short -c option
  // cluster, regardless of order, wrappers, redirections or command boundaries.
  const words = syntax.split(/[\s;&|(){}<>]+/);
  const shellWords = words.map(word => word.slice(word.lastIndexOf('/') + 1)
    .match(/^(?:sh|bash|zsh|dash|ksh|ash|mksh|yash|fish|csh|tcsh|rbash|busybox|toybox)(?:$|(-[A-Za-z]*c))/));
  const hasShell = shellWords.some(Boolean);
  if (shellWords.some(word => word?.[1]) || (hasShell && words.some(word => /^-[A-Za-z]*c/.test(word)))) reject('nested shell invocation (-c)');

  // Only contract-provided parameters may expand; match at each dollar without
  // rescanning the remaining template. Braces must contain only the exact name.
  const parameter = /\$(?:[123](?![0-9])|AIWG_VISION_(?:IMAGE|PROMPT_FILE|OUT)(?![A-Za-z0-9_])|\{(?:[123]|AIWG_VISION_(?:IMAGE|PROMPT_FILE|OUT))\})/y;
  // Track quotes to reject quoted/escaped placeholders, expansions and comments.
  let quote = '';
  return template.replace(/\\?\{(image|prompt_file|out)\}|\\[\s\S]|\$'|[$"'#]/g, (token, name: string | undefined, offset: number) => {
    if ((token === '#' || token === '\\#') && quote !== "'") reject('comments (# outside single quotes)');
    if (name) {
      if (quote) throw new Error(`Vision command placeholders must be outside shell quotes. ${guidance}`);
      if (token.startsWith('\\')) throw new Error(`Vision command placeholders must not be escaped. ${guidance}`);
      return `"$${name === 'image' ? 1 : name === 'prompt_file' ? 2 : 3}"`;
    }
    if (token === '#') return token;
    // Backslashes are literal inside POSIX single quotes, but escape the next
    // character in double quotes and ANSI-C ($'...') quotes.
    if (token.startsWith('\\')) {
      if (quote === "'" && token[1] === "'") quote = '';
      return token;
    }
    if (token.startsWith('$')) {
      if (quote !== "'") {
        parameter.lastIndex = offset;
        if (!parameter.test(template)) reject('parameter expansions other than the provided vision variables');
      }
      if (token === '$') return token;
    }
    if (!quote) quote = token;
    else if (quote === token || (quote === "$'" && token === "'") || (quote === "'" && token === "$'")) quote = '';
    return token;
  });
}

/**
 * Generic command-template adapter (provider-neutral). Runs
 * `AIWG_VISION_COMMAND` (or the `--command` flag) with placeholders:
 *   {image}        "$1": absolute image path
 *   {prompt_file}  "$2": path to a file containing the prompt
 *   {out}          "$3": path the command must write the transcription to
 * Placeholders must be unquoted and unescaped. AIWG_VISION_IMAGE /
 * AIWG_VISION_PROMPT_FILE / AIWG_VISION_OUT are also exported.
 * Only $1/$2/$3 and the exported vision variables (also braced) may expand.
 * Other $ expansions, command substitution, backticks, eval, nested shells with -c, <<, and #
 * outside single quotes are rejected; use a wrapper script for complex logic.
 * e.g.  vision-cli --prompt-file {prompt_file} --image {image} > {out}
 */
function commandAdapter(template: string): VisionAdapter {
  const cmd = visionCommand(template);
  return {
    name: 'command',
    transcribe(imagePath, prompt, ctx) {
      const dir = path.dirname(imagePath);
      const promptFile = path.join(dir, `.vision-prompt-${ctx.page}.txt`);
      const out = path.join(dir, `.vision-out-${ctx.page}.txt`);
      fs.writeFileSync(promptFile, prompt);
      try {
        // Same caller-controlled-timeout clamp as the codex adapter above.
        const r = spawnSync('sh', ['-c', cmd, 'aiwg-vision', imagePath, promptFile, out], {
          timeout: positiveTimeoutMs(ctx.timeoutSec * 1000, 240_000), encoding: 'utf8',
          env: { ...process.env, AIWG_VISION_IMAGE: imagePath, AIWG_VISION_PROMPT_FILE: promptFile, AIWG_VISION_OUT: out },
          killSignal: 'SIGKILL',
        });
        let text: string | undefined;
        if (fs.existsSync(out)) text = fs.readFileSync(out, 'utf8');
        else if (r.status === 0 && r.stdout) text = r.stdout; // command wrote to stdout
        fs.rmSync(promptFile, { force: true });
        fs.rmSync(out, { force: true });
        return { ok: r.status === 0 && !!text, text };
      } catch {
        fs.rmSync(promptFile, { force: true });
        fs.rmSync(out, { force: true });
        return { ok: false };
      }
    },
  };
}

export interface AdapterOptions {
  provider?: string; // 'codex' | 'command'
  command?: string; // template for the command adapter
}

/** Resolve the vision adapter from options/env. Throws when misconfigured. */
export function resolveAdapter(opts: AdapterOptions = {}): VisionAdapter {
  const command = opts.command ?? process.env.AIWG_VISION_COMMAND;
  const provider = opts.provider ?? process.env.AIWG_VISION_PROVIDER ?? (command ? 'command' : 'codex');
  if (provider === 'command') {
    if (!command) throw new Error("vision provider 'command' requires --command or AIWG_VISION_COMMAND (template with unquoted, unescaped {image}/{prompt_file}/{out} placeholders)");
    return commandAdapter(command);
  }
  if (provider === 'codex') return codexAdapter;
  throw new Error(`unknown vision provider '${provider}' (codex | command)`);
}

// ── PDF → PNG rasterization (poppler pdftoppm) ───────────────────────────────

export function pdftoppmAvailable(): boolean {
  try {
    return boundedSpawnSync('pdftoppm', ['-v'], 'quick', { encoding: 'utf8' }).status === 0
      || boundedSpawnSync('pdftoppm', ['-h'], 'quick', { encoding: 'utf8' }).status !== null;
  } catch {
    return false;
  }
}

/**
 * Rasterize a PDF into zero-padded `page-NNN.png` files in `outDir` via
 * `pdftoppm`. Returns the page count. Throws if pdftoppm is unavailable.
 */
export function rasterizePdf(pdfPath: string, outDir: string, dpi = 200): number {
  if (!pdftoppmAvailable()) {
    throw new Error('PDF rasterization needs poppler `pdftoppm` on PATH (macOS: `brew install poppler`; Debian/Ubuntu: `apt install poppler-utils`).');
  }
  if (!fs.existsSync(pdfPath)) throw new Error(`PDF not found: ${pdfPath}`);
  fs.mkdirSync(outDir, { recursive: true });
  // pdftoppm writes <prefix>-<n>.png with its own zero-padding based on page count.
  const prefix = path.join(outDir, 'page');
  // Rasterizing a multi-page PDF can take a while; long tier (#3062).
  const r = boundedSpawnSync('pdftoppm', ['-png', '-r', String(dpi), pdfPath, prefix], 'long', { encoding: 'utf8' });
  if (r.status !== 0) {
    // #3062 finding 14: r.error.message (when present) carries the
    // enriched timeout explanation (tier/bound/override) that stderr/
    // status alone do not — put it first, captured stderr after.
    const detail = r.error ? r.error.message : `pdftoppm failed: ${r.stderr || r.status}`;
    throw new Error(r.error && r.stderr ? `${detail} (stderr: ${r.stderr})` : detail);
  }
  // Normalize names to page-NNN.png (3-digit zero-pad).
  let count = 0;
  for (const f of fs.readdirSync(outDir)) {
    const m = f.match(/^page-(\d+)\.png$/);
    if (!m) continue;
    count++;
    const padded = `page-${m[1].padStart(3, '0')}.png`;
    if (padded !== f) fs.renameSync(path.join(outDir, f), path.join(outDir, padded));
  }
  return count;
}

// ── Orchestration (resumable page loop + combine) ────────────────────────────

const COMPLETE_MARKER = '<!-- extraction-status: complete -->';

function pageNumber(file: string): number | null {
  const m = path.basename(file).match(/^page-0*(\d+)\.png$/);
  return m ? parseInt(m[1], 10) : null;
}
function isComplete(outFile: string): boolean {
  return fs.existsSync(outFile) && fs.readFileSync(outFile, 'utf8').startsWith(COMPLETE_MARKER);
}

export interface ExtractOptions {
  imageDir: string;
  outDir: string;
  adapter: VisionAdapter;
  title?: string;
  start?: number;
  end?: number;
  retries?: number;
  timeoutSec?: number;
  /** Cooldown seconds between pages / after a failure (default 0 — set for real-provider politeness). */
  sleepSec?: number;
  force?: boolean;
  model?: string;
  /** Injected sleeper (tests pass a no-op). */
  sleep?: (sec: number) => void;
}

export interface ExtractResult {
  processed: number;
  completed: number;
  failed: number;
  combinedMd: string;
  combinedTxt: string;
}

export async function extractPages(opts: ExtractOptions): Promise<ExtractResult> {
  if (!fs.existsSync(opts.imageDir)) throw new Error(`missing image directory: ${opts.imageDir}`);
  const pageDir = path.join(opts.outDir, 'pages');
  fs.mkdirSync(pageDir, { recursive: true });
  const log: string[] = [];
  const logLine = (s: string) => log.push(s);
  const sleep = opts.sleep ?? (() => {});
  const start = opts.start ?? 1;
  const end = opts.end ?? Number.MAX_SAFE_INTEGER;
  const retries = opts.retries ?? 0;
  const timeoutSec = opts.timeoutSec ?? 240;

  const images = fs
    .readdirSync(opts.imageDir)
    .filter((f) => /^page-\d+\.png$/.test(f))
    .map((f) => path.join(opts.imageDir, f))
    .sort();

  let processed = 0;
  let completed = 0;
  let failed = 0;

  for (const image of images) {
    const page = pageNumber(image);
    if (page == null || page < start || page > end) continue;
    processed++;
    const outFile = path.join(pageDir, `page-${String(page).padStart(3, '0')}.md`);
    if (!opts.force && isComplete(outFile)) {
      logLine(`skip page ${page}: already complete`);
      completed++;
      continue;
    }
    const prompt = buildPrompt(page, opts.title);
    let ok = false;
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      const res = opts.adapter.transcribe(image, prompt, { root: path.dirname(opts.imageDir), page, timeoutSec, model: opts.model });
      if (res.ok && res.text && new RegExp(`^# Page ${page}\\b`, 'm').test(res.text)) {
        fs.writeFileSync(outFile, `${COMPLETE_MARKER}\n<!-- source-image: ${image} -->\n\n${res.text.trimEnd()}\n`);
        logLine(`page ${page}: complete (attempt ${attempt})`);
        ok = true;
        completed++;
        break;
      }
      logLine(`page ${page}: unusable output (attempt ${attempt})`);
      if (attempt <= retries) sleep(opts.sleepSec ?? 0);
    }
    if (!ok) {
      fs.writeFileSync(outFile, `<!-- extraction-status: failed -->\n<!-- source-image: ${image} -->\n\n# Page ${page}\n\n[extraction failed]\n`);
      logLine(`page ${page}: failed after ${retries + 1} attempts`);
      failed++;
      sleep(opts.sleepSec ?? 0);
    }
    sleep(opts.sleepSec ?? 0);
  }

  // Combine.
  const slug = path.basename(opts.outDir);
  const head = [`# ${opts.title ?? slug}`, '', `Source: vision extraction (${opts.adapter.name}) from page PNGs`, `Pages processed: ${processed}`, ''];
  const parts: string[] = [];
  for (const f of fs.readdirSync(pageDir).filter((x) => /^page-\d+\.md$/.test(x)).sort()) {
    parts.push(fs.readFileSync(path.join(pageDir, f), 'utf8'), '\n---\n\n');
  }
  const combinedMd = head.join('\n') + parts.join('');
  const combinedTxt = combinedMd.split('\n').filter((l) => !/^<!--.*-->$/.test(l.trim())).join('\n');
  fs.writeFileSync(path.join(opts.outDir, `${slug}.vision.md`), combinedMd);
  fs.writeFileSync(path.join(opts.outDir, `${slug}.vision.txt`), combinedTxt);
  fs.writeFileSync(path.join(opts.outDir, 'run.log'), log.join('\n') + '\n');

  return { processed, completed, failed, combinedMd, combinedTxt };
}

export function renderExtract(r: ExtractResult): string {
  return `vision-extract: processed ${r.processed}, completed ${r.completed}, failed ${r.failed}\n`;
}
