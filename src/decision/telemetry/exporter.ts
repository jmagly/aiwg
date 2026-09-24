import { sanitizedTelemetryExport } from './redaction.js';
import type { DecisionTelemetryTrace } from './types.js';

export interface DecisionTraceSink { export(trace: DecisionTelemetryTrace, signal: AbortSignal): Promise<void> }
export interface ExporterDiagnostic { type: 'dropped' | 'failed' | 'timeout'; atUnixMs: number; detail: string }

export class BoundedDecisionTraceExporter {
  private readonly queue: DecisionTelemetryTrace[] = [];
  private draining: Promise<void> | null = null;
  private stopped = false;
  readonly diagnostics: ExporterDiagnostic[] = [];

  constructor(
    private readonly sink: DecisionTraceSink,
    private readonly options: { capacity: number; timeoutMs: number; maximumDiagnostics?: number; maximumTraceBytes?: number; canaries?: readonly string[] },
  ) {
    if (!Number.isSafeInteger(options.capacity) || options.capacity < 1 || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1
      || !Number.isSafeInteger(options.maximumTraceBytes ?? 65_536) || (options.maximumTraceBytes ?? 65_536) < 1
      || !Number.isSafeInteger(options.maximumDiagnostics ?? 100) || (options.maximumDiagnostics ?? 100) < 1) {
      throw new Error('Invalid exporter bounds');
    }
  }

  /** Never awaits the sink and never changes a decision result. */
  offer(trace: DecisionTelemetryTrace): boolean {
    if (this.stopped || this.queue.length >= this.options.capacity) {
      this.record('dropped', this.stopped ? 'exporter stopped' : 'queue capacity reached');
      return false;
    }
    try {
      const sanitized = sanitizedTelemetryExport(trace, { canaries: this.options.canaries });
      const encoded = JSON.stringify(sanitized);
      if (Buffer.byteLength(encoded, 'utf8') > (this.options.maximumTraceBytes ?? 65_536)) {
        this.record('dropped', 'trace exceeds configured byte bound');
        return false;
      }
      this.queue.push(sanitized);
      this.drain();
      return true;
    } catch {
      this.record('dropped', 'invalid telemetry trace');
      return false;
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await (this.drain() ?? this.draining);
  }

  private record(type: ExporterDiagnostic['type'], detail: string): void {
    const containsCanary = this.options.canaries?.some(canary => canary && detail.toLowerCase().includes(canary.toLowerCase()));
    this.diagnostics.push({ type, atUnixMs: Date.now(), detail: containsCanary ? 'redacted exporter diagnostic' : detail.slice(0, 256) });
    const maximum = this.options.maximumDiagnostics ?? 100;
    if (this.diagnostics.length > maximum) this.diagnostics.splice(0, this.diagnostics.length - maximum);
  }

  private drain(): Promise<void> | null {
    if (this.draining) return null;
    this.draining = (async () => {
      while (this.queue.length > 0) {
        const trace = this.queue.shift()!;
        const controller = new AbortController();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const deadline = new Promise<never>((_, reject) => {
          timeout = setTimeout(() => { controller.abort(); reject(new Error('telemetry export timed out')); }, this.options.timeoutMs);
        });
        try { await Promise.race([this.sink.export(trace, controller.signal), deadline]); }
        catch (error) { this.record(controller.signal.aborted ? 'timeout' : 'failed', error instanceof Error ? error.message : 'export failed'); }
        finally { if (timeout) clearTimeout(timeout); }
      }
    })().finally(() => { this.draining = null; });
    return this.draining;
  }
}
