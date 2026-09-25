import { format } from 'node:util';
import type { QualificationPrivacyCapture } from './privacy.js';

export interface QualificationLifetimeCapture<T> {
  /** Present when the operation resolved. */
  result?: T;
  /** True when the operation threw; the error itself is not returned, only its captured text. */
  threw: boolean;
  /** stdout, stderr and thrown-error observations for the whole operation, including empty ones. */
  captures: QualificationPrivacyCapture[];
}

type Writer = typeof process.stdout.write;
const CONSOLE_METHODS = ['log', 'info', 'debug', 'warn', 'error', 'trace'] as const;
const STDERR_METHODS = new Set<string>(['warn', 'error', 'trace']);

function errorText(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause === undefined ? '' : `\ncause: ${errorText(error.cause)}`;
    return `${error.name}: ${error.message}\n${error.stack ?? ''}${cause}`;
  }
  try { return JSON.stringify(error) ?? String(error); } catch { return String(error); }
}

/**
 * Captures what the process emits while `operation` runs: stream writes to
 * stdout/stderr, console output (which test runners may route around the
 * streams), and the text of a thrown error. Output still reaches the original
 * sinks. Captures are process-wide, so concurrent work in the same process is
 * captured too; run the qualification alone. Writes from child processes are
 * not captured and must be collected by the caller.
 */
export async function captureQualificationLifetime<T>(operation: () => Promise<T>): Promise<QualificationLifetimeCapture<T>> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  const originalConsole = Object.fromEntries(CONSOLE_METHODS.map(name => [name, console[name]])) as Record<string, (...args: unknown[]) => void>;
  const tap = (sink: string[], original: Writer): Writer => function (this: unknown, chunk: unknown, ...rest: unknown[]) {
    sink.push(typeof chunk === 'string' ? chunk : chunk instanceof Uint8Array ? new TextDecoder().decode(chunk) : String(chunk));
    return (original as (...args: unknown[]) => boolean).call(this, chunk, ...rest);
  } as Writer;
  process.stdout.write = tap(stdout, originalStdout);
  process.stderr.write = tap(stderr, originalStderr);
  for (const name of CONSOLE_METHODS) {
    console[name] = (...args: unknown[]) => {
      (STDERR_METHODS.has(name) ? stderr : stdout).push(`${format(...args)}\n`);
      originalConsole[name]!.apply(console, args);
    };
  }
  let result: T | undefined;
  let thrown = '';
  let threw = false;
  try {
    result = await operation();
  } catch (error) {
    threw = true;
    thrown = errorText(error);
  } finally {
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    for (const name of CONSOLE_METHODS) console[name] = originalConsole[name] as never;
  }
  return {
    ...(threw ? {} : { result }), threw,
    captures: [
      { surface: 'stdout', content: stdout.join('') },
      { surface: 'stderr', content: stderr.join('') },
      { surface: 'thrown-error', content: thrown },
    ],
  };
}
